//! Wire protocol types shared between the host and the worker running inside
//! the abox VM. These are serialised to/from JSON and written to stdout by
//! the worker so the host can parse them line-by-line.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PROTOCOL_SCHEMA_VERSION: u32 = 1;

/// Unique identifier for a single attempt (one VM run).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AttemptId(pub String);

impl AttemptId {
    pub fn new() -> Self {
        Self(format!("attempt-{}", Uuid::new_v4()))
    }
}

impl Default for AttemptId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for AttemptId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Unique identifier for a session (a single interactive shell session).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn new() -> Self {
        Self(format!("session-{}", Uuid::new_v4()))
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Unique identifier for a task (a single user goal dispatch).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaskId(pub String);

impl TaskId {
    pub fn new() -> Self {
        Self(format!("task-{}", Uuid::new_v4()))
    }
}

impl Default for TaskId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for TaskId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Budget constraints for a single attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptBudget {
    /// Wall-clock timeout in seconds. The abox `--timeout` flag is set to this value.
    pub timeout_secs: u64,
    /// Maximum bytes of combined stdout+stderr captured from the agent process.
    pub max_output_bytes: usize,
    /// How often (ms) the host expects a heartbeat event from the worker.
    pub heartbeat_interval_ms: u64,
}

impl Default for AttemptBudget {
    fn default() -> Self {
        Self {
            timeout_secs: 300,
            max_output_bytes: 512 * 1024,
            heartbeat_interval_ms: 5_000,
        }
    }
}

/// Permission flags for a single attempt.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AttemptPermissions {
    /// When true the provider is invoked with its "allow all tools" flag
    /// (e.g. `claude --dangerously-skip-permissions`, `codex --full-auto`).
    pub allow_all_tools: bool,
}

/// Sandbox lifecycle policy for an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxLifecycle {
    /// The worktree is removed after the VM exits (abox `--ephemeral`).
    Ephemeral,
    /// The worktree is preserved after the VM exits for host-side review.
    #[default]
    Preserved,
}

impl SandboxLifecycle {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ephemeral => "ephemeral",
            Self::Preserved => "preserved",
        }
    }
}

impl std::fmt::Display for SandboxLifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str((*self).as_str())
    }
}

/// What the host should do with a preserved worktree after the agent finishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidatePolicy {
    /// Automatically merge the worktree into the base branch if the agent succeeded.
    AutoApply,
    /// Discard the worktree (abox stop --clean) regardless of outcome.
    Discard,
    /// Leave the worktree preserved and wait for the user to decide.
    #[default]
    Review,
}

impl CandidatePolicy {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AutoApply => "auto_apply",
            Self::Discard => "discard",
            Self::Review => "review",
        }
    }
}

impl std::fmt::Display for CandidatePolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str((*self).as_str())
    }
}

/// The full specification for a single attempt. This is serialised to JSON
/// and injected into the worker via stdin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptSpec {
    pub schema_version: u32,
    pub attempt_id: AttemptId,
    pub session_id: SessionId,
    pub task_id: TaskId,
    /// The natural-language prompt sent to the agent.
    pub prompt: String,
    /// Working directory inside the VM (typically "/workspace").
    pub cwd: String,
    pub budget: AttemptBudget,
    pub permissions: AttemptPermissions,
    pub sandbox_lifecycle: SandboxLifecycle,
    pub candidate_policy: CandidatePolicy,
    /// Provider ID (e.g. "claude", "codex", "opencode"). Used to look up the
    /// command in the provider registry.
    pub provider_id: String,
    /// Model override (e.g. "claude-opus-4-5"). `None` means use the
    /// provider default.
    #[serde(default)]
    pub model: Option<String>,
    /// Optional path to the repo root on the host. Passed as `abox --repo`.
    pub repo_root: Option<String>,
}

impl AttemptSpec {
    pub fn new(prompt: impl Into<String>, provider_id: impl Into<String>) -> Self {
        Self {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            attempt_id: AttemptId::new(),
            session_id: SessionId::new(),
            task_id: TaskId::new(),
            prompt: prompt.into(),
            cwd: "/workspace".to_string(),
            budget: AttemptBudget::default(),
            permissions: AttemptPermissions::default(),
            sandbox_lifecycle: SandboxLifecycle::Preserved,
            candidate_policy: CandidatePolicy::Review,
            provider_id: provider_id.into(),
            model: None,
            repo_root: None,
        }
    }
}

/// A progress event emitted by the worker to stdout during execution.
/// The host reads these line-by-line and forwards them to the TUI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerProgressEvent {
    pub attempt_id: AttemptId,
    pub kind: WorkerProgressKind,
    pub message: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerProgressKind {
    Heartbeat,
    ToolCall,
    ToolResult,
    AssistantMessage,
    StatusUpdate,
}

/// The final result emitted by the worker to stdout when the agent finishes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerResult {
    pub schema_version: u32,
    pub attempt_id: AttemptId,
    pub session_id: SessionId,
    pub task_id: TaskId,
    pub status: WorkerStatus,
    /// One-line summary of what the agent did (or why it failed).
    pub summary: String,
    pub finished_at: DateTime<Utc>,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Succeeded,
    Failed,
    TimedOut,
    Cancelled,
}

/// Line-prefixes used to demarcate structured envelopes in raw stdout.
pub const WORKER_RESULT_PREFIX: &str = "BAKUDO_RESULT";
pub const WORKER_EVENT_PREFIX: &str = "BAKUDO_EVENT";
pub const WORKER_ERROR_PREFIX: &str = "BAKUDO_ERROR";
/// Optional assistant-emitted line prefix for a concise final hand-off.
pub const WORKER_SUMMARY_PREFIX: &str = "BAKUDO_SUMMARY:";
