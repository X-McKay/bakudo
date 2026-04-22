//! Host-owned worktree lifecycle management.
//!
//! After an agent finishes, the host decides what to do with the preserved
//! worktree. The three lifecycle actions are:
//!
//! - `apply`   — merge the worktree into the base branch (abox merge)
//! - `discard` — delete the worktree (abox stop --clean)
//! - `review`  — leave the worktree preserved (no-op, user inspects manually)
//!
//! The agent inside the sandbox never merges its own work. All merge/discard
//! decisions are made here, on the host side.

use std::path::Path;
use std::sync::Arc;

use tracing::{info, warn};

use bakudo_core::abox::{AboxAdapter, SandboxEntry};
use bakudo_core::error::BakudoError;
use bakudo_core::protocol::CandidatePolicy;
use bakudo_core::state::{SandboxLedger, SandboxState};

/// Result of a worktree lifecycle action.
#[derive(Debug)]
pub enum WorktreeAction {
    Merged,
    MergeConflicts(Vec<String>),
    Discarded,
    Preserved,
}

/// Apply the candidate policy for a finished task.
pub async fn apply_candidate_policy(
    task_id: &str,
    policy: &CandidatePolicy,
    base_branch: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
    ledger: &Arc<SandboxLedger>,
) -> Result<WorktreeAction, BakudoError> {
    match policy {
        CandidatePolicy::AutoApply => merge_sandbox(task_id, base_branch, repo, abox, ledger).await,
        CandidatePolicy::Discard => discard_sandbox(task_id, repo, abox, ledger).await,
        CandidatePolicy::Review => {
            info!("Leaving worktree preserved for task {task_id} (review mode)");
            // Best-effort: populate branch info from abox list so the shelf
            // can surface it.
            if let Ok(entries) = abox.list(repo).await {
                if let Some(entry) = find_entry(&entries, task_id) {
                    ledger
                        .set_worktree(task_id, String::new(), entry.branch.clone())
                        .await;
                }
            }
            Ok(WorktreeAction::Preserved)
        }
    }
}

/// Merge a preserved worktree into `base_branch`.
pub async fn merge_sandbox(
    task_id: &str,
    base_branch: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
    ledger: &Arc<SandboxLedger>,
) -> Result<WorktreeAction, BakudoError> {
    info!("Auto-applying worktree for task {task_id}");
    let conflicts = abox.merge(repo, task_id, base_branch).await?;
    if conflicts.is_empty() {
        ledger.update_state(task_id, SandboxState::Merged).await;
        Ok(WorktreeAction::Merged)
    } else {
        warn!("Merge conflicts for task {task_id}: {:?}", conflicts);
        ledger
            .update_state(task_id, SandboxState::MergeConflicts)
            .await;
        Ok(WorktreeAction::MergeConflicts(conflicts))
    }
}

/// Discard a preserved (or preserving) sandbox via `abox stop --clean`.
pub async fn discard_sandbox(
    task_id: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
    ledger: &Arc<SandboxLedger>,
) -> Result<WorktreeAction, BakudoError> {
    info!("Discarding worktree for task {task_id}");
    abox.stop(repo, task_id, true).await?;
    ledger.update_state(task_id, SandboxState::Discarded).await;
    Ok(WorktreeAction::Discarded)
}

/// Manually apply (merge) a preserved worktree.
pub async fn manual_apply(
    task_id: &str,
    base_branch: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
    ledger: &Arc<SandboxLedger>,
) -> Result<WorktreeAction, BakudoError> {
    merge_sandbox(task_id, base_branch, repo, abox, ledger).await
}

/// Manually discard a preserved worktree.
pub async fn manual_discard(
    task_id: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
    ledger: &Arc<SandboxLedger>,
) -> Result<WorktreeAction, BakudoError> {
    discard_sandbox(task_id, repo, abox, ledger).await
}

fn find_entry<'a>(entries: &'a [SandboxEntry], task_id: &str) -> Option<&'a SandboxEntry> {
    entries.iter().find(|e| e.id == task_id)
}
