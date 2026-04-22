//! Candidate evaluation — checks divergence and decides whether to auto-apply.

use std::path::Path;

use bakudo_core::abox::AboxAdapter;
use bakudo_core::error::BakudoError;

/// Summary of the divergence between a worktree and its base branch.
#[derive(Debug, Clone)]
pub struct DivergenceSummary {
    pub task_id: String,
    pub base_branch: String,
    pub raw_output: String,
    pub has_changes: bool,
}

/// Query divergence for a task's worktree.
pub async fn query_divergence(
    task_id: &str,
    base_branch: &str,
    repo: Option<&Path>,
    abox: &AboxAdapter,
) -> Result<DivergenceSummary, BakudoError> {
    let raw = abox.divergence(repo, base_branch).await?;
    let has_changes = !raw.trim().is_empty()
        && !raw.contains("up to date")
        && !raw.contains("0 commits");
    Ok(DivergenceSummary {
        task_id: task_id.to_string(),
        base_branch: base_branch.to_string(),
        raw_output: raw,
        has_changes,
    })
}
