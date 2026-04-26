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

use tokio::process::Command;
use tracing::{info, warn};

use bakudo_core::abox::{sandbox_branch, sandbox_default_worktree_path, AboxAdapter, SandboxEntry};
use bakudo_core::error::BakudoError;
use bakudo_core::protocol::CandidatePolicy;
use bakudo_core::state::{SandboxLedger, SandboxState};

const SNAPSHOT_MAX_TOTAL_BYTES: u64 = 1_048_576;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SnapshotIntent {
    Preserve,
    Apply,
}

#[derive(Debug, Default)]
struct PendingSnapshotStats {
    changed_paths: usize,
    total_bytes: u64,
}

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
            prepare_preserved_worktree(task_id, ledger, SnapshotIntent::Preserve).await?;
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
    prepare_preserved_worktree(task_id, ledger, SnapshotIntent::Apply).await?;
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

async fn prepare_preserved_worktree(
    task_id: &str,
    ledger: &Arc<SandboxLedger>,
    intent: SnapshotIntent,
) -> Result<(), BakudoError> {
    let branch = sandbox_branch(task_id);
    let Some(worktree_path) = discover_worktree_path(task_id, ledger).await else {
        return Ok(());
    };
    ledger
        .set_worktree(task_id, worktree_path.display().to_string(), branch)
        .await;
    let stats = pending_snapshot_stats(&worktree_path).await?;
    if stats.changed_paths == 0 {
        return Ok(());
    }
    if stats.total_bytes > SNAPSHOT_MAX_TOTAL_BYTES {
        let reason = format!(
            "preserved worktree for task {task_id} totals {} bytes across {} changed path(s), above the {}-byte auto-snapshot limit; review it manually",
            stats.total_bytes,
            stats.changed_paths,
            SNAPSHOT_MAX_TOTAL_BYTES,
        );
        match intent {
            SnapshotIntent::Preserve => {
                warn!("{reason}");
                return Ok(());
            }
            SnapshotIntent::Apply => {
                return Err(std::io::Error::other(reason).into());
            }
        }
    }

    info!("Snapshotting dirty preserved worktree for task {task_id}");
    run_git(&worktree_path, &["add", "-A"]).await?;
    run_git(
        &worktree_path,
        &[
            "-c",
            "user.name=Bakudo",
            "-c",
            "user.email=bakudo@local",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "bakudo: snapshot preserved worktree",
        ],
    )
    .await?;
    Ok(())
}

async fn discover_worktree_path(
    task_id: &str,
    ledger: &Arc<SandboxLedger>,
) -> Option<std::path::PathBuf> {
    let recorded = ledger
        .get(task_id)
        .await
        .and_then(|record| record.worktree_path)
        .filter(|path| !path.trim().is_empty())
        .map(std::path::PathBuf::from)
        .filter(|path| path.exists());
    if recorded.is_some() {
        return recorded;
    }

    sandbox_default_worktree_path(task_id)
}

async fn pending_snapshot_stats(worktree_path: &Path) -> Result<PendingSnapshotStats, BakudoError> {
    let pending_paths = git_output(
        worktree_path,
        &["status", "--porcelain", "--untracked-files=all"],
    )
    .await?;
    let mut stats = PendingSnapshotStats::default();
    for raw_line in pending_paths.lines() {
        let line = raw_line.trim_end();
        if line.len() < 4 {
            continue;
        }
        let path = line[3..]
            .rsplit_once(" -> ")
            .map(|(_, path)| path)
            .unwrap_or(&line[3..])
            .trim()
            .trim_matches('"');
        if path.is_empty() {
            continue;
        }
        stats.changed_paths += 1;
        let candidate = worktree_path.join(path);
        if let Ok(metadata) = tokio::fs::symlink_metadata(&candidate).await {
            if metadata.is_file() || metadata.file_type().is_symlink() {
                stats.total_bytes = stats.total_bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(stats)
}

async fn git_output(worktree_path: &Path, args: &[&str]) -> Result<String, BakudoError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .await?;
    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "git {:?} failed in '{}': {}",
            args,
            worktree_path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
        .into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn run_git(worktree_path: &Path, args: &[&str]) -> Result<(), BakudoError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .await?;
    if output.status.success() {
        return Ok(());
    }
    Err(std::io::Error::other(format!(
        "git {:?} failed in '{}': {}",
        args,
        worktree_path.display(),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
    .into())
}
