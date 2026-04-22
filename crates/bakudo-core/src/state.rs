//! Concurrency-safe in-memory state ledger for active sandboxes.
//!
//! The `SandboxLedger` is the single source of truth for which sandboxes are
//! currently running. It is backed by a `tokio::sync::RwLock` so multiple
//! readers can observe state while a single writer updates it.
//!
//! Crash recovery: on startup, `SandboxLedger::reconcile` calls `abox list`
//! and removes any entries whose VM is no longer running. This replaces the
//! fragile PID-file approach from v1.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::abox::SandboxEntry;
use crate::protocol::{AttemptId, CandidatePolicy, SandboxLifecycle, SessionId};

/// The lifecycle state of a single sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxState {
    /// The VM is booting.
    Starting,
    /// The agent is running inside the VM.
    Running,
    /// The VM exited cleanly; the worktree is preserved awaiting host decision.
    Preserved,
    /// The worktree has been merged into the base branch.
    Merged,
    /// The worktree has been discarded (abox stop --clean).
    Discarded,
    /// The VM exited with an error.
    Failed { exit_code: i32 },
    /// The run timed out.
    TimedOut,
    /// The merge had conflicts; the worktree is preserved for manual resolution.
    MergeConflicts,
}

/// A single entry in the sandbox ledger.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxRecord {
    pub attempt_id: AttemptId,
    pub session_id: SessionId,
    pub task_id: String,
    pub provider_id: String,
    pub model: String,
    pub prompt_summary: String,
    pub state: SandboxState,
    pub lifecycle: SandboxLifecycle,
    pub candidate_policy: CandidatePolicy,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Path to the preserved worktree on the host, if any.
    pub worktree_path: Option<String>,
    /// Branch name (e.g. "agent/bakudo-attempt-abc").
    pub branch: Option<String>,
}

impl SandboxRecord {
    pub fn is_active(&self) -> bool {
        matches!(self.state, SandboxState::Starting | SandboxState::Running)
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            SandboxState::Merged
                | SandboxState::Discarded
                | SandboxState::Failed { .. }
                | SandboxState::TimedOut
                | SandboxState::MergeConflicts
        )
    }
}

/// The concurrency-safe sandbox ledger.
#[derive(Debug, Clone)]
pub struct SandboxLedger {
    inner: Arc<RwLock<HashMap<String, SandboxRecord>>>,
}

impl SandboxLedger {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Insert a new sandbox record. Keyed by `task_id`.
    pub async fn insert(&self, record: SandboxRecord) {
        let mut map = self.inner.write().await;
        map.insert(record.task_id.clone(), record);
    }

    /// Update the state of an existing sandbox.
    pub async fn update_state(&self, task_id: &str, state: SandboxState) {
        let mut map = self.inner.write().await;
        if let Some(record) = map.get_mut(task_id) {
            record.state = state;
            if record.finished_at.is_none()
                && matches!(
                    record.state,
                    SandboxState::Preserved
                        | SandboxState::Merged
                        | SandboxState::Discarded
                        | SandboxState::Failed { .. }
                        | SandboxState::TimedOut
                )
            {
                record.finished_at = Some(Utc::now());
            }
        }
    }

    /// Set the worktree path and branch for a preserved sandbox.
    pub async fn set_worktree(&self, task_id: &str, path: String, branch: String) {
        let mut map = self.inner.write().await;
        if let Some(record) = map.get_mut(task_id) {
            record.worktree_path = Some(path);
            record.branch = Some(branch);
        }
    }

    /// Get a snapshot of a single record.
    pub async fn get(&self, task_id: &str) -> Option<SandboxRecord> {
        let map = self.inner.read().await;
        map.get(task_id).cloned()
    }

    /// Get a snapshot of all records.
    pub async fn all(&self) -> Vec<SandboxRecord> {
        let map = self.inner.read().await;
        map.values().cloned().collect()
    }

    /// Get all active (running or starting) sandboxes.
    pub async fn active(&self) -> Vec<SandboxRecord> {
        let map = self.inner.read().await;
        map.values().filter(|r| r.is_active()).cloned().collect()
    }

    /// Reconcile the ledger against `abox list` output.
    /// Any sandbox in the ledger that is marked Running but is not present in
    /// `abox list` (or has vm_state != "running") is transitioned to Failed.
    pub async fn reconcile(&self, abox_entries: &[SandboxEntry]) {
        let running_ids: std::collections::HashSet<&str> = abox_entries
            .iter()
            .filter(|e| e.vm_state == "running")
            .map(|e| e.id.as_str())
            .collect();

        let mut map = self.inner.write().await;
        for record in map.values_mut() {
            if record.state == SandboxState::Running && !running_ids.contains(record.task_id.as_str()) {
                record.state = SandboxState::Failed { exit_code: -1 };
                record.finished_at = Some(Utc::now());
            }
        }
    }
}

impl Default for SandboxLedger {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AttemptId, SessionId};

    fn make_record(task_id: &str, state: SandboxState) -> SandboxRecord {
        SandboxRecord {
            attempt_id: AttemptId(format!("attempt-{task_id}")),
            session_id: SessionId("session-test".to_string()),
            task_id: task_id.to_string(),
            provider_id: "claude".to_string(),
            model: String::new(),
            prompt_summary: "test".to_string(),
            state,
            lifecycle: SandboxLifecycle::Preserved,
            candidate_policy: CandidatePolicy::Review,
            started_at: Utc::now(),
            finished_at: None,
            worktree_path: None,
            branch: None,
        }
    }

    #[tokio::test]
    async fn insert_and_get() {
        let ledger = SandboxLedger::new();
        ledger.insert(make_record("task-1", SandboxState::Running)).await;
        let r = ledger.get("task-1").await.unwrap();
        assert_eq!(r.task_id, "task-1");
        assert_eq!(r.state, SandboxState::Running);
    }

    #[tokio::test]
    async fn reconcile_marks_missing_as_failed() {
        let ledger = SandboxLedger::new();
        ledger.insert(make_record("task-running", SandboxState::Running)).await;
        ledger.insert(make_record("task-ghost", SandboxState::Running)).await;

        let abox_entries = vec![SandboxEntry {
            id: "task-running".to_string(),
            branch: "agent/task-running".to_string(),
            vm_state: "running".to_string(),
            vm_pid: "1234".to_string(),
            commits_ahead: "0".to_string(),
        }];

        ledger.reconcile(&abox_entries).await;

        let ghost = ledger.get("task-ghost").await.unwrap();
        assert!(matches!(ghost.state, SandboxState::Failed { .. }));

        let still_running = ledger.get("task-running").await.unwrap();
        assert_eq!(still_running.state, SandboxState::Running);
    }
}
