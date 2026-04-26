//! Candidate evaluation — checks divergence and decides whether to auto-apply.

use std::path::Path;
use std::process::Stdio;

use bakudo_core::abox::sandbox_branch;
use bakudo_core::error::BakudoError;
use tokio::process::Command;

/// Summary of the divergence between a worktree and its base branch.
#[derive(Debug, Clone)]
pub struct DivergenceSummary {
    pub raw_output: String,
    pub has_changes: bool,
}

/// Query divergence for a task's worktree.
pub async fn query_divergence(
    task_id: &str,
    base_branch: &str,
    repo: Option<&Path>,
) -> Result<DivergenceSummary, BakudoError> {
    let repo = repo.unwrap_or_else(|| Path::new("."));
    let branch = sandbox_branch(task_id);
    ensure_branch_exists(repo, &branch).await?;
    let raw = git_output(
        repo,
        &[
            "diff",
            "--no-ext-diff",
            "--name-status",
            &format!("{base_branch}...{branch}"),
        ],
    )
    .await?;
    let has_changes =
        !raw.trim().is_empty() && !raw.contains("up to date") && !raw.contains("0 commits");
    Ok(DivergenceSummary {
        raw_output: raw,
        has_changes,
    })
}

/// Return a unified diff for one sandbox branch against the configured base.
pub async fn query_diff(
    task_id: &str,
    base_branch: &str,
    repo: Option<&Path>,
) -> Result<String, BakudoError> {
    let repo = repo.unwrap_or_else(|| Path::new("."));
    let branch = sandbox_branch(task_id);
    ensure_branch_exists(repo, &branch).await?;
    git_output(
        repo,
        &[
            "diff",
            "--no-ext-diff",
            "--find-renames",
            "--unified=3",
            &format!("{base_branch}...{branch}"),
        ],
    )
    .await
}

async fn ensure_branch_exists(repo: &Path, branch: &str) -> Result<(), BakudoError> {
    let status = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(repo)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("sandbox branch '{branch}' not found"),
        )
        .into())
    }
}

async fn git_output(repo: &Path, args: &[&str]) -> Result<String, BakudoError> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .await?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(std::io::Error::other(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
        .into())
    }
}
