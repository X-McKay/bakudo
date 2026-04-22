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
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::warn;

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
    #[serde(default)]
    pub model: Option<String>,
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
}

/// The concurrency-safe sandbox ledger.
#[derive(Debug, Clone)]
pub struct SandboxLedger {
    inner: Arc<RwLock<HashMap<String, SandboxRecord>>>,
    persist_path: Option<PathBuf>,
}

impl SandboxLedger {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            persist_path: None,
        }
    }

    /// Create a ledger that persists to the given path. Existing records on
    /// disk are loaded synchronously on construction. Writes are flushed
    /// best-effort after every mutation.
    pub fn with_persistence(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let records = load_records(&path).unwrap_or_default();
        let map: HashMap<String, SandboxRecord> = records
            .into_iter()
            .map(|r| (r.task_id.clone(), r))
            .collect();
        Self {
            inner: Arc::new(RwLock::new(map)),
            persist_path: Some(path),
        }
    }

    /// Insert a new sandbox record. Keyed by `task_id`.
    pub async fn insert(&self, record: SandboxRecord) {
        {
            let mut map = self.inner.write().await;
            map.insert(record.task_id.clone(), record);
        }
        self.flush().await;
    }

    /// Update the state of an existing sandbox.
    pub async fn update_state(&self, task_id: &str, state: SandboxState) {
        {
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
                            | SandboxState::MergeConflicts
                    )
                {
                    record.finished_at = Some(Utc::now());
                }
            }
        }
        self.flush().await;
    }

    /// Set the worktree path and branch for a preserved sandbox.
    pub async fn set_worktree(&self, task_id: &str, path: String, branch: String) {
        {
            let mut map = self.inner.write().await;
            if let Some(record) = map.get_mut(task_id) {
                record.worktree_path = Some(path);
                record.branch = Some(branch);
            }
        }
        self.flush().await;
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
    ///
    /// For each entry in `abox_entries` not known to the ledger, insert a
    /// placeholder record derived from its `vm_state`. For each ledger record
    /// marked `Running` that is no longer present (or no longer running) in
    /// abox output, transition it to `Failed`.
    pub async fn reconcile(&self, abox_entries: &[SandboxEntry]) {
        let running_ids: std::collections::HashSet<&str> = abox_entries
            .iter()
            .filter(|e| e.vm_state == "running")
            .map(|e| e.id.as_str())
            .collect();

        {
            let mut map = self.inner.write().await;

            // Mark ghost runners as failed.
            for record in map.values_mut() {
                if record.state == SandboxState::Running
                    && !running_ids.contains(record.task_id.as_str())
                {
                    record.state = SandboxState::Failed { exit_code: -1 };
                    record.finished_at = Some(Utc::now());
                }
            }

            // Ingest unknown abox entries.
            for entry in abox_entries {
                if !map.contains_key(&entry.id) {
                    let state = match entry.vm_state.as_str() {
                        "running" => SandboxState::Running,
                        "stopped" => SandboxState::Preserved,
                        _ => SandboxState::Preserved,
                    };
                    let now = Utc::now();
                    map.insert(
                        entry.id.clone(),
                        SandboxRecord {
                            attempt_id: AttemptId(format!("recovered-{}", entry.id)),
                            session_id: SessionId("session-recovered".to_string()),
                            task_id: entry.id.clone(),
                            provider_id: "unknown".to_string(),
                            model: None,
                            prompt_summary: String::from("(recovered from abox list)"),
                            state: state.clone(),
                            lifecycle: SandboxLifecycle::Preserved,
                            candidate_policy: CandidatePolicy::Review,
                            started_at: now,
                            finished_at: if matches!(state, SandboxState::Running) {
                                None
                            } else {
                                Some(now)
                            },
                            worktree_path: None,
                            branch: Some(entry.branch.clone()),
                        },
                    );
                }
            }
        }
        self.flush().await;
    }

    async fn flush(&self) {
        let Some(path) = self.persist_path.clone() else {
            return;
        };
        let records: Vec<SandboxRecord> = {
            let map = self.inner.read().await;
            map.values().cloned().collect()
        };
        tokio::task::spawn_blocking(move || {
            if let Err(e) = write_records(&path, &records) {
                warn!(
                    "failed to persist sandbox ledger to {}: {e}",
                    path.display()
                );
            }
        });
    }
}

fn load_records(path: &Path) -> std::io::Result<Vec<SandboxRecord>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<SandboxRecord>(line) {
            Ok(r) => out.push(r),
            Err(e) => warn!("skipping malformed ledger line: {e}"),
        }
    }
    Ok(out)
}

fn write_records(path: &Path, records: &[SandboxRecord]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    let mut buf = String::new();
    for record in records {
        buf.push_str(&serde_json::to_string(record).map_err(std::io::Error::other)?);
        buf.push('\n');
    }
    std::fs::write(&tmp, buf)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
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
            model: None,
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
        ledger
            .insert(make_record("task-1", SandboxState::Running))
            .await;
        let r = ledger.get("task-1").await.unwrap();
        assert_eq!(r.task_id, "task-1");
        assert_eq!(r.state, SandboxState::Running);
    }

    #[tokio::test]
    async fn reconcile_marks_missing_as_failed() {
        let ledger = SandboxLedger::new();
        ledger
            .insert(make_record("task-running", SandboxState::Running))
            .await;
        ledger
            .insert(make_record("task-ghost", SandboxState::Running))
            .await;

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

    #[tokio::test]
    async fn reconcile_ingests_unknown_abox_entries() {
        let ledger = SandboxLedger::new();
        let entries = vec![
            SandboxEntry {
                id: "bakudo-orphan-run".to_string(),
                branch: "agent/bakudo-orphan-run".to_string(),
                vm_state: "running".to_string(),
                vm_pid: "111".to_string(),
                commits_ahead: "0".to_string(),
            },
            SandboxEntry {
                id: "bakudo-orphan-stop".to_string(),
                branch: "agent/bakudo-orphan-stop".to_string(),
                vm_state: "stopped".to_string(),
                vm_pid: "0".to_string(),
                commits_ahead: "2".to_string(),
            },
        ];

        ledger.reconcile(&entries).await;

        let running = ledger.get("bakudo-orphan-run").await.unwrap();
        assert_eq!(running.state, SandboxState::Running);
        assert_eq!(running.branch.as_deref(), Some("agent/bakudo-orphan-run"));

        let preserved = ledger.get("bakudo-orphan-stop").await.unwrap();
        assert_eq!(preserved.state, SandboxState::Preserved);
    }

    #[tokio::test]
    async fn persisted_ledger_roundtrips_records() {
        let path =
            std::env::temp_dir().join(format!("bakudo-ledger-{}.jsonl", uuid::Uuid::new_v4()));
        {
            let ledger = SandboxLedger::with_persistence(&path);
            ledger
                .insert(make_record("task-persist", SandboxState::Preserved))
                .await;
            // Give the spawn_blocking flush a moment to land.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let reopened = SandboxLedger::with_persistence(&path);
        let all = reopened.all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].task_id, "task-persist");
        let _ = std::fs::remove_file(path);
    }
}
