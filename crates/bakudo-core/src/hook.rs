use serde::{Deserialize, Serialize};

use crate::control::VerificationSummary;
use crate::protocol::{AttemptId, CandidatePolicy, SandboxLifecycle, SessionId, WorkerStatus};
use crate::state::SandboxState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookWorktreeAction {
    Preserved,
    Merged,
    Discarded,
    MergeConflicts,
    VerificationFailed,
    NotApplied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostRunHookPayload {
    pub session_id: SessionId,
    pub attempt_id: AttemptId,
    pub task_id: String,
    pub repo_root: Option<String>,
    pub provider_id: String,
    #[serde(default)]
    pub model: Option<String>,
    pub candidate_policy: CandidatePolicy,
    pub sandbox_lifecycle: SandboxLifecycle,
    pub worker_status: WorkerStatus,
    pub final_state: SandboxState,
    pub worktree_action: HookWorktreeAction,
    pub summary: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub timed_out: bool,
    #[serde(default)]
    pub merge_conflicts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<VerificationSummary>,
}
