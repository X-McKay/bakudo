//! Host-owned worktree lifecycle management.
//!
//! After an agent finishes, the host decides what to do with the preserved
//! worktree. This module implements the three lifecycle actions:
//!
//! - `apply`   — merge the worktree into the base branch (abox merge)
//! - `discard` — delete the worktree (abox stop --clean)
//! - `review`  — leave the worktree preserved (no-op, user inspects manually)
//!
//! The host NEVER lets the agent merge its own changes. All merge/discard
//! decisions are made here, on the host side.

use std::path::Path;
use std::sync::Arc;

use tracing::{info, warn};

use bakudo_core::abox::AboxAdapter;
use bakudo_core::error::BakudoError;
use bakudo_core::protocol::CandidatePolicy;
use bakudo_core::state::{SandboxLedger, SandboxState};

/// Result of a worktree lifecycle action.
#[derive(Debug)]
pub enum WorktreeAction {
    /// The worktree was merged cleanly.
    Merged,
    /// The merge had conflicts; the worktree is preserved for manual resolution.
    MergeConflicts(Vec<String>),
    /// The worktree was discarded.
    Discarded,
    /// The worktree was left preserved (review mode).
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
        CandidatePolicy::AutoApply => {
            info!("Auto-applying worktree for task {task_id}");
            let conflicts = abox.merge(repo, task_id, base_branch).await?;
            if conflicts.is_empty() {
                ledger.update_state(task_id, SandboxState::Merged).await;
                Ok(WorktreeAction::Merged)
            } else {
                warn!("Merge conflicts for task {task_id}: {:?}", conflicts);
                // Mark the ledger so the shelf shows the conflict state.
                ledger
                    .update_state(task_id, SandboxState::MergeConflicts)
                    .await;
                Ok(WorktreeAction::MergeConflicts(conflicts))
            }
        }
        CandidatePolicy::Discard => {
            info!("Discarding worktree for task {task_id}");
            abox.stop(repo, task_id, true).await?;
            ledger.update_state(task_id, SandboxState::Discarded).await;
            Ok(WorktreeAction::Discarded)
        }
        CandidatePolicy::Review => {
            info!("Leaving worktree preserved for task {task_id} (review mode)");
            Ok(WorktreeAction::Preserved)
        }
    }
}

/// Manually apply (merge) a preserved worktree.
pub async fn manual_apply(
    task_id: &str,
    base_branch: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
    ledger: &Arc<SandboxLedger>,
) -> Result<WorktreeAction, BakudoError> {
    apply_candidate_policy(
        task_id,
        &CandidatePolicy::AutoApply,
        base_branch,
        repo,
        abox,
        ledger,
    )
    .await
}

/// Manually discard a preserved worktree.
pub async fn manual_discard(
    task_id: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
    ledger: &Arc<SandboxLedger>,
) -> Result<WorktreeAction, BakudoError> {
    apply_candidate_policy(task_id, &CandidatePolicy::Discard, "", repo, abox, ledger).await
}
