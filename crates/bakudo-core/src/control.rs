use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use uuid::Uuid;

use crate::hook::HookWorktreeAction;
use crate::mission::normalize_artifact_path;
use crate::protocol::{CandidatePolicy, SandboxLifecycle, WorkerStatus};
use crate::state::SandboxState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationSummary {
    pub command: String,
    pub status: VerificationStatus,
    pub exit_code: i32,
    pub timed_out: bool,
    #[serde(default)]
    pub stdout_tail: String,
    #[serde(default)]
    pub stderr_tail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub task_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub provider_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub repo_root: Option<String>,
    pub worker_status: WorkerStatus,
    pub final_state: SandboxState,
    pub worktree_action: HookWorktreeAction,
    #[serde(default)]
    pub merge_conflicts: Vec<String>,
    pub candidate_policy: CandidatePolicy,
    pub sandbox_lifecycle: SandboxLifecycle,
    pub summary: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<VerificationSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RunSummary {
    #[allow(clippy::too_many_arguments)]
    pub fn infra_error(
        task_id: String,
        attempt_id: String,
        session_id: String,
        provider_id: String,
        model: Option<String>,
        repo_root: Option<String>,
        candidate_policy: CandidatePolicy,
        sandbox_lifecycle: SandboxLifecycle,
        error: String,
    ) -> Self {
        let summary = error.chars().take(200).collect();
        Self {
            task_id,
            attempt_id,
            session_id,
            provider_id,
            model,
            repo_root,
            worker_status: WorkerStatus::Failed,
            final_state: SandboxState::Failed { exit_code: -1 },
            worktree_action: HookWorktreeAction::NotApplied,
            merge_conflicts: Vec::new(),
            candidate_policy,
            sandbox_lifecycle,
            summary,
            exit_code: -1,
            duration_ms: 0,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            verification: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwarmTaskStatus {
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
    Blocked,
    InfraError,
}

impl SwarmTaskStatus {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Succeeded)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmTaskSummary {
    pub id: String,
    #[serde(default)]
    pub parent_task_id: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub artifact_path: Option<String>,
    pub status: SwarmTaskStatus,
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub run: Option<RunSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SwarmRunTotals {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub timed_out: usize,
    pub cancelled: usize,
    pub blocked: usize,
    pub infra_error: usize,
}

impl SwarmRunTotals {
    pub fn from_tasks(tasks: &[SwarmTaskSummary]) -> Self {
        let mut totals = Self {
            total: tasks.len(),
            ..Self::default()
        };
        for task in tasks {
            match task.status {
                SwarmTaskStatus::Succeeded => totals.succeeded += 1,
                SwarmTaskStatus::Failed => totals.failed += 1,
                SwarmTaskStatus::TimedOut => totals.timed_out += 1,
                SwarmTaskStatus::Cancelled => totals.cancelled += 1,
                SwarmTaskStatus::Blocked => totals.blocked += 1,
                SwarmTaskStatus::InfraError => totals.infra_error += 1,
            }
        }
        totals
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmRunSummary {
    pub mission_id: String,
    #[serde(default)]
    pub goal: Option<String>,
    pub concurrent_max: usize,
    pub totals: SwarmRunTotals,
    pub tasks: Vec<SwarmTaskSummary>,
}

pub fn save_run_summary(repo_data_dir: &Path, summary: &RunSummary) -> Result<()> {
    persist_json(&run_summary_path(repo_data_dir, &summary.task_id), summary)
}

pub fn load_run_summary(repo_data_dir: &Path, task_id: &str) -> Result<Option<RunSummary>> {
    read_json_optional(&run_summary_path(repo_data_dir, task_id))
}

pub fn update_run_summary_outcome(
    repo_data_dir: &Path,
    task_id: &str,
    final_state: SandboxState,
    worktree_action: HookWorktreeAction,
    merge_conflicts: Vec<String>,
) -> Result<bool> {
    let Some(mut summary) = load_run_summary(repo_data_dir, task_id)? else {
        return Ok(false);
    };
    summary.final_state = final_state;
    summary.worktree_action = worktree_action;
    summary.merge_conflicts = merge_conflicts;
    save_run_summary(repo_data_dir, &summary)?;
    Ok(true)
}

pub fn save_swarm_run_summary(repo_data_dir: &Path, summary: &SwarmRunSummary) -> Result<()> {
    persist_json(
        &swarm_run_summary_path(repo_data_dir, &summary.mission_id),
        summary,
    )
}

pub fn load_swarm_run_summary(
    repo_data_dir: &Path,
    mission_id: &str,
) -> Result<Option<SwarmRunSummary>> {
    read_json_optional(&swarm_run_summary_path(repo_data_dir, mission_id))
}

pub fn write_swarm_artifact(
    repo_data_dir: &Path,
    mission_id: &str,
    artifact_path: &str,
    summary: &SwarmTaskSummary,
) -> Result<PathBuf> {
    let path = swarm_artifact_path(repo_data_dir, mission_id, artifact_path)?;
    persist_json(&path, summary)?;
    Ok(path)
}

pub fn read_swarm_artifact(
    repo_data_dir: &Path,
    mission_id: &str,
    artifact_path: &str,
) -> Result<String> {
    let path = swarm_artifact_path(repo_data_dir, mission_id, artifact_path)?;
    if path.exists() {
        return std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read swarm artifact '{}'", path.display()));
    }

    anyhow::bail!(
        "swarm artifact '{}' not found for mission '{}'",
        artifact_path,
        mission_id
    );
}

pub fn swarm_artifact_root(repo_data_dir: &Path, mission_id: &str) -> PathBuf {
    repo_data_dir
        .join("swarm-artifacts")
        .join(storage_key(mission_id))
}

pub fn swarm_artifact_path(
    repo_data_dir: &Path,
    mission_id: &str,
    artifact_path: &str,
) -> Result<PathBuf> {
    let relative = normalize_artifact_path(artifact_path)
        .map_err(|err| anyhow::anyhow!("invalid swarm artifact path '{artifact_path}': {err}"))?;
    Ok(swarm_artifact_root(repo_data_dir, mission_id).join(relative))
}

pub fn run_summary_path(repo_data_dir: &Path, task_id: &str) -> PathBuf {
    repo_data_dir
        .join("control")
        .join("runs")
        .join(format!("{}.json", storage_key(task_id)))
}

pub fn swarm_run_summary_path(repo_data_dir: &Path, mission_id: &str) -> PathBuf {
    repo_data_dir
        .join("control")
        .join("missions")
        .join(format!("{}.json", storage_key(mission_id)))
}

pub fn storage_key(value: &str) -> String {
    let normalized = value.trim();
    let label = sanitize_storage_component(normalized);
    let label = if label.is_empty() {
        "item".to_string()
    } else {
        label.chars().take(48).collect()
    };
    let id = Uuid::new_v5(&Uuid::NAMESPACE_URL, normalized.as_bytes());
    format!("{label}-{id}")
}

fn persist_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(value)?;
    std::fs::write(&tmp, json).with_context(|| format!("failed to write '{}'", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("failed to finalize '{}'", path.display()))?;
    Ok(())
}

fn read_json_optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read '{}'", path.display()))?;
    let parsed = serde_json::from_str(&text)
        .with_context(|| format!("failed to parse '{}'", path.display()))?;
    Ok(Some(parsed))
}

fn sanitize_storage_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(|ch| ch == '-' || ch == '.')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CandidatePolicy, SandboxLifecycle};

    #[test]
    fn storage_key_is_stable_and_safe() {
        let key = storage_key("../Mission Alpha");
        assert_eq!(key, storage_key("../Mission Alpha"));
        assert!(key.starts_with("Mission-Alpha-"));
        assert!(!key.contains('/'));
    }

    #[test]
    fn run_summary_roundtrips() {
        let dir = std::env::temp_dir().join(format!("bakudo-control-{}", Uuid::new_v4()));
        let summary = RunSummary {
            task_id: "task-123".to_string(),
            attempt_id: "attempt-123".to_string(),
            session_id: "session-123".to_string(),
            provider_id: "codex".to_string(),
            model: Some("gpt-5".to_string()),
            repo_root: Some("/tmp/repo".to_string()),
            worker_status: WorkerStatus::Succeeded,
            final_state: SandboxState::Merged,
            worktree_action: HookWorktreeAction::Merged,
            merge_conflicts: Vec::new(),
            candidate_policy: CandidatePolicy::AutoApply,
            sandbox_lifecycle: SandboxLifecycle::Preserved,
            summary: "done".to_string(),
            exit_code: 0,
            duration_ms: 42,
            timed_out: false,
            stdout: "hello".to_string(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            verification: Some(VerificationSummary {
                command: "cargo test -q".to_string(),
                status: VerificationStatus::Passed,
                exit_code: 0,
                timed_out: false,
                stdout_tail: "ok".to_string(),
                stderr_tail: String::new(),
            }),
            error: None,
        };

        save_run_summary(&dir, &summary).unwrap();
        let loaded = load_run_summary(&dir, "task-123").unwrap().unwrap();
        assert_eq!(loaded.summary, "done");
        assert_eq!(loaded.final_state, SandboxState::Merged);
        assert_eq!(
            loaded
                .verification
                .as_ref()
                .map(|verification| verification.status),
            Some(VerificationStatus::Passed)
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn swarm_artifact_path_uses_sanitized_mission_storage() {
        let dir = std::env::temp_dir().join(format!("bakudo-control-{}", Uuid::new_v4()));
        let path = swarm_artifact_path(&dir, "../mission unsafe", "artifacts/out.json").unwrap();
        assert!(path.starts_with(dir.join("swarm-artifacts")));
        assert!(path.ends_with(Path::new("artifacts").join("out.json")));
        assert!(!path
            .strip_prefix(dir.join("swarm-artifacts"))
            .unwrap()
            .to_string_lossy()
            .starts_with("../"));
    }
}
