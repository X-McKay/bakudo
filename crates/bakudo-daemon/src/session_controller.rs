//! Session controller — manages the lifecycle of a single interactive session.
//!
//! A session is the top-level object representing one `bakudo` shell invocation.
//! It owns:
//!   - The SandboxLedger (all active/historical sandboxes for this session)
//!   - The current provider and model selection
//!   - The channel for dispatching new tasks
//!
//! On startup the session controller calls `abox list` and reconciles the
//! ledger to recover from any previous crash.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::{ALLOW, CONTENT_TYPE, ORIGIN};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use chrono::Utc;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::sync::{oneshot, watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use bakudo_core::abox::AboxAdapter;
use bakudo_core::config::BakudoConfig;
use bakudo_core::control::{save_run_summary, update_run_summary_outcome, RunSummary};
use bakudo_core::hook::{HookWorktreeAction, PostRunHookPayload};
use bakudo_core::mission::{
    Experiment, ExperimentId, ExperimentScript, ExperimentStatus, ExperimentSummary,
    ExperimentWorkload, LedgerEntry, LedgerKind, Mission, MissionId, MissionState, MissionStatus,
    Posture, UserMessage, WakeEvent, WakeId, WakeReason, WakeWhen, Wallet,
};
use bakudo_core::policy::PolicyDecision;
use bakudo_core::protocol::{CandidatePolicy, SandboxLifecycle, WorkerStatus};
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::session::SessionRecord;
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};

use crate::hooks::run_post_run_hook;
use crate::host::{HostAction, HostRuntime, HostSnapshot};
use crate::mission_store::{ActiveWaveRecord, MissionStore, PendingQuestionRecord};
use crate::provider_runtime::{ProviderCatalog, ProviderEngine};
use crate::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
use crate::trace::TraceRecorder;
use crate::worker::{build_agent_worker_command, build_script_worker_command};
use crate::worktree::{apply_candidate_policy, WorktreeAction};

/// Commands sent from the TUI to the session controller.
#[derive(Debug)]
pub enum SessionCommand {
    /// Route a freeform conversational turn through the host layer.
    HostInput { text: String },
    /// Dispatch a new task with the current provider/model.
    Dispatch { prompt: String, approved: bool },
    /// Arm approval for the next provider execution when policy requires it.
    ApproveExecution,
    /// Change the active provider.
    SetProvider { provider_id: String },
    /// Change the active model. `None` resets to the provider default.
    SetModel { model: Option<String> },
    /// Apply (merge) a preserved worktree.
    Apply { task_id: String },
    /// Discard a preserved worktree.
    Discard { task_id: String },
    /// Show divergence summary for a preserved worktree.
    Diverge { task_id: String },
    /// Show a unified diff for a preserved worktree.
    Diff { task_id: String },
    /// Run provider/abox health probes and emit a single Info event.
    Doctor,
    /// Start a durable mission with an explicit posture.
    StartMission {
        posture: Posture,
        goal: String,
        done_contract: Option<String>,
        constraints: Option<String>,
    },
    /// List active/recent missions for this repo.
    ShowMissions,
    /// Change the focused mission for the session.
    FocusMission { selector: String },
    /// Adjust the active mission wallet.
    SetMissionBudget {
        wall_clock_minutes: Option<u64>,
        workers: Option<u32>,
    },
    /// Force a manual wake for the active mission.
    ForceWake,
    /// Resolve a pending host approval request.
    ResolveHostApproval {
        request_id: String,
        approved: bool,
        edited_command: Option<String>,
    },
    /// Resolve a pending ask-user prompt.
    AnswerUserQuestion { request_id: String, answer: String },
    /// Internal: reevaluate mission wake state after experiment changes.
    RefreshMissionWakes { mission_id: MissionId },
    /// Shut down the session.
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct FleetCounts {
    pub active: usize,
    pub queued: usize,
    pub completed: usize,
    pub failed: usize,
}

#[derive(Debug, Clone)]
pub struct MissionBanner {
    pub mission_id: String,
    pub goal: String,
    pub posture: Posture,
    pub status: MissionStatus,
    pub wake: MissionWakeBanner,
    pub active_wave: Option<ActiveWaveSummary>,
    pub wall_clock_remaining_secs: u64,
    pub abox_workers_remaining: u32,
    pub abox_workers_in_flight: u32,
    pub concurrent_max: u32,
    pub pending_user_messages: usize,
    pub pending_questions: usize,
    pub pending_approvals: usize,
    pub latest_issue: Option<String>,
    pub latest_change: Option<String>,
    pub fleet: FleetCounts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissionWakeState {
    Idle,
    Queued,
    Running,
}

#[derive(Debug, Clone)]
pub struct MissionWakeBanner {
    pub state: MissionWakeState,
    pub current_reason: Option<WakeReason>,
    pub queued_count: usize,
}

#[derive(Debug, Clone)]
pub struct ActiveWaveSummary {
    pub total: usize,
    pub running: usize,
    pub queued: usize,
    pub completed: usize,
    pub failed: usize,
    pub concurrency_limit: u32,
    pub wake_when: WakeWhen,
    pub wake_sent: bool,
}

#[derive(Debug, Clone)]
pub enum MissionActivity {
    PlanUpdated {
        mission_id: String,
        reason: String,
        path: String,
    },
    UserNotified {
        mission_id: String,
        message: String,
    },
    QuestionAsked {
        mission_id: String,
        question: String,
    },
    ToolCallError {
        mission_id: String,
        tool: String,
        error: String,
    },
    WaveDispatched {
        mission_id: String,
        experiment_ids: Vec<String>,
        concurrency_limit: u32,
    },
    WorkerFinished {
        mission_id: String,
        experiment_id: String,
        label: String,
        status: ExperimentStatus,
        trace_bundle_path: Option<String>,
    },
    ApprovalBlocked {
        mission_id: String,
        reason: String,
    },
    MissionCompleted {
        mission_id: String,
        summary: String,
    },
}

impl MissionActivity {
    pub fn render_text(&self) -> String {
        match self {
            Self::PlanUpdated {
                mission_id,
                reason,
                path,
            } => format!("Mission {mission_id}: plan updated ({reason}). Artifact: {path}"),
            Self::UserNotified {
                mission_id,
                message,
            } => format!("Mission {mission_id}: {message}"),
            Self::QuestionAsked {
                mission_id,
                question,
            } => format!("Mission {mission_id}: question asked: {question}"),
            Self::ToolCallError {
                mission_id,
                tool,
                error,
            } => format!(
                "Mission {mission_id}: tool '{tool}' failed: {}",
                compact_single_line(error)
            ),
            Self::WaveDispatched {
                mission_id,
                experiment_ids,
                concurrency_limit,
            } => format!(
                "Mission {mission_id}: dispatched {} worker(s) with concurrency {}.",
                experiment_ids.len(),
                concurrency_limit
            ),
            Self::WorkerFinished {
                mission_id,
                label,
                status,
                ..
            } => format!("Mission {mission_id}: worker '{label}' finished with {status:?}."),
            Self::ApprovalBlocked { mission_id, reason } => {
                format!("Mission {mission_id}: agent wave blocked: {reason}")
            }
            Self::MissionCompleted {
                mission_id,
                summary,
            } => format!("Mission {mission_id}: completed. {summary}"),
        }
    }
}

/// Events emitted by the session controller to the TUI.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// Snapshot of the current sandbox ledger, used for startup recovery.
    LedgerSnapshot { entries: Vec<SandboxRecord> },
    /// A new task was dispatched.
    TaskStarted {
        task_id: String,
        provider_id: String,
        model: Option<String>,
        prompt_summary: String,
    },
    /// A progress event from a running task.
    TaskProgress { task_id: String, event: RunnerEvent },
    /// A task finished.
    TaskFinished {
        task_id: String,
        state: SandboxState,
    },
    /// Provider changed.
    ProviderChanged {
        provider_id: String,
        model: Option<String>,
    },
    /// Mission/fleet/wallet status changed.
    MissionUpdated { banner: Option<MissionBanner> },
    /// Approval required for a host_exec request.
    ApprovalRequested {
        request_id: String,
        command: String,
        reason: String,
    },
    /// The deliberator asked the user a question.
    UserQuestionRequested {
        request_id: String,
        question: String,
        choices: Vec<String>,
    },
    /// Typed mission progress activity for the transcript.
    MissionActivity { activity: MissionActivity },
    /// Informational message for the transcript.
    Info(String),
    /// An error occurred.
    Error(String),
    /// The session is shutting down.
    Shutdown,
}

pub struct SessionController {
    pub session: SessionRecord,
    pub config: Arc<BakudoConfig>,
    pub abox: Arc<AboxAdapter>,
    pub ledger: Arc<SandboxLedger>,
    pub registry: Arc<ProviderRegistry>,
    mission_store: Arc<MissionStore>,
    provider_catalog: ProviderCatalog,
    runtime_state: Arc<Mutex<MissionRuntimeState>>,
    host: HostRuntime,
    trace_recorder: TraceRecorder,
    current_provider: String,
    current_model: Option<String>,
    next_execution_approved: bool,
    resume_only: bool,
    cmd_rx: mpsc::Receiver<SessionCommand>,
    self_tx: mpsc::Sender<SessionCommand>,
    event_tx: mpsc::Sender<SessionEvent>,
}

#[derive(Default)]
struct MissionRuntimeState {
    active_mission_id: Option<MissionId>,
    pending_approvals: HashMap<String, PendingApproval>,
    pending_questions: HashMap<String, PendingQuestion>,
    deliberating: HashSet<MissionId>,
    wake_user_message_ids: HashMap<WakeId, Vec<i64>>,
    next_agent_wave_approved: bool,
}

struct PendingApproval {
    mission_id: MissionId,
    response_tx: oneshot::Sender<HostExecResolution>,
}

struct HostExecResolution {
    approved: bool,
    edited_command: Option<String>,
}

enum QuestionResolution {
    Answered(String),
    Expired,
}

struct PendingQuestion {
    mission_id: MissionId,
    state: PendingQuestionState,
}

enum PendingQuestionState {
    Waiting(oneshot::Sender<QuestionResolution>),
    Expired,
}

#[derive(Clone)]
struct MissionCore {
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    ledger: Arc<SandboxLedger>,
    mission_store: Arc<MissionStore>,
    provider_catalog: ProviderCatalog,
    runtime_state: Arc<Mutex<MissionRuntimeState>>,
    event_tx: mpsc::Sender<SessionEvent>,
    self_tx: mpsc::Sender<SessionCommand>,
    session: SessionRecord,
    host: HostRuntime,
    trace_recorder: TraceRecorder,
}

const MCP_ENDPOINT_PATH: &str = "/mcp";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Debug, Default)]
struct WakeStopState {
    desired_status: Option<MissionStatus>,
    saw_suspend: bool,
    forced_stop: bool,
}

struct WakeMcpServer {
    endpoint_url: String,
    stop_rx: watch::Receiver<WakeStopState>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join_handle: JoinHandle<()>,
}

#[derive(Clone)]
struct WakeMcpServerState {
    core: MissionCore,
    mission: Mission,
    wake: WakeEvent,
    tool_call_limit: u32,
    tool_calls_used: Arc<AtomicU32>,
    session: Arc<Mutex<Option<McpSessionState>>>,
    stop_tx: watch::Sender<WakeStopState>,
}

#[derive(Clone, Debug)]
struct McpSessionState {
    id: String,
    protocol_version: String,
    initialized: bool,
}

#[derive(Debug, serde::Deserialize)]
struct McpRequest {
    #[serde(default)]
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, serde::Deserialize)]
struct McpInitializeParams {
    #[serde(default, rename = "protocolVersion")]
    protocol_version: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct McpResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, serde::Serialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, serde::Serialize)]
struct McpToolDefinition {
    name: &'static str,
    description: &'static str,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
}

#[derive(Debug, serde::Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug)]
struct ToolCallOutcome {
    payload: Value,
    suspend: bool,
    mission_status: Option<MissionStatus>,
}

#[derive(Debug, serde::Deserialize)]
struct DispatchSwarmArgs {
    experiments: Vec<DispatchExperimentSpec>,
    #[serde(default)]
    concurrency_hint: Option<u32>,
    #[serde(default)]
    wake_when: Option<WakeWhen>,
}

#[derive(Debug, serde::Deserialize)]
struct DispatchExperimentSpec {
    label: String,
    hypothesis: String,
    #[serde(default)]
    skill: Option<String>,
    #[serde(default)]
    base_branch: Option<String>,
    kind: DispatchExperimentKind,
    #[serde(default)]
    script: Option<ExperimentScript>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    sandbox_lifecycle: Option<SandboxLifecycle>,
    #[serde(default)]
    candidate_policy: Option<CandidatePolicy>,
    #[serde(default)]
    timeout_secs: Option<u64>,
    #[serde(default)]
    allow_all_tools: Option<bool>,
    #[serde(default)]
    metric_keys: Vec<String>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum DispatchExperimentKind {
    Script,
    AgentTask,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct AboxExecArgs {
    script: String,
    #[serde(default)]
    abox_profile: Option<String>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
struct AboxApplyPatchArgs {
    patch: String,
    verify: String,
    #[serde(default)]
    abox_profile: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct HostExecArgs {
    command: String,
    reason: String,
}

#[derive(Debug, serde::Deserialize)]
struct MissionStatePatchArgs {
    patch: Value,
}

#[derive(Debug, serde::Deserialize)]
struct LessonArgs {
    title: String,
    body: String,
}

#[derive(Debug, serde::Deserialize)]
struct AskUserArgs {
    question: String,
    #[serde(default)]
    choices: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct NotifyUserArgs {
    message: String,
}

#[derive(Debug, serde::Deserialize)]
struct CompleteMissionArgs {
    summary: String,
}

#[derive(Debug, serde::Deserialize)]
struct ReadExperimentSummaryArgs {
    experiment_id: String,
}

#[derive(Debug, serde::Deserialize)]
struct UpdatePlanArgs {
    markdown: String,
    reason: String,
}

#[derive(Debug, serde::Deserialize)]
struct CancelExperimentsArgs {
    experiment_ids: Vec<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct SuspendArgs {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    expected_wake: Option<String>,
}

pub struct SessionBootstrap {
    pub session: SessionRecord,
    pub resume_only: bool,
}

impl SessionController {
    pub fn new(
        config: Arc<BakudoConfig>,
        abox: Arc<AboxAdapter>,
        ledger: Arc<SandboxLedger>,
        registry: Arc<ProviderRegistry>,
        self_tx: mpsc::Sender<SessionCommand>,
        cmd_rx: mpsc::Receiver<SessionCommand>,
        event_tx: mpsc::Sender<SessionEvent>,
    ) -> Self {
        let current_provider = config.default_provider.clone();
        let current_model = config.default_model.clone();
        let session = SessionRecord::new(
            &current_provider,
            current_model.clone(),
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string()),
        );
        Self::with_session(
            config,
            abox,
            ledger,
            registry,
            SessionBootstrap {
                session,
                resume_only: false,
            },
            self_tx,
            cmd_rx,
            event_tx,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session(
        config: Arc<BakudoConfig>,
        abox: Arc<AboxAdapter>,
        ledger: Arc<SandboxLedger>,
        registry: Arc<ProviderRegistry>,
        bootstrap: SessionBootstrap,
        self_tx: mpsc::Sender<SessionCommand>,
        cmd_rx: mpsc::Receiver<SessionCommand>,
        event_tx: mpsc::Sender<SessionEvent>,
    ) -> Self {
        let SessionBootstrap {
            session,
            resume_only,
        } = bootstrap;
        let current_provider = session.provider_id.clone();
        let current_model = session.model.clone();
        let repo_root = session
            .repo_root
            .clone()
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|path| path.display().to_string())
            })
            .unwrap_or_else(|| ".".to_string());
        let repo_data_dir = config.resolved_repo_data_dir(Some(Path::new(&repo_root)));
        let mission_store = Arc::new(
            MissionStore::open(repo_data_dir.join("state.db"))
                .expect("mission store should initialize"),
        );
        let provider_catalog = ProviderCatalog::new(repo_root);
        let host = HostRuntime::new();
        let trace_recorder = TraceRecorder::new(repo_data_dir);
        Self {
            session,
            config,
            abox,
            ledger,
            registry,
            mission_store,
            provider_catalog,
            runtime_state: Arc::new(Mutex::new(MissionRuntimeState::default())),
            host,
            trace_recorder,
            current_provider,
            current_model,
            next_execution_approved: false,
            resume_only,
            cmd_rx,
            self_tx,
            event_tx,
        }
    }

    /// Run the session event loop. This should be spawned as a tokio task.
    pub async fn run(mut self) {
        if let Err(e) = self.persist_session() {
            warn!(
                "Could not persist session '{}': {e}",
                self.session.session_id
            );
        }
        // Reconcile ledger on startup.
        self.reconcile_on_startup().await;
        self.recover_missions_on_startup();
        self.emit_mission_banner().await;

        while let Some(cmd) = self.cmd_rx.recv().await {
            match cmd {
                SessionCommand::HostInput { text } => {
                    self.handle_host_input(text).await;
                }
                SessionCommand::Dispatch { prompt, approved } => {
                    self.dispatch_task(prompt, approved).await;
                }
                SessionCommand::ApproveExecution => {
                    self.next_execution_approved = true;
                    let mut state = self.runtime_state.lock().await;
                    state.next_agent_wave_approved = true;
                }
                SessionCommand::SetProvider { provider_id } => {
                    self.set_provider(provider_id).await;
                }
                SessionCommand::SetModel { model } => {
                    self.current_model = model.clone();
                    self.session.model = model.clone();
                    if let Err(e) = self.persist_session() {
                        let _ = self
                            .event_tx
                            .send(SessionEvent::Error(format!(
                                "Failed to persist session {}: {e}",
                                self.session.session_id
                            )))
                            .await;
                    }
                    let _ = self
                        .event_tx
                        .send(SessionEvent::ProviderChanged {
                            provider_id: self.current_provider.clone(),
                            model,
                        })
                        .await;
                }
                SessionCommand::Apply { task_id } => {
                    self.apply_worktree(&task_id).await;
                }
                SessionCommand::Discard { task_id } => {
                    self.discard_worktree(&task_id).await;
                }
                SessionCommand::Diverge { task_id } => {
                    self.show_divergence(&task_id).await;
                }
                SessionCommand::Diff { task_id } => {
                    self.show_diff(&task_id).await;
                }
                SessionCommand::Doctor => {
                    self.run_doctor().await;
                }
                SessionCommand::StartMission {
                    posture,
                    goal,
                    done_contract,
                    constraints,
                } => {
                    self.start_mission(posture, goal, done_contract, constraints);
                }
                SessionCommand::ShowMissions => {
                    self.show_missions().await;
                }
                SessionCommand::FocusMission { selector } => {
                    self.focus_mission(selector).await;
                }
                SessionCommand::SetMissionBudget {
                    wall_clock_minutes,
                    workers,
                } => {
                    self.set_mission_budget(wall_clock_minutes, workers).await;
                }
                SessionCommand::ForceWake => {
                    self.force_wake();
                }
                SessionCommand::ResolveHostApproval {
                    request_id,
                    approved,
                    edited_command,
                } => {
                    self.resolve_host_approval(request_id, approved, edited_command)
                        .await;
                }
                SessionCommand::AnswerUserQuestion { request_id, answer } => {
                    self.answer_user_question(request_id, answer).await;
                }
                SessionCommand::RefreshMissionWakes { mission_id } => {
                    self.refresh_mission_wakes(mission_id);
                }
                SessionCommand::Shutdown => {
                    let _ = self.event_tx.send(SessionEvent::Shutdown).await;
                    break;
                }
            }
        }
    }

    async fn run_doctor(&self) {
        let report = crate::doctor::run(&self.config, &self.abox, &self.registry).await;
        let _ = self.event_tx.send(SessionEvent::Info(report)).await;
    }

    async fn reconcile_on_startup(&self) {
        match self.abox.list(self.repo_path().as_deref()).await {
            Ok(entries) => {
                self.ledger.reconcile(&entries).await;
                let snapshot = if self.resume_only {
                    self.ledger
                        .entries_for_session(&self.session.session_id)
                        .await
                } else {
                    self.ledger.all().await
                };
                let _ = self
                    .event_tx
                    .send(SessionEvent::LedgerSnapshot { entries: snapshot })
                    .await;
                info!("Reconciled ledger: {} abox entries", entries.len());
            }
            Err(e) => {
                warn!("Could not reconcile ledger on startup: {e}");
            }
        }
    }

    async fn handle_host_input(&mut self, text: String) {
        let snapshot = HostSnapshot {
            entries: self.ledger.all().await,
            provider_id: self.current_provider.clone(),
            model: self.current_model.clone(),
            base_branch: self.config.base_branch.clone(),
        };
        match self.host.handle_input(&text, &snapshot) {
            HostAction::Reply(message) => {
                let _ = self.event_tx.send(SessionEvent::Info(message)).await;
            }
            HostAction::StartMission {
                posture,
                objective,
                done_contract,
                constraints,
                announcement,
            } => {
                let _ = self.event_tx.send(SessionEvent::Info(announcement)).await;
                self.start_mission(posture, objective, done_contract, constraints);
            }
            HostAction::SteerMission { text, urgent } => {
                self.enqueue_active_mission_message(text, urgent);
            }
        }
    }

    async fn dispatch_task(&mut self, prompt: String, approved: bool) -> Option<String> {
        self.dispatch_task_with_policies(
            prompt,
            approved,
            self.config.candidate_policy,
            self.config.sandbox_lifecycle,
        )
        .await
    }

    async fn dispatch_task_with_policies(
        &mut self,
        prompt: String,
        approved: bool,
        candidate_policy: bakudo_core::protocol::CandidatePolicy,
        sandbox_lifecycle: bakudo_core::protocol::SandboxLifecycle,
    ) -> Option<String> {
        let provider = match self.registry.get(&self.current_provider) {
            Some(p) => p,
            None => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Unknown provider '{}'",
                        self.current_provider
                    )))
                    .await;
                return None;
            }
        };

        let execution_decision = self
            .config
            .execution_policy
            .evaluate(&self.current_provider);
        let approved = approved || std::mem::take(&mut self.next_execution_approved);
        match execution_decision.decision {
            PolicyDecision::Forbid => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Execution policy forbids provider '{}'.",
                        self.current_provider
                    )))
                    .await;
                return None;
            }
            PolicyDecision::Prompt if !approved => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Execution policy requires approval before running '{}'. Use /approve, then resubmit the task.",
                        self.current_provider
                    )))
                    .await;
                return None;
            }
            PolicyDecision::Allow | PolicyDecision::Prompt => {}
        }

        let mut spec = self.config.build_attempt_spec(
            &prompt,
            &self.current_provider,
            self.current_model.clone(),
            self.repo_path().map(|p| p.to_string_lossy().to_string()),
            execution_decision.allow_all_tools,
            candidate_policy,
            sandbox_lifecycle,
        );
        spec.session_id = self.session.session_id.clone();

        let task_id = bakudo_core::abox::sandbox_task_id(&spec.attempt_id.0);
        self.host.note_task_started(&task_id);
        let prompt_summary: String = prompt.chars().take(80).collect();

        let _ = self
            .event_tx
            .send(SessionEvent::TaskStarted {
                task_id: task_id.clone(),
                provider_id: self.current_provider.clone(),
                model: self.current_model.clone(),
                prompt_summary: prompt_summary.clone(),
            })
            .await;

        let cfg = Arc::new(TaskRunnerConfig {
            abox: self.abox.clone(),
            ledger: self.ledger.clone(),
            data_dir: self
                .config
                .resolved_repo_data_dir_from_str(self.session.repo_root.as_deref())
                .join("runs"),
            trace_recorder: self.trace_recorder.clone(),
            worker_command: provider.build_worker_command(
                self.current_model.as_deref(),
                execution_decision.allow_all_tools,
            ),
            memory_mib: provider.memory_mib,
            cpus: provider.cpus,
        });

        let event_tx = self.event_tx.clone();
        let config = self.config.clone();
        let ledger = self.ledger.clone();
        let abox = self.abox.clone();
        let base_branch = self.config.base_branch.clone();
        let repo = self.repo_path();
        let repo_data_dir = self
            .config
            .resolved_repo_data_dir_from_str(self.session.repo_root.as_deref());
        let candidate_policy = spec.candidate_policy;
        let tid = task_id.clone();
        let provider_id = spec.provider_id.clone();
        let model = spec.model.clone();
        let repo_root = spec.repo_root.clone();
        let session_id = spec.session_id.clone();
        let attempt_id = spec.attempt_id.clone();
        let sandbox_lifecycle = spec.sandbox_lifecycle;
        let host = self.host.clone();

        let (mut rx, handle) = run_attempt(spec, cfg).await;

        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                host.note_runner_event(&tid, &event);
                let _ = event_tx
                    .send(SessionEvent::TaskProgress {
                        task_id: tid.clone(),
                        event: event.clone(),
                    })
                    .await;
            }

            let (final_state, hook_payload) = match handle.await {
                Ok(Ok(result)) => {
                    let (final_state, worktree_action, merge_conflicts) =
                        if result.status == WorkerStatus::Succeeded {
                            match apply_candidate_policy(
                                &tid,
                                &candidate_policy,
                                &base_branch,
                                repo.as_deref(),
                                &abox,
                                &ledger,
                            )
                            .await
                            {
                                Ok(action) => {
                                    let (hook_action, conflicts) =
                                        hook_action_from_worktree_action(&action);
                                    (state_from_worktree_action(action), hook_action, conflicts)
                                }
                                Err(e) => {
                                    let _ = event_tx
                                        .send(SessionEvent::Error(format!(
                                            "Candidate policy error for {tid}: {e}"
                                        )))
                                        .await;
                                    (
                                        ledger
                                            .get(&tid)
                                            .await
                                            .map(|record| record.state)
                                            .unwrap_or(SandboxState::Preserved),
                                        HookWorktreeAction::NotApplied,
                                        Vec::new(),
                                    )
                                }
                            }
                        } else {
                            (
                                state_from_worker_status(&result.status, result.exit_code),
                                HookWorktreeAction::NotApplied,
                                Vec::new(),
                            )
                        };

                    let summary = RunSummary {
                        task_id: tid.clone(),
                        attempt_id: attempt_id.0.clone(),
                        session_id: session_id.0.clone(),
                        provider_id: provider_id.clone(),
                        model: model.clone(),
                        repo_root: repo_root.clone(),
                        worker_status: result.status.clone(),
                        final_state: final_state.clone(),
                        worktree_action,
                        merge_conflicts: merge_conflicts.clone(),
                        candidate_policy,
                        sandbox_lifecycle,
                        summary: result.summary.clone(),
                        exit_code: result.exit_code,
                        duration_ms: result.duration_ms,
                        timed_out: result.timed_out,
                        stdout: result.stdout.clone(),
                        stderr: result.stderr.clone(),
                        stdout_truncated: result.stdout_truncated,
                        stderr_truncated: result.stderr_truncated,
                        error: None,
                    };
                    if let Err(err) = save_run_summary(&repo_data_dir, &summary) {
                        let _ = event_tx
                            .send(SessionEvent::Error(format!(
                                "Failed to persist result for {tid}: {err}"
                            )))
                            .await;
                    }

                    (
                        final_state.clone(),
                        Some(PostRunHookPayload {
                            session_id,
                            attempt_id,
                            task_id: tid.clone(),
                            repo_root,
                            provider_id: provider_id.clone(),
                            model: model.clone(),
                            candidate_policy,
                            sandbox_lifecycle,
                            worker_status: result.status.clone(),
                            final_state,
                            worktree_action,
                            summary: result.summary,
                            exit_code: result.exit_code,
                            duration_ms: result.duration_ms,
                            timed_out: result.timed_out,
                            merge_conflicts,
                        }),
                    )
                }
                Ok(Err(e)) => {
                    warn!("Task {tid} failed before producing a final result: {e}");
                    let summary = RunSummary::infra_error(
                        tid.clone(),
                        attempt_id.0.clone(),
                        session_id.0.clone(),
                        provider_id.clone(),
                        model.clone(),
                        repo_root.clone(),
                        candidate_policy,
                        sandbox_lifecycle,
                        e.to_string(),
                    );
                    if let Err(err) = save_run_summary(&repo_data_dir, &summary) {
                        let _ = event_tx
                            .send(SessionEvent::Error(format!(
                                "Failed to persist infra-error result for {tid}: {err}"
                            )))
                            .await;
                    }
                    (SandboxState::Failed { exit_code: -1 }, None)
                }
                Err(e) => {
                    let _ = event_tx
                        .send(SessionEvent::Error(format!(
                            "Task join error for {tid}: {e}"
                        )))
                        .await;
                    let summary = RunSummary::infra_error(
                        tid.clone(),
                        attempt_id.0.clone(),
                        session_id.0.clone(),
                        provider_id.clone(),
                        model.clone(),
                        repo_root.clone(),
                        candidate_policy,
                        sandbox_lifecycle,
                        e.to_string(),
                    );
                    if let Err(err) = save_run_summary(&repo_data_dir, &summary) {
                        let _ = event_tx
                            .send(SessionEvent::Error(format!(
                                "Failed to persist join-error result for {tid}: {err}"
                            )))
                            .await;
                    }
                    (SandboxState::Failed { exit_code: -1 }, None)
                }
            };

            host.note_task_finished(&tid, &final_state);
            if let Some(payload) = hook_payload {
                if let Err(err) = run_post_run_hook(&config, &payload).await {
                    let _ = event_tx
                        .send(SessionEvent::Error(format!(
                            "Post-run hook failed for {tid}: {err}"
                        )))
                        .await;
                }
            }

            let _ = event_tx
                .send(SessionEvent::TaskFinished {
                    task_id: tid.clone(),
                    state: final_state,
                })
                .await;

            let snapshot = HostSnapshot {
                entries: ledger.all().await,
                provider_id: provider_id.clone(),
                model: model.clone(),
                base_branch: base_branch.clone(),
            };
            if let Some(note) = host.maybe_render_completion_note(&snapshot) {
                let _ = event_tx.send(SessionEvent::Info(note)).await;
            }
        });

        Some(task_id)
    }

    async fn set_provider(&mut self, provider_id: String) {
        if self.registry.get(&provider_id).is_none() {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(format!(
                    "Unknown provider '{provider_id}'"
                )))
                .await;
            return;
        }
        self.current_provider = provider_id.clone();
        self.session.provider_id = provider_id.clone();
        if let Err(e) = self.persist_session() {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(format!(
                    "Failed to persist session {}: {e}",
                    self.session.session_id
                )))
                .await;
        }
        let _ = self
            .event_tx
            .send(SessionEvent::ProviderChanged {
                provider_id,
                model: self.current_model.clone(),
            })
            .await;
    }

    async fn apply_worktree(&self, task_id: &str) {
        match crate::worktree::manual_apply(
            task_id,
            &self.config.base_branch,
            self.repo_path().as_deref(),
            &self.abox,
            &self.ledger,
        )
        .await
        {
            Ok(action) => {
                let (state, hook_action, conflicts) = match action {
                    WorktreeAction::Merged => {
                        (SandboxState::Merged, HookWorktreeAction::Merged, Vec::new())
                    }
                    WorktreeAction::MergeConflicts(conflicts) => (
                        SandboxState::MergeConflicts,
                        HookWorktreeAction::MergeConflicts,
                        conflicts,
                    ),
                    WorktreeAction::Discarded => (
                        SandboxState::Discarded,
                        HookWorktreeAction::Discarded,
                        Vec::new(),
                    ),
                    WorktreeAction::Preserved => (
                        SandboxState::Preserved,
                        HookWorktreeAction::Preserved,
                        Vec::new(),
                    ),
                };
                if let Err(err) = update_run_summary_outcome(
                    &self
                        .config
                        .resolved_repo_data_dir_from_str(self.session.repo_root.as_deref()),
                    task_id,
                    state.clone(),
                    hook_action,
                    conflicts,
                ) {
                    let _ = self
                        .event_tx
                        .send(SessionEvent::Error(format!(
                            "Failed to update persisted result for {task_id}: {err}"
                        )))
                        .await;
                }
                let _ = self
                    .event_tx
                    .send(SessionEvent::TaskFinished {
                        task_id: task_id.to_string(),
                        state,
                    })
                    .await;
            }
            Err(e) => {
                let _ = self.event_tx.send(SessionEvent::Error(e.to_string())).await;
            }
        }
    }

    async fn discard_worktree(&self, task_id: &str) {
        match crate::worktree::manual_discard(
            task_id,
            self.repo_path().as_deref(),
            &self.abox,
            &self.ledger,
        )
        .await
        {
            Ok(_) => {
                if let Err(err) = update_run_summary_outcome(
                    &self
                        .config
                        .resolved_repo_data_dir_from_str(self.session.repo_root.as_deref()),
                    task_id,
                    SandboxState::Discarded,
                    HookWorktreeAction::Discarded,
                    Vec::new(),
                ) {
                    let _ = self
                        .event_tx
                        .send(SessionEvent::Error(format!(
                            "Failed to update persisted result for {task_id}: {err}"
                        )))
                        .await;
                }
                let _ = self
                    .event_tx
                    .send(SessionEvent::TaskFinished {
                        task_id: task_id.to_string(),
                        state: SandboxState::Discarded,
                    })
                    .await;
            }
            Err(e) => {
                let _ = self.event_tx.send(SessionEvent::Error(e.to_string())).await;
            }
        }
    }

    async fn show_divergence(&self, task_id: &str) {
        match crate::candidate::query_divergence(
            task_id,
            &self.config.base_branch,
            self.repo_path().as_deref(),
        )
        .await
        {
            Ok(summary) => {
                let msg = if !summary.has_changes {
                    format!("[{task_id}] No divergence (worktree matches base branch).")
                } else {
                    format!("[{task_id}] Divergence:\n{}", summary.raw_output)
                };
                let _ = self.event_tx.send(SessionEvent::Info(msg)).await;
            }
            Err(e) => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Divergence check failed for {task_id}: {e}"
                    )))
                    .await;
            }
        }
    }

    async fn show_diff(&self, task_id: &str) {
        match crate::candidate::query_diff(
            task_id,
            &self.config.base_branch,
            self.repo_path().as_deref(),
        )
        .await
        {
            Ok(diff) => {
                let msg = if diff.trim().is_empty() {
                    format!("[{task_id}] No diff (worktree matches base branch).")
                } else {
                    format!("[{task_id}] Diff:\n{diff}")
                };
                let _ = self.event_tx.send(SessionEvent::Info(msg)).await;
            }
            Err(e) => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Diff check failed for {task_id}: {e}"
                    )))
                    .await;
            }
        }
    }

    fn repo_path(&self) -> Option<PathBuf> {
        self.session.repo_root.as_ref().map(PathBuf::from)
    }

    fn mission_core(&self) -> MissionCore {
        MissionCore {
            config: self.config.clone(),
            abox: self.abox.clone(),
            ledger: self.ledger.clone(),
            mission_store: self.mission_store.clone(),
            provider_catalog: self.provider_catalog.clone(),
            runtime_state: self.runtime_state.clone(),
            event_tx: self.event_tx.clone(),
            self_tx: self.self_tx.clone(),
            session: self.session.clone(),
            host: self.host.clone(),
            trace_recorder: self.trace_recorder.clone(),
        }
    }

    fn recover_missions_on_startup(&self) {
        let core = self.mission_core();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            if let Err(err) = core.recover_on_startup().await {
                let _ = event_tx
                    .send(SessionEvent::Error(format!(
                        "Mission recovery failed: {err}"
                    )))
                    .await;
            }
        });
    }

    fn start_mission(
        &self,
        posture: Posture,
        goal: String,
        done_contract: Option<String>,
        constraints: Option<String>,
    ) {
        let core = self.mission_core();
        let event_tx = self.event_tx.clone();
        let provider = self.current_provider.clone();
        tokio::spawn(async move {
            if let Err(err) = core
                .start_mission(provider, posture, goal, done_contract, constraints)
                .await
            {
                let _ = event_tx.send(SessionEvent::Error(err.to_string())).await;
            }
        });
    }

    async fn show_missions(&self) {
        if let Err(err) = self.mission_core().show_missions().await {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(err.to_string()))
                .await;
        }
    }

    async fn focus_mission(&self, selector: String) {
        if let Err(err) = self.mission_core().focus_mission(selector).await {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(err.to_string()))
                .await;
        }
    }

    fn enqueue_active_mission_message(&self, text: String, urgent: bool) {
        let core = self.mission_core();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            if let Err(err) = core.enqueue_active_mission_message(text, urgent).await {
                let _ = event_tx.send(SessionEvent::Error(err.to_string())).await;
            }
        });
    }

    async fn set_mission_budget(&self, wall_clock_minutes: Option<u64>, workers: Option<u32>) {
        if let Err(err) = self
            .mission_core()
            .set_mission_budget(wall_clock_minutes, workers)
            .await
        {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(err.to_string()))
                .await;
        }
    }

    fn force_wake(&self) {
        let core = self.mission_core();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            if let Err(err) = core.force_wake().await {
                let _ = event_tx.send(SessionEvent::Error(err.to_string())).await;
            }
        });
    }

    fn refresh_mission_wakes(&self, mission_id: MissionId) {
        let core = self.mission_core();
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            if let Err(err) = core.handle_experiment_finished(mission_id).await {
                let _ = event_tx.send(SessionEvent::Error(err.to_string())).await;
            }
        });
    }

    async fn resolve_host_approval(
        &self,
        request_id: String,
        approved: bool,
        edited_command: Option<String>,
    ) {
        if let Err(err) = self
            .mission_core()
            .resolve_host_approval(request_id, approved, edited_command)
            .await
        {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(err.to_string()))
                .await;
        }
    }

    async fn answer_user_question(&self, request_id: String, answer: String) {
        if let Err(err) = self
            .mission_core()
            .answer_user_question(request_id, answer)
            .await
        {
            let _ = self
                .event_tx
                .send(SessionEvent::Error(err.to_string()))
                .await;
        }
    }

    async fn emit_mission_banner(&self) {
        let _ = self
            .event_tx
            .send(SessionEvent::MissionUpdated {
                banner: self.mission_core().mission_banner().await.ok().flatten(),
            })
            .await;
    }

    fn persist_session(&self) -> Result<(), bakudo_core::error::SessionError> {
        self.session.save(&self.config.resolved_data_dir())
    }
}

impl MissionCore {
    async fn recover_on_startup(&self) -> Result<()> {
        let missions = self.mission_store.list_active_missions().await?;

        for mut mission in missions {
            let running = self.mission_store.running_experiments(mission.id).await?;
            if !running.is_empty() {
                for mut experiment in running {
                    experiment.status = ExperimentStatus::Failed;
                    experiment.finished_at = Some(Utc::now());
                    if experiment.summary.is_none() {
                        experiment.summary = Some(ExperimentSummary {
                            exit_code: -1,
                            duration: Duration::from_secs(0),
                            stdout_tail: String::new(),
                            stderr_tail: "mission recovered after restart".to_string(),
                            metrics: serde_json::Map::new(),
                            patch_path: None,
                        });
                    }
                    self.mission_store.upsert_experiment(&experiment).await?;
                    mission.wallet.mark_finished(1);
                }
            }
            let recovered_questions = self
                .mission_store
                .recoverable_pending_questions(mission.id)
                .await?;
            let mut awaiting_user = false;
            let mut recovered_user_input = None;
            for question in recovered_questions {
                if question.answer.is_some() {
                    recovered_user_input =
                        self.recover_answered_pending_question(&question).await?;
                } else {
                    awaiting_user = true;
                    let _ = self
                        .event_tx
                        .send(SessionEvent::UserQuestionRequested {
                            request_id: question.request_id.clone(),
                            question: question.question.clone(),
                            choices: question.choices.clone(),
                        })
                        .await;
                }
            }

            mission.status = if awaiting_user {
                MissionStatus::Sleeping
            } else {
                MissionStatus::AwaitingDeliberator
            };
            self.mission_store.upsert_mission(&mission).await?;
            if awaiting_user {
                self.emit_banner().await;
                let _ = self
                    .event_tx
                    .send(SessionEvent::Info(format!(
                        "Recovered a pending user question for mission {}. Answer it to resume the mission.",
                        mission.id
                    )))
                    .await;
                continue;
            }
            self.evaluate_active_wave(mission.id).await?;
            self.schedule_active_wave(mission.id).await?;
            if let Some(text) = recovered_user_input {
                self.queue_wake(
                    mission.id,
                    WakeReason::UserMessage,
                    json!({
                        "recovered_after_restart": true,
                        "text": text,
                        "urgent": true,
                    }),
                    true,
                )
                .await?;
            } else {
                self.queue_wake(
                    mission.id,
                    WakeReason::ManualResume,
                    json!({
                        "recovered_after_restart": true,
                        "goal": mission.goal,
                    }),
                    true,
                )
                .await?;
            }
        }
        self.reconcile_active_mission_focus().await?;
        Ok(())
    }

    async fn mission_banner(&self) -> Result<Option<MissionBanner>> {
        let mission_id = {
            let state = self.runtime_state.lock().await;
            state.active_mission_id
        };
        let Some(mission_id) = mission_id else {
            return Ok(None);
        };
        self.mission_banner_for(mission_id).await
    }

    async fn mission_banner_for(&self, mission_id: MissionId) -> Result<Option<MissionBanner>> {
        let Some(mission) = self.mission_store.mission(mission_id).await? else {
            return Ok(None);
        };
        let experiments = self
            .mission_store
            .experiments_for_mission(mission.id)
            .await?;
        let pending_user_messages = self
            .mission_store
            .undelivered_user_messages(mission.id)
            .await?
            .len();
        let pending_questions = self
            .mission_store
            .open_pending_questions(mission.id)
            .await?
            .len();
        let queued_wakes = self
            .mission_store
            .unprocessed_wakes(Some(mission.id))
            .await?;
        let latest_issue = self
            .mission_store
            .latest_tool_call_error(mission.id)
            .await?
            .map(|summary| render_tool_issue_summary(&summary));
        let latest_change = self
            .mission_store
            .recent_ledger(mission.id, 1)
            .await?
            .into_iter()
            .last()
            .map(|entry| compact_single_line(&entry.summary));
        let active_wave = self
            .mission_store
            .active_wave(mission.id)
            .await?
            .map(|wave| summarize_active_wave(&wave, &experiments));
        let (wake, pending_approvals) = {
            let state = self.runtime_state.lock().await;
            (
                summarize_wake_banner(
                    queued_wakes.as_slice(),
                    state.deliberating.contains(&mission.id),
                ),
                state
                    .pending_approvals
                    .values()
                    .filter(|pending| pending.mission_id == mission.id)
                    .count(),
            )
        };
        let fleet = FleetCounts {
            active: experiments
                .iter()
                .filter(|experiment| experiment.status == ExperimentStatus::Running)
                .count(),
            queued: experiments
                .iter()
                .filter(|experiment| experiment.status == ExperimentStatus::Queued)
                .count(),
            completed: experiments
                .iter()
                .filter(|experiment| experiment.status == ExperimentStatus::Succeeded)
                .count(),
            failed: experiments
                .iter()
                .filter(|experiment| {
                    matches!(
                        experiment.status,
                        ExperimentStatus::Failed
                            | ExperimentStatus::Cancelled
                            | ExperimentStatus::Timeout
                    )
                })
                .count(),
        };
        Ok(Some(MissionBanner {
            mission_id: mission.id.to_string(),
            goal: mission.goal,
            posture: mission.posture,
            status: mission.status,
            wake,
            active_wave,
            wall_clock_remaining_secs: mission.wallet.wall_clock_remaining.as_secs(),
            abox_workers_remaining: mission.wallet.abox_workers_remaining,
            abox_workers_in_flight: mission.wallet.abox_workers_in_flight,
            concurrent_max: mission.wallet.concurrent_max,
            pending_user_messages,
            pending_questions,
            pending_approvals,
            latest_issue,
            latest_change,
            fleet,
        }))
    }

    async fn set_active_mission_focus(&self, mission: &Mission) {
        {
            let mut state = self.runtime_state.lock().await;
            state.active_mission_id = Some(mission.id);
        }
        self.host
            .focus_mission(&mission.id.to_string(), &mission.goal, mission.posture);
        self.emit_banner().await;
    }

    async fn reconcile_active_mission_focus(&self) -> Result<Option<MissionId>> {
        let active_missions = self.mission_store.list_active_missions().await?;
        let current_focus = {
            let state = self.runtime_state.lock().await;
            state.active_mission_id
        };
        let next_focus = current_focus
            .filter(|mission_id| {
                active_missions
                    .iter()
                    .any(|mission| mission.id == *mission_id)
            })
            .or_else(|| active_missions.first().map(|mission| mission.id));
        {
            let mut state = self.runtime_state.lock().await;
            state.active_mission_id = next_focus;
        }
        if let Some(mission) = active_missions
            .iter()
            .find(|mission| Some(mission.id) == next_focus)
        {
            self.host
                .focus_mission(&mission.id.to_string(), &mission.goal, mission.posture);
        } else {
            self.host.clear_active_mission();
        }
        self.emit_banner().await;
        Ok(next_focus)
    }

    async fn show_missions(&self) -> Result<()> {
        let missions = self.mission_store.list_missions().await?;
        if missions.is_empty() {
            let _ = self
                .event_tx
                .send(SessionEvent::Info(
                    "No missions recorded for this repo.".to_string(),
                ))
                .await;
            return Ok(());
        }

        let focused_id = {
            let state = self.runtime_state.lock().await;
            state.active_mission_id
        };
        let mut lines = vec!["Missions:".to_string()];
        let active: Vec<_> = missions
            .iter()
            .filter(|mission| mission_status_is_active(mission.status))
            .cloned()
            .collect();
        if active.is_empty() {
            lines.push("  No active missions.".to_string());
        } else {
            lines.push("  Active:".to_string());
            for (index, mission) in active.iter().enumerate() {
                let Some(banner) = self.mission_banner_for(mission.id).await? else {
                    continue;
                };
                let focus_marker = if Some(mission.id) == focused_id {
                    "*"
                } else {
                    " "
                };
                lines.push(format!(
                    "  {}{}. [{}] {}  {}",
                    focus_marker,
                    index + 1,
                    short_mission_id(&banner.mission_id),
                    mission_operator_state_label(&banner),
                    banner.goal
                ));
                if let Some(blocker) = mission_blocker_summary(&banner) {
                    lines.push(format!("      blocker: {blocker}"));
                }
                if let Some(wake) = mission_wake_summary_line(&banner) {
                    lines.push(format!("      wake:    {wake}"));
                }
                if let Some(wave) = mission_wave_summary_line(&banner) {
                    lines.push(format!("      wave:    {wave}"));
                }
                if let Some(change) = banner.latest_change.as_deref() {
                    lines.push(format!("      latest:  {change}"));
                }
            }
            lines.push(
                "  Use /focus <number-or-id-prefix> to switch the active mission.".to_string(),
            );
        }

        let recent_terminal: Vec<_> = missions
            .into_iter()
            .filter(|mission| !mission_status_is_active(mission.status))
            .take(5)
            .collect();
        if !recent_terminal.is_empty() {
            lines.push("  Recent done:".to_string());
            for mission in recent_terminal {
                lines.push(format!(
                    "    [{}] {}  {}",
                    short_mission_id(&mission.id.to_string()),
                    mission_terminal_label(mission.status),
                    mission.goal
                ));
            }
        }

        let _ = self
            .event_tx
            .send(SessionEvent::Info(lines.join("\n")))
            .await;
        Ok(())
    }

    async fn focus_mission(&self, selector: String) -> Result<()> {
        let selector = selector.trim();
        if selector.is_empty() {
            anyhow::bail!("usage: /focus <number-or-id-prefix>");
        }
        let missions = self.mission_store.list_active_missions().await?;
        if missions.is_empty() {
            anyhow::bail!("no active missions are available to focus");
        }

        let mission = if let Ok(index) = selector.parse::<usize>() {
            missions
                .get(index.saturating_sub(1))
                .cloned()
                .ok_or_else(|| anyhow!("no active mission at index {}", index))?
        } else {
            let matches: Vec<_> = missions
                .iter()
                .filter(|mission| mission.id.to_string().starts_with(selector))
                .cloned()
                .collect();
            match matches.as_slice() {
                [] => anyhow::bail!("no active mission matches '{}'", selector),
                [mission] => mission.clone(),
                _ => anyhow::bail!(
                    "mission selector '{}' is ambiguous; use a longer id prefix",
                    selector
                ),
            }
        };

        self.set_active_mission_focus(&mission).await;
        let Some(banner) = self.mission_banner_for(mission.id).await? else {
            anyhow::bail!(
                "mission '{}' disappeared before focus could update",
                mission.id
            );
        };
        let mut lines = vec![format!(
            "Focused mission [{}] {}  {}",
            short_mission_id(&banner.mission_id),
            mission_operator_state_label(&banner),
            banner.goal
        )];
        if let Some(blocker) = mission_blocker_summary(&banner) {
            lines.push(format!("blocker: {blocker}"));
        }
        if let Some(wake) = mission_wake_summary_line(&banner) {
            lines.push(format!("wake:    {wake}"));
        }
        if let Some(wave) = mission_wave_summary_line(&banner) {
            lines.push(format!("wave:    {wave}"));
        }
        lines.push(format!("next:    {}", mission_next_action_summary(&banner)));
        let _ = self
            .event_tx
            .send(SessionEvent::Info(lines.join("\n")))
            .await;
        Ok(())
    }

    async fn emit_banner(&self) {
        let _ = self
            .event_tx
            .send(SessionEvent::MissionUpdated {
                banner: self.mission_banner().await.ok().flatten(),
            })
            .await;
    }

    async fn emit_mission_activity(&self, activity: MissionActivity) {
        let _ = self
            .event_tx
            .send(SessionEvent::MissionActivity { activity })
            .await;
    }

    async fn start_mission(
        &self,
        provider_base: String,
        posture: Posture,
        goal: String,
        done_contract: Option<String>,
        constraints: Option<String>,
    ) -> Result<MissionId> {
        let provider = self.provider_catalog.load_for(&provider_base, posture)?;
        let mission = Mission {
            id: MissionId::new(),
            goal: goal.clone(),
            posture,
            provider_name: provider_base,
            abox_profile: provider.abox_profile.clone(),
            wallet: Wallet::default(),
            status: MissionStatus::AwaitingDeliberator,
            created_at: Utc::now(),
            completed_at: None,
        };
        let mission_state =
            initial_mission_state(&goal, done_contract.clone(), constraints.clone());
        self.mission_store.upsert_mission(&mission).await?;
        self.mission_store
            .save_mission_state(mission.id, &mission_state)
            .await?;
        let plan = initial_mission_plan(&goal, done_contract.as_deref(), constraints.as_deref());
        self.mission_store
            .seed_mission_plan(mission.id, &plan)
            .await?;
        let plan_path = self.mission_store.mission_plan_path(mission.id);
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: format!("mission created: {}", mission.goal),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        self.set_active_mission_focus(&mission).await;
        self.emit_mission_activity(MissionActivity::PlanUpdated {
            mission_id: mission.id.to_string(),
            reason: "seeded mission plan".to_string(),
            path: plan_path.display().to_string(),
        })
        .await;
        let _ = self
            .event_tx
            .send(SessionEvent::Info(format!(
                "Started {} mission '{}' using provider '{}'.",
                posture, mission.goal, provider.name
            )))
            .await;
        self.queue_wake(
            mission.id,
            WakeReason::ManualResume,
            json!({
                "goal": goal,
                "done_contract": done_contract,
                "constraints": constraints,
            }),
            true,
        )
        .await?;
        Ok(mission.id)
    }

    async fn enqueue_active_mission_message(&self, text: String, urgent: bool) -> Result<()> {
        let mission_id = self.active_mission_id().await?;
        self.enqueue_mission_message(mission_id, text, urgent).await
    }

    async fn enqueue_mission_message(
        &self,
        mission_id: MissionId,
        text: String,
        urgent: bool,
    ) -> Result<()> {
        self.enqueue_mission_message_with_ledger_summary(mission_id, text.clone(), urgent, text)
            .await
    }

    async fn enqueue_mission_message_with_ledger_summary(
        &self,
        mission_id: MissionId,
        text: String,
        urgent: bool,
        ledger_summary: String,
    ) -> Result<()> {
        self.persist_mission_message(mission_id, text.clone(), urgent, ledger_summary)
            .await?;
        self.queue_wake(
            mission_id,
            WakeReason::UserMessage,
            json!({ "text": text, "urgent": urgent }),
            true,
        )
        .await?;
        Ok(())
    }

    async fn persist_mission_message(
        &self,
        mission_id: MissionId,
        text: String,
        urgent: bool,
        ledger_summary: String,
    ) -> Result<()> {
        let message = UserMessage {
            at: Utc::now(),
            text,
            urgent,
        };
        self.mission_store
            .enqueue_user_message(mission_id, &message)
            .await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::UserSteering,
                summary: ledger_summary,
                mission_id,
                experiment_id: None,
            })
            .await?;
        self.emit_banner().await;
        Ok(())
    }

    async fn set_mission_budget(
        &self,
        wall_clock_minutes: Option<u64>,
        workers: Option<u32>,
    ) -> Result<()> {
        let mission_id = self.active_mission_id().await?;
        let Some(mut mission) = self.mission_store.mission(mission_id).await? else {
            anyhow::bail!("active mission was not found");
        };
        if let Some(minutes) = wall_clock_minutes {
            mission.wallet.wall_clock_remaining = Duration::from_secs(minutes * 60);
        }
        if let Some(workers) = workers {
            mission.wallet.abox_workers_remaining = workers;
            mission.wallet.concurrent_max = workers.max(1);
            mission.wallet.abox_workers_in_flight = mission
                .wallet
                .abox_workers_in_flight
                .min(mission.wallet.concurrent_max);
        }
        self.mission_store.upsert_mission(&mission).await?;
        self.emit_banner().await;
        Ok(())
    }

    async fn force_wake(&self) -> Result<()> {
        let mission_id = self.active_mission_id().await?;
        self.queue_wake(
            mission_id,
            WakeReason::ManualResume,
            json!({ "forced": true }),
            true,
        )
        .await?;
        Ok(())
    }

    async fn resolve_host_approval(
        &self,
        request_id: String,
        approved: bool,
        edited_command: Option<String>,
    ) -> Result<()> {
        let tx = {
            let mut state = self.runtime_state.lock().await;
            state
                .pending_approvals
                .remove(&request_id)
                .map(|pending| pending.response_tx)
        };
        let Some(tx) = tx else {
            anyhow::bail!("unknown approval request '{}'", request_id);
        };
        let _ = tx.send(HostExecResolution {
            approved,
            edited_command,
        });
        Ok(())
    }

    async fn answer_user_question(&self, request_id: String, answer: String) -> Result<()> {
        let pending = {
            let mut state = self.runtime_state.lock().await;
            state.pending_questions.remove(&request_id)
        };
        let Some(stored_question) = self.mission_store.pending_question(&request_id).await? else {
            anyhow::bail!("unknown question request '{}'", request_id);
        };
        if stored_question.resolved_at.is_some() {
            anyhow::bail!("question request '{}' was already resolved", request_id);
        }
        if stored_question.answered_at.is_some() {
            anyhow::bail!("question request '{}' was already answered", request_id);
        }
        self.mission_store
            .save_pending_question_answer(&request_id, &answer, Utc::now())
            .await?;
        self.emit_banner().await;

        let Some(pending) = pending else {
            return self
                .reroute_late_question_answer(stored_question.mission_id, request_id, answer)
                .await;
        };
        match pending.state {
            PendingQuestionState::Waiting(answer_tx) => {
                if answer_tx
                    .send(QuestionResolution::Answered(answer.clone()))
                    .is_ok()
                {
                    return Ok(());
                }
            }
            PendingQuestionState::Expired => {}
        }

        self.reroute_late_question_answer(pending.mission_id, request_id, answer)
            .await
    }

    async fn reroute_late_question_answer(
        &self,
        mission_id: MissionId,
        request_id: String,
        answer: String,
    ) -> Result<()> {
        self.mission_store
            .promote_answered_pending_question_to_user_message(&request_id, true)
            .await?
            .ok_or_else(|| {
                anyhow!(
                    "question request '{}' could not be rerouted into the mission inbox",
                    request_id
                )
            })?;
        self.append_provenance(
            mission_id,
            json!({
                "event": "late_question_answer_rerouted",
                "at": Utc::now(),
                "request_id": request_id,
                "answer": answer,
            }),
        )
        .await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::UserSteering,
                summary: format!("ask_user: {answer}"),
                mission_id,
                experiment_id: None,
            })
            .await?;
        self.emit_banner().await;
        self.queue_wake(
            mission_id,
            WakeReason::UserMessage,
            json!({ "text": answer, "urgent": true }),
            true,
        )
        .await?;
        let _ = self
            .event_tx
            .send(SessionEvent::Info(
                "The original question wake had already ended. Routed your answer back into the mission as a normal message.".to_string(),
            ))
            .await;
        Ok(())
    }

    async fn recover_answered_pending_question(
        &self,
        question: &PendingQuestionRecord,
    ) -> Result<Option<String>> {
        let Some(answer) = question.answer.clone() else {
            return Ok(None);
        };
        let Some(_) = self
            .mission_store
            .promote_answered_pending_question_to_user_message(&question.request_id, true)
            .await?
        else {
            return Ok(None);
        };
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::UserSteering,
                summary: format!("ask_user: {answer}"),
                mission_id: question.mission_id,
                experiment_id: None,
            })
            .await?;
        self.emit_banner().await;
        Ok(Some(answer))
    }

    async fn expire_pending_questions_for_mission(&self, mission_id: MissionId) {
        let expired: Vec<_> = {
            let mut state = self.runtime_state.lock().await;
            let mut expired = Vec::new();
            for pending in state.pending_questions.values_mut() {
                if pending.mission_id != mission_id {
                    continue;
                }
                let previous = std::mem::replace(&mut pending.state, PendingQuestionState::Expired);
                if let PendingQuestionState::Waiting(answer_tx) = previous {
                    expired.push(answer_tx);
                }
            }
            expired
        };
        for answer_tx in expired {
            let _ = answer_tx.send(QuestionResolution::Expired);
        }
    }

    async fn active_mission_id(&self) -> Result<MissionId> {
        let state = self.runtime_state.lock().await;
        state
            .active_mission_id
            .ok_or_else(|| anyhow!("no active mission"))
    }

    async fn queue_wake(
        &self,
        mission_id: MissionId,
        reason: WakeReason,
        payload: Value,
        immediate: bool,
    ) -> Result<WakeId> {
        let wake_id = self.enqueue_wake(mission_id, reason, payload).await?;
        if immediate {
            self.process_next_wake(mission_id).await?;
        }
        Ok(wake_id)
    }

    async fn enqueue_wake(
        &self,
        mission_id: MissionId,
        reason: WakeReason,
        payload: Value,
    ) -> Result<WakeId> {
        let Some(mut mission) = self.mission_store.mission(mission_id).await? else {
            anyhow::bail!("mission '{}' not found", mission_id);
        };
        let mission_state = self.mission_store.mission_state(mission_id).await?;
        let queued_messages = self
            .mission_store
            .undelivered_user_messages(mission_id)
            .await?;
        let message_ids: Vec<i64> = queued_messages.iter().map(|item| item.id).collect();
        let user_inbox: Vec<UserMessage> = queued_messages
            .iter()
            .map(|item| item.message.clone())
            .collect();
        let recent_ledger = self.mission_store.recent_ledger(mission_id, 5).await?;
        let wake = WakeEvent {
            id: WakeId::new(),
            mission_id,
            reason,
            created_at: Utc::now(),
            payload,
            mission_state,
            wallet: mission.wallet.clone(),
            user_inbox,
            recent_ledger,
        };
        self.mission_store.insert_wake(&wake).await?;
        self.append_provenance(
            mission_id,
            json!({
                "event": "wake_queued",
                "at": Utc::now(),
                "wake": wake.clone(),
            }),
        )
        .await?;
        mission.status = MissionStatus::AwaitingDeliberator;
        self.mission_store.upsert_mission(&mission).await?;
        {
            let mut state = self.runtime_state.lock().await;
            state.wake_user_message_ids.insert(wake.id, message_ids);
        }
        self.emit_banner().await;
        Ok(wake.id)
    }

    async fn process_next_wake(&self, mission_id: MissionId) -> Result<()> {
        {
            let mut state = self.runtime_state.lock().await;
            if state.deliberating.contains(&mission_id) {
                return Ok(());
            }
            state.deliberating.insert(mission_id);
        }

        loop {
            let wake = self
                .mission_store
                .unprocessed_wakes(Some(mission_id))
                .await?
                .into_iter()
                .next()
                .map(|record| record.wake);
            let Some(wake) = wake else {
                {
                    let mut state = self.runtime_state.lock().await;
                    state.deliberating.remove(&mission_id);
                }
                if self
                    .mission_store
                    .unprocessed_wakes(Some(mission_id))
                    .await?
                    .is_empty()
                {
                    self.emit_banner().await;
                    return Ok(());
                }
                let mut state = self.runtime_state.lock().await;
                if state.deliberating.contains(&mission_id) {
                    self.emit_banner().await;
                    return Ok(());
                }
                state.deliberating.insert(mission_id);
                continue;
            };

            let Some(mut mission) = self.mission_store.mission(mission_id).await? else {
                break;
            };
            if mission_status_is_terminal(mission.status) {
                self.mission_store.mark_wake_processed(wake.id).await?;
                let delivered = {
                    let mut state = self.runtime_state.lock().await;
                    state
                        .wake_user_message_ids
                        .remove(&wake.id)
                        .unwrap_or_default()
                };
                self.mission_store
                    .mark_user_messages_delivered(&delivered)
                    .await?;
                continue;
            }
            mission.status = MissionStatus::Deliberating;
            self.mission_store.upsert_mission(&mission).await?;
            self.emit_banner().await;

            let desired_status = self.run_deliberator(&mission, &wake).await?;
            self.mission_store.mark_wake_processed(wake.id).await?;
            let delivered = {
                let mut state = self.runtime_state.lock().await;
                state
                    .wake_user_message_ids
                    .remove(&wake.id)
                    .unwrap_or_default()
            };
            self.mission_store
                .mark_user_messages_delivered(&delivered)
                .await?;

            mission.status = desired_status.unwrap_or(MissionStatus::Sleeping);
            if matches!(
                mission.status,
                MissionStatus::Completed | MissionStatus::Cancelled | MissionStatus::Failed
            ) {
                mission.completed_at = Some(Utc::now());
            }
            self.mission_store.upsert_mission(&mission).await?;
            self.reconcile_active_mission_focus().await?;
        }

        let mut state = self.runtime_state.lock().await;
        state.deliberating.remove(&mission_id);
        Ok(())
    }

    async fn run_deliberator(
        &self,
        mission: &Mission,
        wake: &WakeEvent,
    ) -> Result<Option<MissionStatus>> {
        let provider = self
            .provider_catalog
            .load_for(&mission.provider_name, mission.posture)?;
        let system_prompt = tokio::fs::read_to_string(&provider.system_prompt_file)
            .await
            .with_context(|| {
                format!(
                    "failed to read system prompt '{}'",
                    provider.system_prompt_file.display()
                )
            })?;
        let deliberator_prompt = build_deliberator_prompt(&system_prompt, wake)?;
        let wake_dir = self.repo_data_dir().join("wakes");
        tokio::fs::create_dir_all(&wake_dir).await?;
        let wake_path = wake_dir.join(format!("{}.json", wake.id));
        tokio::fs::write(&wake_path, serde_json::to_vec_pretty(wake)?).await?;
        let mcp_server = self
            .start_wake_mcp_server(mission, wake, provider.wake_budget.tool_calls)
            .await?;
        let (binary, args, mcp_launch) = self
            .build_deliberator_command(
                &provider,
                mission.id,
                wake.id,
                &deliberator_prompt,
                &mcp_server.endpoint_url,
            )
            .await?;

        self.trace_recorder
            .record_wake_start(
                mission.id,
                wake,
                &json!({
                    "provider": provider.name.clone(),
                    "engine": format!("{:?}", provider.engine),
                    "system_prompt_file": provider.system_prompt_file.clone(),
                    "launch_binary": binary.clone(),
                    "launch_args": args.clone(),
                    "prompt_preview": deliberator_prompt.chars().take(2000).collect::<String>(),
                    "mcp": mcp_launch,
                }),
            )
            .await;
        self.append_provenance(
            mission.id,
            json!({
                "event": "wake_started",
                "at": Utc::now(),
                "wake_id": wake.id,
                "wake_reason": wake.reason,
                "wake_path": wake_path,
            }),
        )
        .await?;

        let mut cmd = Command::new(&binary);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("BAKUDO_WAKE_EVENT_PATH", &wake_path)
            .env("BAKUDO_SYSTEM_PROMPT_PATH", &provider.system_prompt_file)
            .env("BAKUDO_MISSION_ID", mission.id.to_string())
            .env("BAKUDO_POSTURE", mission.posture.to_string())
            .env("BAKUDO_MCP_SERVER_URL", &mcp_server.endpoint_url)
            .env("BAKUDO_MCP_PROTOCOL_VERSION", MCP_PROTOCOL_VERSION);
        if let Some(repo_root) = self.session.repo_root.as_ref() {
            cmd.current_dir(repo_root)
                .env("BAKUDO_REPO_ROOT", repo_root);
        }
        for (key, host_env_name) in &provider.env {
            if let Ok(value) = std::env::var(host_env_name) {
                cmd.env(key, value);
            }
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn deliberator '{}'", binary))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("missing deliberator stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("missing deliberator stderr"))?;
        let event_tx = self.event_tx.clone();
        let mission_label = mission.id.to_string();
        let trace_recorder = self.trace_recorder.clone();
        let trace_mission_id = mission.id;
        let trace_wake_id = wake.id;
        tokio::spawn(async move {
            let mut stderr_lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = stderr_lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                trace_recorder
                    .append_wake_stderr(trace_mission_id, trace_wake_id, trimmed)
                    .await;
                let _ = event_tx
                    .send(SessionEvent::Info(format!(
                        "[mission {}] stderr: {}",
                        mission_label, trimmed
                    )))
                    .await;
            }
        });

        let event_tx = self.event_tx.clone();
        let trace_recorder = self.trace_recorder.clone();
        let trace_mission_id = mission.id;
        let trace_wake_id = wake.id;
        tokio::spawn(async move {
            let mut stdout_lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = stdout_lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                trace_recorder
                    .append_wake_stdout(trace_mission_id, trace_wake_id, trimmed)
                    .await;
                let _ = event_tx
                    .send(SessionEvent::Info(format!(
                        "[mission {}] {}",
                        trace_mission_id, trimmed
                    )))
                    .await;
            }
        });

        let mut desired_status = None;
        let mut saw_suspend = false;
        let mut forced_stop = false;
        let mut child_status = None;
        let mut stop_rx = mcp_server.stop_rx.clone();
        let deadline = tokio::time::sleep(provider.wake_budget.wall_clock);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                status = child.wait(), if child_status.is_none() => {
                    child_status = Some(status?);
                    break;
                }
                _ = &mut deadline => {
                    self.append_provenance(
                        mission.id,
                        json!({
                            "event": "wake_budget_exhausted",
                            "at": Utc::now(),
                            "wake_id": wake.id,
                            "kind": "wall_clock",
                            "limit_ms": provider.wake_budget.wall_clock.as_millis(),
                        }),
                    )
                    .await?;
                    self.enqueue_wake(
                        mission.id,
                        WakeReason::Timeout,
                        json!({
                            "kind": "wake_budget_wall_clock",
                            "limit_ms": provider.wake_budget.wall_clock.as_millis(),
                        }),
                    )
                    .await?;
                    desired_status = Some(MissionStatus::Sleeping);
                    forced_stop = true;
                    break;
                }
                changed = stop_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let state = mcp_server.current_state();
                    desired_status = desired_status.or(state.desired_status);
                    saw_suspend |= state.saw_suspend;
                    forced_stop |= state.forced_stop;
                    if saw_suspend || forced_stop {
                        break;
                    }
                }
            }
        }

        let final_state = mcp_server.current_state();
        desired_status = desired_status.or(final_state.desired_status);
        saw_suspend |= final_state.saw_suspend;
        forced_stop |= final_state.forced_stop;

        if forced_stop {
            self.expire_pending_questions_for_mission(mission.id).await;
        }
        mcp_server.shutdown().await;

        if let Some(status) = child_status {
            if !status.success() && desired_status.is_none() {
                desired_status = Some(MissionStatus::Failed);
            }
        } else if forced_stop {
            match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(err)) => return Err(err.into()),
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        } else if saw_suspend {
            match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(status)) => {
                    if !status.success() && desired_status.is_none() {
                        desired_status = Some(MissionStatus::Failed);
                    }
                }
                Ok(Err(err)) => return Err(err.into()),
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }

        self.append_provenance(
            mission.id,
            json!({
                "event": "wake_finished",
                "at": Utc::now(),
                "wake_id": wake.id,
                "mission_status": desired_status,
                "saw_suspend": saw_suspend,
            }),
        )
        .await?;
        self.trace_recorder
            .record_wake_finish(
                mission.id,
                wake.id,
                &json!({
                    "mission_status": desired_status,
                    "saw_suspend": saw_suspend,
                    "forced_stop": forced_stop,
                }),
            )
            .await;

        Ok(desired_status)
    }

    async fn start_wake_mcp_server(
        &self,
        mission: &Mission,
        wake: &WakeEvent,
        tool_call_limit: u32,
    ) -> Result<WakeMcpServer> {
        let (stop_tx, stop_rx) = watch::channel(WakeStopState::default());
        let state = Arc::new(WakeMcpServerState {
            core: self.clone(),
            mission: mission.clone(),
            wake: wake.clone(),
            tool_call_limit,
            tool_calls_used: Arc::new(AtomicU32::new(0)),
            session: Arc::new(Mutex::new(None)),
            stop_tx,
        });
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .context("failed to bind wake MCP listener")?;
        let addr = listener.local_addr()?;
        let router = Router::new()
            .route(
                MCP_ENDPOINT_PATH,
                post(wake_mcp_post)
                    .get(wake_mcp_get)
                    .delete(wake_mcp_delete),
            )
            .with_state(state);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let join_handle = tokio::spawn(async move {
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            if let Err(err) = server.await {
                warn!("wake MCP server failed: {err}");
            }
        });
        Ok(WakeMcpServer {
            endpoint_url: format!("http://127.0.0.1:{}{}", addr.port(), MCP_ENDPOINT_PATH),
            stop_rx,
            shutdown_tx: Some(shutdown_tx),
            join_handle,
        })
    }

    async fn build_deliberator_command(
        &self,
        provider: &crate::provider_runtime::ProviderRuntimeConfig,
        mission_id: MissionId,
        wake_id: WakeId,
        deliberator_prompt: &str,
        mcp_endpoint_url: &str,
    ) -> Result<(String, Vec<String>, Value)> {
        let wake_trace_dir = self.trace_recorder.wake_dir(mission_id, wake_id);
        tokio::fs::create_dir_all(&wake_trace_dir).await?;
        match provider.engine {
            ProviderEngine::Exec => {
                let (first, rest) = provider.engine_args.split_first().ok_or_else(|| {
                    anyhow!("exec provider '{}' is missing engine_args", provider.name)
                })?;
                let mut args = rest.to_vec();
                args.push(deliberator_prompt.to_string());
                Ok((
                    first.clone(),
                    args,
                    json!({
                        "transport": "streamable_http",
                        "endpoint": mcp_endpoint_url,
                        "delivery": "env",
                    }),
                ))
            }
            ProviderEngine::ClaudeCode => {
                let config_path = wake_trace_dir.join("claude-mcp.json");
                let config = json!({
                    "mcpServers": {
                        "bakudo": {
                            "type": "http",
                            "url": mcp_endpoint_url,
                        }
                    }
                });
                tokio::fs::write(&config_path, serde_json::to_vec_pretty(&config)?).await?;
                let mut args = provider.engine_args.clone();
                if provider.allow_all_tools {
                    if let Some(flag) = provider.engine.allow_all_flag() {
                        args.push(flag.to_string());
                    }
                }
                args.push("--mcp-config".to_string());
                args.push(config_path.display().to_string());
                args.push("--strict-mcp-config".to_string());
                args.push(deliberator_prompt.to_string());
                Ok((
                    provider.engine.binary().to_string(),
                    args,
                    json!({
                        "transport": "streamable_http",
                        "endpoint": mcp_endpoint_url,
                        "config_path": config_path,
                    }),
                ))
            }
            ProviderEngine::Codex => {
                let mut args = provider.engine_args.clone();
                args.push("--ignore-user-config".to_string());
                args.push("-c".to_string());
                args.push(format!("mcp_servers.bakudo.url={mcp_endpoint_url:?}"));
                args.push("-c".to_string());
                args.push("mcp_servers.bakudo.default_tools_approval_mode=\"approve\"".to_string());
                if provider.allow_all_tools {
                    if let Some(flag) = provider.engine.allow_all_flag() {
                        args.push(flag.to_string());
                    }
                }
                args.push(deliberator_prompt.to_string());
                Ok((
                    provider.engine.binary().to_string(),
                    args,
                    json!({
                        "transport": "streamable_http",
                        "endpoint": mcp_endpoint_url,
                        "config_override": format!("mcp_servers.bakudo.url={mcp_endpoint_url:?}"),
                        "tool_approval_mode": "approve",
                        "ignore_user_config": true,
                    }),
                ))
            }
            ProviderEngine::Gemini | ProviderEngine::OpenCode => Err(anyhow!(
                "provider engine '{}' does not yet have a non-interactive per-wake MCP launch path",
                provider.engine.binary()
            )),
        }
    }

    async fn handle_tool_call(
        &self,
        mission: &Mission,
        wake: &WakeEvent,
        call: ToolCallParams,
    ) -> Result<ToolCallOutcome> {
        let tool_name = call.name.clone();
        let tool_arguments = call.arguments.clone();
        let raw = match tool_name.as_str() {
            "read_plan" => self.tool_read_plan(mission).await?,
            "update_plan" => self.tool_update_plan(mission, call.arguments).await?,
            "notify_user" => self.tool_notify_user(mission, call.arguments).await?,
            "complete_mission" => self.tool_complete_mission(mission, call.arguments).await?,
            "read_experiment_summary" => {
                self.tool_read_experiment_summary(mission, call.arguments)
                    .await?
            }
            "dispatch_swarm" => {
                self.tool_dispatch_swarm(mission, wake, call.arguments)
                    .await?
            }
            "abox_exec" => self.tool_abox_exec(mission, wake, call.arguments).await?,
            "abox_apply_patch" => {
                self.tool_abox_apply_patch(mission, wake, call.arguments)
                    .await?
            }
            "host_exec" => self.tool_host_exec(mission, wake, call.arguments).await?,
            "update_mission_state" => {
                self.tool_update_mission_state(mission, wake, call.arguments)
                    .await?
            }
            "record_lesson" => {
                self.tool_record_lesson(mission, wake, call.arguments)
                    .await?
            }
            "ask_user" => self.tool_ask_user(mission, wake, call.arguments).await?,
            "cancel_experiments" => {
                self.tool_cancel_experiments(mission, wake, call.arguments)
                    .await?
            }
            "suspend" => self.tool_suspend(mission, wake, call.arguments).await?,
            other => anyhow::bail!("unknown tool '{}'", other),
        };

        let meta = self.meta_sidecar(mission.id, wake.id).await?;
        let payload = json!({
            "result": raw.payload,
            "meta": meta,
        });
        self.append_provenance(
            mission.id,
            json!({
                "event": "tool_call",
                "at": Utc::now(),
                "wake_id": wake.id,
                "tool": tool_name,
                "arguments": tool_arguments,
                "response": payload.clone(),
                "suspend": raw.suspend,
                "mission_status": raw.mission_status,
            }),
        )
        .await?;
        self.trace_recorder
            .append_wake_tool_call(
                mission.id,
                wake.id,
                &json!({
                    "at": Utc::now(),
                    "tool": tool_name,
                    "arguments": tool_arguments,
                    "response": payload.clone(),
                    "suspend": raw.suspend,
                    "mission_status": raw.mission_status,
                }),
            )
            .await;
        Ok(ToolCallOutcome {
            payload,
            suspend: raw.suspend,
            mission_status: raw.mission_status,
        })
    }

    async fn tool_dispatch_swarm(
        &self,
        mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: DispatchSwarmArgs = serde_json::from_value(arguments)?;
        let count = u32::try_from(args.experiments.len()).unwrap_or(u32::MAX);
        if count == 0 {
            anyhow::bail!("dispatch_swarm requires at least one experiment");
        }
        let concurrency_limit = args.concurrency_hint.unwrap_or(count).max(1);
        let Some(mut stored_mission) = self.mission_store.mission(mission.id).await? else {
            anyhow::bail!("mission '{}' not found", mission.id);
        };
        if !stored_mission.wallet.can_reserve_workers(count) {
            anyhow::bail!(
                "wallet would be exceeded by dispatching {} experiments",
                count
            );
        }
        let wake_when = args.wake_when.unwrap_or_default();
        let mut experiment_ids = Vec::new();
        let mut approval_required = false;
        let experiments: Vec<Experiment> = args
            .experiments
            .into_iter()
            .map(|spec| -> Result<Experiment> {
                let DispatchExperimentSpec {
                    label,
                    hypothesis,
                    skill,
                    base_branch,
                    kind,
                    script,
                    prompt,
                    provider,
                    model,
                    sandbox_lifecycle,
                    candidate_policy,
                    timeout_secs,
                    allow_all_tools,
                    metric_keys,
                } = spec;
                let workload = match kind {
                    DispatchExperimentKind::Script => {
                        if prompt.is_some()
                            || provider.is_some()
                            || model.is_some()
                            || timeout_secs.is_some()
                            || allow_all_tools.is_some()
                        {
                            anyhow::bail!(
                                "script experiments only accept kind, script, label, hypothesis, base_branch, skill, metric_keys, sandbox_lifecycle, and candidate_policy"
                            );
                        }
                        ExperimentWorkload::Script {
                            script: script.ok_or_else(|| {
                                anyhow!("script experiments require a script payload")
                            })?,
                            sandbox_lifecycle: sandbox_lifecycle
                                .unwrap_or(SandboxLifecycle::Ephemeral),
                            candidate_policy: candidate_policy.unwrap_or(CandidatePolicy::Discard),
                        }
                    }
                    DispatchExperimentKind::AgentTask => {
                        if script.is_some() {
                            anyhow::bail!(
                                "agent_task experiments do not accept a script payload"
                            );
                        }
                        let prompt = prompt.ok_or_else(|| {
                            anyhow!("agent_task experiments require a prompt field")
                        })?;
                        let provider_id = provider
                            .clone()
                            .unwrap_or_else(|| stored_mission.provider_name.clone());
                        let policy = self.config.execution_policy.evaluate(&provider_id);
                        if policy.decision == PolicyDecision::Forbid {
                            anyhow::bail!(
                                "execution policy forbids mission-native provider '{}'",
                                provider_id
                            );
                        }
                        if policy.decision == PolicyDecision::Prompt {
                            approval_required = true;
                        }
                        let worker_cfg = self
                            .provider_catalog
                            .load_for(&provider_id, mission.posture)?
                            .worker
                            .ok_or_else(|| {
                                anyhow!(
                                    "provider '{}' does not declare a mission worker configuration",
                                    provider_id
                                )
                            })?;
                        ExperimentWorkload::AgentTask {
                            prompt,
                            provider: Some(provider_id),
                            model,
                            sandbox_lifecycle: sandbox_lifecycle
                                .unwrap_or(SandboxLifecycle::Preserved),
                            candidate_policy: candidate_policy.unwrap_or(CandidatePolicy::Review),
                            timeout_secs: timeout_secs.or(Some(worker_cfg.timeout_secs)),
                            allow_all_tools: allow_all_tools
                                .unwrap_or(policy.allow_all_tools && worker_cfg.allow_all_tools),
                        }
                    }
                };
                let experiment = Experiment {
                    id: ExperimentId::new(),
                    mission_id: mission.id,
                    label,
                    spec: bakudo_core::mission::ExperimentSpec {
                        base_branch: base_branch.unwrap_or_else(|| self.config.base_branch.clone()),
                        workload,
                        skill,
                        hypothesis,
                        metric_keys,
                    },
                    status: ExperimentStatus::Queued,
                    started_at: None,
                    finished_at: None,
                    summary: None,
                };
                experiment_ids.push(experiment.id);
                Ok(experiment)
            })
            .collect::<Result<Vec<_>>>()?;

        if approval_required {
            let approved = {
                let mut state = self.runtime_state.lock().await;
                std::mem::take(&mut state.next_agent_wave_approved)
            };
            if !approved {
                let reason =
                    "approval is required before launching agent workloads for this provider"
                        .to_string();
                self.emit_mission_activity(MissionActivity::ApprovalBlocked {
                    mission_id: mission.id.to_string(),
                    reason: reason.clone(),
                })
                .await;
                return Ok(ToolCallOutcome {
                    payload: json!({
                        "accepted": false,
                        "blocked": {
                            "kind": "approval_required",
                            "reason": reason,
                        },
                    }),
                    suspend: false,
                    mission_status: None,
                });
            }
        }

        stored_mission.wallet.reserve_workers(count);
        stored_mission.status = MissionStatus::Sleeping;
        self.mission_store.upsert_mission(&stored_mission).await?;

        for experiment in &experiments {
            self.mission_store.upsert_experiment(experiment).await?;
        }
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: format!("dispatched {} experiments", experiments.len()),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        self.mission_store
            .save_active_wave(&ActiveWaveRecord {
                mission_id: mission.id,
                experiment_ids: experiment_ids.clone(),
                concurrency_limit,
                wake_when,
                wake_sent: false,
                updated_at: Utc::now(),
            })
            .await?;
        self.emit_banner().await;
        self.emit_mission_activity(MissionActivity::WaveDispatched {
            mission_id: mission.id.to_string(),
            experiment_ids: experiment_ids.iter().map(ToString::to_string).collect(),
            concurrency_limit,
        })
        .await;
        self.schedule_active_wave(mission.id).await?;

        Ok(ToolCallOutcome {
            payload: json!({
                "accepted": true,
                "experiment_ids": experiment_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "concurrency_limit": concurrency_limit,
                "wake_when": match wake_when {
                    WakeWhen::AllComplete => "all_complete",
                    WakeWhen::FirstComplete => "first_complete",
                    WakeWhen::AnyFailure => "any_failure",
                },
            }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_abox_exec(
        &self,
        mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: AboxExecArgs = serde_json::from_value(arguments)?;
        let mut stored_mission = self
            .mission_store
            .mission(mission.id)
            .await?
            .ok_or_else(|| anyhow!("mission '{}' not found", mission.id))?;
        if !stored_mission.wallet.can_dispatch(1) {
            anyhow::bail!("wallet does not allow another abox worker");
        }
        stored_mission.wallet.debit_workers(1);
        self.mission_store.upsert_mission(&stored_mission).await?;
        self.emit_banner().await;
        let outcome = self
            .run_inline_script(
                mission,
                "abox_exec",
                ExperimentScript::Inline {
                    source: args.script,
                },
                args.abox_profile.as_deref(),
                args.timeout_secs.unwrap_or(120),
            )
            .await?;
        let mut refreshed = self
            .mission_store
            .mission(mission.id)
            .await?
            .ok_or_else(|| anyhow!("mission '{}' not found after abox_exec", mission.id))?;
        refreshed.wallet.mark_finished(1);
        self.mission_store.upsert_mission(&refreshed).await?;
        self.emit_banner().await;
        Ok(ToolCallOutcome {
            payload: json!({
                "exit_code": outcome.exit_code,
                "duration_ms": outcome.duration_ms,
                "stdout_tail": outcome.stdout_tail,
                "stderr_tail": outcome.stderr_tail,
            }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_abox_apply_patch(
        &self,
        mission: &Mission,
        wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: AboxApplyPatchArgs = serde_json::from_value(arguments)?;
        let inner = self
            .tool_abox_exec(
                mission,
                wake,
                serde_json::to_value(AboxExecArgs {
                    script: patch_apply_script(&args.patch, &args.verify),
                    abox_profile: args.abox_profile,
                    timeout_secs: Some(120),
                })?,
            )
            .await?;
        let verify = inner.payload.clone();
        Ok(ToolCallOutcome {
            payload: json!({
                "applied": verify.get("exit_code").and_then(Value::as_i64) == Some(0),
                "verify": verify,
            }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_host_exec(
        &self,
        mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: HostExecArgs = serde_json::from_value(arguments)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.runtime_state.lock().await;
            state.pending_approvals.insert(
                request_id.clone(),
                PendingApproval {
                    mission_id: mission.id,
                    response_tx: tx,
                },
            );
        }
        self.emit_banner().await;
        let _ = self
            .event_tx
            .send(SessionEvent::ApprovalRequested {
                request_id: request_id.clone(),
                command: args.command.clone(),
                reason: args.reason.clone(),
            })
            .await;

        let resolution = rx.await.unwrap_or(HostExecResolution {
            approved: false,
            edited_command: None,
        });
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: format!(
                    "host_exec {}: {}",
                    if resolution.approved {
                        "approved"
                    } else {
                        "denied"
                    },
                    args.reason
                ),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        self.emit_banner().await;
        if !resolution.approved {
            return Ok(ToolCallOutcome {
                payload: json!({ "approved": false }),
                suspend: false,
                mission_status: None,
            });
        }

        let command = resolution.edited_command.unwrap_or(args.command);
        let output = Command::new("bash")
            .arg("-lc")
            .arg(&command)
            .current_dir(self.repo_root())
            .output()
            .await?;
        Ok(ToolCallOutcome {
            payload: json!({
                "approved": true,
                "exit_code": output.status.code().unwrap_or(-1),
                "stdout_tail": trim_tail(&String::from_utf8_lossy(&output.stdout), 4096),
                "stderr_tail": trim_tail(&String::from_utf8_lossy(&output.stderr), 4096),
            }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_update_mission_state(
        &self,
        mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: MissionStatePatchArgs = serde_json::from_value(arguments)?;
        let mut mission_state = self.mission_store.mission_state(mission.id).await?;
        merge_patch(&mut mission_state.0, args.patch);
        self.mission_store
            .save_mission_state(mission.id, &mission_state)
            .await?;
        Ok(ToolCallOutcome {
            payload: json!({ "applied": true }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_read_plan(&self, mission: &Mission) -> Result<ToolCallOutcome> {
        let (path, markdown) = self.mission_store.read_mission_plan(mission.id).await?;
        let updated_at = self
            .mission_store
            .mission_plan_updated_at(mission.id)
            .await?
            .map(|at| at.to_rfc3339());
        Ok(ToolCallOutcome {
            payload: json!({
                "path": path.display().to_string(),
                "markdown": markdown,
                "updated_at": updated_at,
            }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_update_plan(
        &self,
        mission: &Mission,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: UpdatePlanArgs = serde_json::from_value(arguments)?;
        let path = self
            .mission_store
            .write_mission_plan(mission.id, &args.markdown)
            .await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: format!("plan updated: {}", truncate(&args.reason)),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        self.emit_mission_activity(MissionActivity::PlanUpdated {
            mission_id: mission.id.to_string(),
            reason: args.reason,
            path: path.display().to_string(),
        })
        .await;
        let updated_at = self
            .mission_store
            .mission_plan_updated_at(mission.id)
            .await?
            .map(|at| at.to_rfc3339());
        Ok(ToolCallOutcome {
            payload: json!({
                "path": path.display().to_string(),
                "updated_at": updated_at,
            }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_notify_user(
        &self,
        mission: &Mission,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: NotifyUserArgs = serde_json::from_value(arguments)?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: format!("notify_user: {}", truncate(&args.message)),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        self.emit_mission_activity(MissionActivity::UserNotified {
            mission_id: mission.id.to_string(),
            message: args.message.clone(),
        })
        .await;
        Ok(ToolCallOutcome {
            payload: json!({ "delivered": true }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_complete_mission(
        &self,
        mission: &Mission,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: CompleteMissionArgs = serde_json::from_value(arguments)?;
        let mut mission_state = self.mission_store.mission_state(mission.id).await?;
        merge_patch(
            &mut mission_state.0,
            json!({ "completion_summary": args.summary.clone(), "active_wave": null }),
        );
        self.mission_store
            .save_mission_state(mission.id, &mission_state)
            .await?;
        let Some(mut stored_mission) = self.mission_store.mission(mission.id).await? else {
            anyhow::bail!("mission '{}' not found", mission.id);
        };
        stored_mission.status = MissionStatus::Completed;
        stored_mission.completed_at = Some(Utc::now());
        self.mission_store.upsert_mission(&stored_mission).await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: format!("mission completed: {}", truncate(&args.summary)),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        self.host.mark_mission_completed(&mission.id.to_string());
        self.emit_mission_activity(MissionActivity::MissionCompleted {
            mission_id: mission.id.to_string(),
            summary: args.summary.clone(),
        })
        .await;
        Ok(ToolCallOutcome {
            payload: json!({ "completed": true }),
            suspend: true,
            mission_status: Some(MissionStatus::Completed),
        })
    }

    async fn tool_read_experiment_summary(
        &self,
        mission: &Mission,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: ReadExperimentSummaryArgs = serde_json::from_value(arguments)?;
        let experiment = self
            .mission_store
            .experiments_for_mission(mission.id)
            .await?
            .into_iter()
            .find(|experiment| experiment.id.to_string() == args.experiment_id)
            .ok_or_else(|| anyhow!("experiment '{}' not found", args.experiment_id))?;
        let trace_bundle_path = self
            .trace_recorder
            .attempt_trace_bundle_path(&experiment_task_id(experiment.id));
        Ok(ToolCallOutcome {
            payload: json!({
                "summary": experiment.summary,
                "trace_bundle_path": trace_bundle_path
                    .exists()
                    .then(|| trace_bundle_path.display().to_string()),
            }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_record_lesson(
        &self,
        mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: LessonArgs = serde_json::from_value(arguments)?;
        let slug = slugify(&args.title);
        let path = self.provider_catalog.lessons_dir().join(format!(
            "{}-{}.md",
            Utc::now().format("%Y-%m-%d"),
            slug
        ));
        tokio::fs::create_dir_all(self.provider_catalog.lessons_dir()).await?;
        tokio::fs::write(
            &path,
            format!("# {}\n\n{}\n", args.title.trim(), args.body.trim()),
        )
        .await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Lesson,
                summary: args.title,
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        Ok(ToolCallOutcome {
            payload: json!({ "path": path.to_string_lossy().to_string() }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_ask_user(
        &self,
        mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: AskUserArgs = serde_json::from_value(arguments)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.mission_store
            .insert_pending_question(&PendingQuestionRecord {
                request_id: request_id.clone(),
                mission_id: mission.id,
                question: args.question.clone(),
                choices: args.choices.clone(),
                asked_at: Utc::now(),
                answer: None,
                answered_at: None,
                resolved_at: None,
            })
            .await?;
        {
            let mut state = self.runtime_state.lock().await;
            state.pending_questions.insert(
                request_id.clone(),
                PendingQuestion {
                    mission_id: mission.id,
                    state: PendingQuestionState::Waiting(tx),
                },
            );
        }
        self.emit_mission_activity(MissionActivity::QuestionAsked {
            mission_id: mission.id.to_string(),
            question: args.question.clone(),
        })
        .await;
        let _ = self
            .event_tx
            .send(SessionEvent::UserQuestionRequested {
                request_id: request_id.clone(),
                question: args.question.clone(),
                choices: args.choices.clone(),
            })
            .await;
        let answer = match rx.await.unwrap_or(QuestionResolution::Expired) {
            QuestionResolution::Answered(answer) => answer,
            QuestionResolution::Expired => {
                anyhow::bail!("user question expired before the wake could resume");
            }
        };
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::UserSteering,
                summary: format!("ask_user: {}", answer),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
        self.mission_store
            .resolve_pending_question(&request_id, Utc::now())
            .await?;
        self.emit_banner().await;
        Ok(ToolCallOutcome {
            payload: json!({ "answer": answer }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_cancel_experiments(
        &self,
        mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: CancelExperimentsArgs = serde_json::from_value(arguments)?;
        let mut cancelled = Vec::new();
        let mut cancelled_running = 0_u32;
        for experiment_id in args.experiment_ids {
            let task_id = experiment_task_id(parse_experiment_id(&experiment_id)?);
            let _ = self
                .abox
                .stop(
                    self.session.repo_root.as_deref().map(Path::new),
                    &task_id,
                    true,
                )
                .await;
            let mut experiments = self
                .mission_store
                .experiments_for_mission(mission.id)
                .await?;
            if let Some(experiment) = experiments
                .iter_mut()
                .find(|experiment| experiment.id.to_string() == experiment_id)
            {
                if experiment.status == ExperimentStatus::Running {
                    cancelled_running = cancelled_running.saturating_add(1);
                }
                experiment.status = ExperimentStatus::Cancelled;
                experiment.finished_at = Some(Utc::now());
                self.mission_store.upsert_experiment(experiment).await?;
                cancelled.push(experiment_id);
            }
        }
        if cancelled_running > 0 {
            if let Some(mut stored_mission) = self.mission_store.mission(mission.id).await? {
                stored_mission.wallet.mark_finished(cancelled_running);
                self.mission_store.upsert_mission(&stored_mission).await?;
            }
        }
        if let Some(reason) = args.reason {
            self.mission_store
                .append_ledger(&LedgerEntry {
                    at: Utc::now(),
                    kind: LedgerKind::Decision,
                    summary: format!("cancelled experiments: {}", reason),
                    mission_id: mission.id,
                    experiment_id: None,
                })
                .await?;
        }
        match self
            .self_tx
            .send(SessionCommand::RefreshMissionWakes {
                mission_id: mission.id,
            })
            .await
        {
            Ok(()) => {}
            Err(err) => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Failed to queue mission wake refresh: {err}"
                    )))
                    .await;
            }
        }
        Ok(ToolCallOutcome {
            payload: json!({ "cancelled": cancelled }),
            suspend: false,
            mission_status: None,
        })
    }

    async fn tool_suspend(
        &self,
        _mission: &Mission,
        _wake: &WakeEvent,
        arguments: Value,
    ) -> Result<ToolCallOutcome> {
        let args: SuspendArgs = serde_json::from_value(arguments)?;
        Ok(ToolCallOutcome {
            payload: json!({
                "reason": args.reason,
                "expected_wake": args.expected_wake,
                "suspended": true,
            }),
            suspend: true,
            mission_status: None,
        })
    }

    async fn meta_sidecar(&self, mission_id: MissionId, wake_id: WakeId) -> Result<Value> {
        let mission = self
            .mission_store
            .mission(mission_id)
            .await?
            .ok_or_else(|| anyhow!("mission '{}' not found", mission_id))?;
        let experiments = self
            .mission_store
            .experiments_for_mission(mission_id)
            .await?;
        let pending_user_messages = self
            .mission_store
            .undelivered_user_messages(mission_id)
            .await?
            .len();
        let pending_questions = self
            .mission_store
            .open_pending_questions(mission_id)
            .await?
            .len();
        let latest_issue = self
            .mission_store
            .latest_tool_call_error(mission_id)
            .await?
            .map(|summary| render_tool_issue_summary(&summary));
        Ok(json!({
            "wallet": mission.wallet,
            "fleet": {
                "active": experiments.iter().filter(|experiment| experiment.status == ExperimentStatus::Running).count(),
                "queued": experiments.iter().filter(|experiment| experiment.status == ExperimentStatus::Queued).count(),
                "completed_this_mission": experiments.iter().filter(|experiment| experiment.status == ExperimentStatus::Succeeded).count(),
                "failed_this_mission": experiments.iter().filter(|experiment| matches!(experiment.status, ExperimentStatus::Failed | ExperimentStatus::Cancelled | ExperimentStatus::Timeout)).count(),
            },
            "pending_user_messages": pending_user_messages,
            "pending_questions": pending_questions,
            "latest_issue": latest_issue,
            "posture": mission.posture,
            "wake_id": wake_id,
        }))
    }

    async fn run_experiment(&self, mut experiment: Experiment) -> Result<()> {
        let mission = self
            .mission_store
            .mission(experiment.mission_id)
            .await?
            .ok_or_else(|| anyhow!("mission '{}' not found", experiment.mission_id))?;
        let task_id = experiment_task_id(experiment.id);
        let (
            prompt,
            provider_id,
            model,
            worker_command,
            timeout_secs,
            max_output_bytes,
            memory_mib,
            cpus,
            sandbox_lifecycle,
            candidate_policy,
            allow_all_tools,
        ) = match experiment.spec.workload.clone() {
            ExperimentWorkload::Script {
                script,
                sandbox_lifecycle,
                candidate_policy,
            } => (
                experiment.spec.hypothesis.clone(),
                mission.provider_name.clone(),
                None,
                build_script_worker_command(&script),
                300,
                512 * 1024,
                None,
                None,
                sandbox_lifecycle,
                candidate_policy,
                false,
            ),
            ExperimentWorkload::AgentTask {
                prompt,
                provider,
                model,
                sandbox_lifecycle,
                candidate_policy,
                timeout_secs,
                allow_all_tools,
            } => {
                let provider_id = provider.unwrap_or_else(|| mission.provider_name.clone());
                let runtime = self
                    .provider_catalog
                    .load_for(&provider_id, mission.posture)?;
                let worker = runtime.worker.ok_or_else(|| {
                    anyhow!(
                        "provider '{}' does not declare a mission worker configuration",
                        provider_id
                    )
                })?;
                let worker_command =
                    build_agent_worker_command(&worker, model.as_deref(), allow_all_tools)?;
                (
                    prompt,
                    provider_id,
                    model,
                    worker_command,
                    timeout_secs.unwrap_or(worker.timeout_secs),
                    worker.max_output_bytes,
                    worker.memory_mib,
                    worker.cpus,
                    sandbox_lifecycle,
                    candidate_policy,
                    allow_all_tools,
                )
            }
        };
        let mut spec = bakudo_core::protocol::AttemptSpec::new(prompt, provider_id.clone());
        spec.attempt_id = bakudo_core::protocol::AttemptId(experiment.id.to_string());
        spec.task_id = bakudo_core::protocol::TaskId(task_id.clone());
        spec.session_id = self.session.session_id.clone();
        spec.model = model.clone();
        spec.repo_root = self.session.repo_root.clone();
        spec.budget.timeout_secs = timeout_secs;
        spec.budget.max_output_bytes = max_output_bytes;
        spec.permissions.allow_all_tools = allow_all_tools;
        spec.sandbox_lifecycle = sandbox_lifecycle;
        spec.candidate_policy = candidate_policy;

        self.host
            .note_task_started_with_label(&task_id, Some(experiment.label.clone()));
        let _ = self
            .event_tx
            .send(SessionEvent::TaskStarted {
                task_id: task_id.clone(),
                provider_id: provider_id.clone(),
                model: model.clone(),
                prompt_summary: experiment.label.clone(),
            })
            .await;
        experiment.status = ExperimentStatus::Running;
        experiment.started_at = Some(Utc::now());
        self.mission_store.upsert_experiment(&experiment).await?;
        let cfg = Arc::new(TaskRunnerConfig {
            abox: self.abox.clone(),
            ledger: self.ledger.clone(),
            data_dir: self.repo_data_dir().join("runs"),
            trace_recorder: self.trace_recorder.clone(),
            worker_command,
            memory_mib,
            cpus,
        });
        let (mut rx, handle) = run_attempt(spec.clone(), cfg).await;
        while let Some(event) = rx.recv().await {
            self.host.note_runner_event(&task_id, &event);
            let _ = self
                .event_tx
                .send(SessionEvent::TaskProgress {
                    task_id: task_id.clone(),
                    event,
                })
                .await;
        }

        let (status, summary, final_state) = match handle.await {
            Ok(Ok(result)) => {
                let mut final_state = state_from_worker_status(&result.status, result.exit_code);
                if result.status == WorkerStatus::Succeeded {
                    match apply_candidate_policy(
                        &task_id,
                        &candidate_policy,
                        &experiment.spec.base_branch,
                        self.session.repo_root.as_deref().map(Path::new),
                        &self.abox,
                        &self.ledger,
                    )
                    .await
                    {
                        Ok(action) => {
                            final_state = state_from_worktree_action(action);
                        }
                        Err(err) => {
                            let _ = self
                                .event_tx
                                .send(SessionEvent::Error(format!(
                                    "Candidate policy error for {task_id}: {err}"
                                )))
                                .await;
                        }
                    }
                }
                let status = worker_status_to_experiment_status(&result.status);
                let patch_path = self
                    .ledger
                    .get(&task_id)
                    .await
                    .and_then(|record| record.worktree_path);
                let summary = ExperimentSummary {
                    exit_code: result.exit_code,
                    duration: Duration::from_millis(result.duration_ms),
                    stdout_tail: trim_tail(&result.stdout, 4096),
                    stderr_tail: trim_tail(&result.stderr, 4096),
                    metrics: extract_metrics(&result.stdout, &experiment.spec.metric_keys),
                    patch_path,
                };
                (status, summary, final_state)
            }
            Ok(Err(err)) => {
                let summary = ExperimentSummary {
                    exit_code: -1,
                    duration: Duration::from_secs(0),
                    stdout_tail: String::new(),
                    stderr_tail: err.to_string(),
                    metrics: serde_json::Map::new(),
                    patch_path: None,
                };
                (
                    ExperimentStatus::Failed,
                    summary,
                    SandboxState::Failed { exit_code: -1 },
                )
            }
            Err(err) => {
                let summary = ExperimentSummary {
                    exit_code: -1,
                    duration: Duration::from_secs(0),
                    stdout_tail: String::new(),
                    stderr_tail: err.to_string(),
                    metrics: serde_json::Map::new(),
                    patch_path: None,
                };
                (
                    ExperimentStatus::Failed,
                    summary,
                    SandboxState::Failed { exit_code: -1 },
                )
            }
        };

        experiment.status = status;
        experiment.finished_at = Some(Utc::now());
        experiment.summary = Some(summary.clone());
        self.mission_store.upsert_experiment(&experiment).await?;
        self.append_provenance(
            experiment.mission_id,
            json!({
                "event": "experiment_finished",
                "at": Utc::now(),
                "experiment_id": experiment.id,
                "label": experiment.label,
                "status": experiment.status,
                "summary": summary,
            }),
        )
        .await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::ExperimentSummary,
                summary: format!("{}: {:?}", experiment.label, experiment.status),
                mission_id: experiment.mission_id,
                experiment_id: Some(experiment.id),
            })
            .await?;
        let Some(mut mission) = self.mission_store.mission(experiment.mission_id).await? else {
            anyhow::bail!("mission '{}' disappeared", experiment.mission_id);
        };
        mission.wallet.mark_finished(1);
        self.mission_store.upsert_mission(&mission).await?;
        self.ledger
            .update_state(&task_id, final_state.clone())
            .await;
        self.host.note_task_finished(&task_id, &final_state);
        let trace_bundle_path = self.trace_recorder.attempt_trace_bundle_path(&task_id);
        self.emit_mission_activity(MissionActivity::WorkerFinished {
            mission_id: experiment.mission_id.to_string(),
            experiment_id: experiment.id.to_string(),
            label: experiment.label.clone(),
            status: experiment.status,
            trace_bundle_path: trace_bundle_path
                .exists()
                .then(|| trace_bundle_path.display().to_string()),
        })
        .await;
        let _ = self
            .event_tx
            .send(SessionEvent::TaskFinished {
                task_id,
                state: final_state,
            })
            .await;
        match self
            .self_tx
            .send(SessionCommand::RefreshMissionWakes {
                mission_id: experiment.mission_id,
            })
            .await
        {
            Ok(()) => {}
            Err(err) => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Failed to queue mission wake refresh: {err}"
                    )))
                    .await;
            }
        }
        self.emit_banner().await;
        Ok(())
    }

    async fn handle_experiment_finished(&self, mission_id: MissionId) -> Result<()> {
        self.evaluate_active_wave(mission_id).await?;
        self.schedule_active_wave(mission_id).await?;
        Ok(())
    }

    async fn schedule_active_wave(&self, mission_id: MissionId) -> Result<()> {
        let Some(wave) = self.mission_store.active_wave(mission_id).await? else {
            return Ok(());
        };
        let Some(mut mission) = self.mission_store.mission(mission_id).await? else {
            return Ok(());
        };
        let experiments = self
            .mission_store
            .experiments_for_mission(mission_id)
            .await?;
        let running = experiments
            .iter()
            .filter(|experiment| {
                wave.experiment_ids.contains(&experiment.id)
                    && experiment.status == ExperimentStatus::Running
            })
            .count() as u32;
        mission.wallet.abox_workers_in_flight = running;
        let effective_limit = wave
            .concurrency_limit
            .min(mission.wallet.concurrent_max)
            .max(1);
        let available_slots = effective_limit.saturating_sub(running);
        let queued: Vec<_> = wave
            .experiment_ids
            .iter()
            .filter_map(|experiment_id| {
                experiments
                    .iter()
                    .find(|experiment| &experiment.id == experiment_id)
                    .filter(|experiment| experiment.status == ExperimentStatus::Queued)
                    .cloned()
            })
            .take(available_slots as usize)
            .collect();
        if queued.is_empty() {
            self.mission_store.upsert_mission(&mission).await?;
            self.emit_banner().await;
            return Ok(());
        }

        mission.wallet.start_workers(queued.len() as u32);
        self.mission_store.upsert_mission(&mission).await?;
        self.emit_banner().await;
        for experiment in queued {
            let core = self.clone();
            tokio::spawn(async move {
                if let Err(err) = core.run_experiment(experiment).await {
                    let _ = core
                        .event_tx
                        .send(SessionEvent::Error(format!(
                            "Experiment failed to run: {err}"
                        )))
                        .await;
                }
            });
        }
        Ok(())
    }

    async fn evaluate_active_wave(&self, mission_id: MissionId) -> Result<()> {
        let Some(mut wave) = self.mission_store.active_wave(mission_id).await? else {
            return Ok(());
        };
        let experiments = self
            .mission_store
            .experiments_for_mission(mission_id)
            .await?;
        let relevant: Vec<_> = wave
            .experiment_ids
            .iter()
            .filter_map(|experiment_id| {
                experiments
                    .iter()
                    .find(|experiment| &experiment.id == experiment_id)
                    .cloned()
            })
            .collect();
        let completed: Vec<_> = relevant
            .iter()
            .filter(|experiment| experiment_is_terminal(experiment.status))
            .cloned()
            .collect();
        let all_complete = completed.len() == wave.experiment_ids.len();
        let any_failed = completed.iter().any(|experiment| {
            matches!(
                experiment.status,
                ExperimentStatus::Failed | ExperimentStatus::Cancelled | ExperimentStatus::Timeout
            )
        });
        let should_wake = !wave.wake_sent
            && match wave.wake_when {
                WakeWhen::AllComplete => all_complete,
                WakeWhen::FirstComplete => !completed.is_empty(),
                WakeWhen::AnyFailure => any_failed || all_complete,
            };
        if should_wake {
            let reason = if any_failed {
                WakeReason::ExperimentFailed
            } else {
                WakeReason::ExperimentsComplete
            };
            if all_complete {
                self.mission_store.clear_active_wave(mission_id).await?;
            } else {
                wave.wake_sent = true;
                wave.updated_at = Utc::now();
                self.mission_store.save_active_wave(&wave).await?;
            }
            self.queue_wake(
                mission_id,
                reason,
                json!({
                    "experiments": completed.iter().map(experiment_payload).collect::<Vec<_>>(),
                }),
                true,
            )
            .await?;
            return Ok(());
        }
        if all_complete {
            self.mission_store.clear_active_wave(mission_id).await?;
        }
        Ok(())
    }

    async fn run_inline_script(
        &self,
        mission: &Mission,
        task_label: &str,
        script: ExperimentScript,
        _abox_profile: Option<&str>,
        timeout_secs: u64,
    ) -> Result<InlineExecOutcome> {
        let task_id = format!("{}-{}", task_label, uuid::Uuid::new_v4());
        let command = script_to_command(&script);
        let mut params = bakudo_core::abox::RunParams::new(task_id, command);
        params.repo = self.session.repo_root.as_ref().map(PathBuf::from);
        params.ephemeral = true;
        params.timeout_secs = Some(timeout_secs);
        params.max_output_bytes = 256 * 1024;
        let start = std::time::Instant::now();
        let result = self.abox.run(&params, |_| {}).await?;
        let _ = mission;
        Ok(InlineExecOutcome {
            exit_code: result.exit_code,
            duration_ms: start.elapsed().as_millis() as u64,
            stdout_tail: trim_tail(&result.stdout, 4096),
            stderr_tail: trim_tail(&result.stderr, 4096),
        })
    }

    fn repo_root(&self) -> PathBuf {
        self.session
            .repo_root
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."))
    }

    fn repo_data_dir(&self) -> PathBuf {
        self.config
            .resolved_repo_data_dir_from_str(self.session.repo_root.as_deref())
    }

    fn provenance_path(&self, mission_id: MissionId) -> PathBuf {
        self.provider_catalog
            .provenance_dir()
            .join(format!("{mission_id}.ndjson"))
    }

    async fn record_tool_call_error(
        &self,
        mission_id: MissionId,
        wake_id: WakeId,
        tool_name: &str,
        tool_args: &Value,
        err: &anyhow::Error,
    ) -> Result<()> {
        let error_text = compact_single_line(&err.to_string());
        self.append_provenance(
            mission_id,
            json!({
                "event": "tool_call_error",
                "at": Utc::now(),
                "wake_id": wake_id,
                "tool": tool_name,
                "arguments": tool_args,
                "error": error_text,
            }),
        )
        .await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::Decision,
                summary: format!("tool_call_error: {tool_name}: {error_text}"),
                mission_id,
                experiment_id: None,
            })
            .await?;
        self.emit_mission_activity(MissionActivity::ToolCallError {
            mission_id: mission_id.to_string(),
            tool: tool_name.to_string(),
            error: error_text,
        })
        .await;
        self.emit_banner().await;
        Ok(())
    }

    async fn append_provenance(&self, mission_id: MissionId, record: Value) -> Result<()> {
        let path = self.provenance_path(mission_id);
        let line = format!("{}\n", serde_json::to_string(&record)?);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
        Ok(())
    }
}

struct InlineExecOutcome {
    exit_code: i32,
    duration_ms: u64,
    stdout_tail: String,
    stderr_tail: String,
}

fn mission_status_is_active(status: MissionStatus) -> bool {
    matches!(
        status,
        MissionStatus::Pending
            | MissionStatus::AwaitingDeliberator
            | MissionStatus::Deliberating
            | MissionStatus::Sleeping
    )
}

fn mission_operator_state_label(banner: &MissionBanner) -> &'static str {
    if mission_blocker_summary(banner).is_some() {
        return "blocked";
    }
    match banner.status {
        MissionStatus::Pending
        | MissionStatus::AwaitingDeliberator
        | MissionStatus::Deliberating => "working",
        MissionStatus::Sleeping => {
            if banner.fleet.active > 0
                || banner.fleet.queued > 0
                || !matches!(banner.wake.state, MissionWakeState::Idle)
                || banner.pending_user_messages > 0
            {
                "working"
            } else {
                "waiting"
            }
        }
        MissionStatus::Completed => "completed",
        MissionStatus::Cancelled => "cancelled",
        MissionStatus::Failed => "failed",
    }
}

fn mission_blocker_summary(banner: &MissionBanner) -> Option<String> {
    if banner.pending_approvals > 0 {
        return Some(format!(
            "{} approval{} pending",
            banner.pending_approvals,
            if banner.pending_approvals == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    if banner.pending_questions > 0 {
        return Some(format!(
            "{} question{} pending",
            banner.pending_questions,
            if banner.pending_questions == 1 {
                ""
            } else {
                "s"
            }
        ));
    }
    None
}

fn mission_wake_summary_line(banner: &MissionBanner) -> Option<String> {
    match banner.wake.state {
        MissionWakeState::Running => Some(match banner.wake.current_reason {
            Some(reason) => format!("running: {}", wake_reason_label(reason)),
            None => "running".to_string(),
        }),
        MissionWakeState::Queued => {
            let prefix = format!(
                "{} wake{} queued",
                banner.wake.queued_count,
                if banner.wake.queued_count == 1 {
                    ""
                } else {
                    "s"
                }
            );
            Some(match banner.wake.current_reason {
                Some(reason) => format!("{prefix}: {}", wake_reason_label(reason)),
                None => prefix,
            })
        }
        MissionWakeState::Idle => None,
    }
}

fn mission_wave_summary_line(banner: &MissionBanner) -> Option<String> {
    let wave = banner.active_wave.as_ref()?;
    let mut summary = format!(
        "{} active, {} queued, {} done, {} failed",
        wave.running, wave.queued, wave.completed, wave.failed
    );
    if wave.wake_sent {
        summary.push_str(", follow-up wake queued");
    } else {
        summary.push_str(&format!(", wake on {}", wake_when_label(wave.wake_when)));
    }
    Some(summary)
}

fn mission_next_action_summary(banner: &MissionBanner) -> &'static str {
    if banner.pending_approvals > 0 {
        return "approve or deny the pending host command";
    }
    if banner.pending_questions > 0 {
        return "answer the pending user question";
    }
    if matches!(banner.wake.state, MissionWakeState::Idle)
        && banner.fleet.active == 0
        && banner.fleet.queued == 0
    {
        return "send steering or /wake the mission";
    }
    "wait for the next mission event"
}

fn mission_terminal_label(status: MissionStatus) -> &'static str {
    match status {
        MissionStatus::Completed => "completed",
        MissionStatus::Cancelled => "cancelled",
        MissionStatus::Failed => "failed",
        MissionStatus::Pending
        | MissionStatus::AwaitingDeliberator
        | MissionStatus::Deliberating
        | MissionStatus::Sleeping => "active",
    }
}

fn short_mission_id(mission_id: &str) -> String {
    mission_id.chars().take(8).collect()
}

fn wake_reason_label(reason: WakeReason) -> &'static str {
    match reason {
        WakeReason::UserMessage => "user message",
        WakeReason::ExperimentsComplete => "experiments complete",
        WakeReason::ExperimentFailed => "experiment failure",
        WakeReason::BudgetWarning => "budget warning",
        WakeReason::BudgetExhausted => "budget exhausted",
        WakeReason::SchedulerTick => "scheduler tick",
        WakeReason::Timeout => "timeout",
        WakeReason::ManualResume => "manual resume",
    }
}

fn wake_when_label(wake_when: WakeWhen) -> &'static str {
    match wake_when {
        WakeWhen::AllComplete => "all complete",
        WakeWhen::FirstComplete => "first complete",
        WakeWhen::AnyFailure => "any failure",
    }
}

fn summarize_wake_banner(
    queued_wakes: &[crate::mission_store::StoredWakeEvent],
    deliberating: bool,
) -> MissionWakeBanner {
    let current_reason = queued_wakes.first().map(|record| record.wake.reason);
    if deliberating {
        return MissionWakeBanner {
            state: MissionWakeState::Running,
            current_reason,
            queued_count: queued_wakes.len().saturating_sub(1),
        };
    }
    if queued_wakes.is_empty() {
        return MissionWakeBanner {
            state: MissionWakeState::Idle,
            current_reason: None,
            queued_count: 0,
        };
    }
    MissionWakeBanner {
        state: MissionWakeState::Queued,
        current_reason,
        queued_count: queued_wakes.len(),
    }
}

fn summarize_active_wave(wave: &ActiveWaveRecord, experiments: &[Experiment]) -> ActiveWaveSummary {
    let mut summary = ActiveWaveSummary {
        total: wave.experiment_ids.len(),
        running: 0,
        queued: 0,
        completed: 0,
        failed: 0,
        concurrency_limit: wave.concurrency_limit,
        wake_when: wave.wake_when,
        wake_sent: wave.wake_sent,
    };

    for experiment in experiments
        .iter()
        .filter(|experiment| wave.experiment_ids.contains(&experiment.id))
    {
        match experiment.status {
            ExperimentStatus::Queued => summary.queued += 1,
            ExperimentStatus::Running => summary.running += 1,
            ExperimentStatus::Succeeded => summary.completed += 1,
            ExperimentStatus::Failed | ExperimentStatus::Cancelled | ExperimentStatus::Timeout => {
                summary.failed += 1;
            }
        }
    }

    summary
}

fn state_from_worker_status(status: &WorkerStatus, exit_code: i32) -> SandboxState {
    match status {
        WorkerStatus::Succeeded => SandboxState::Preserved,
        WorkerStatus::TimedOut => SandboxState::TimedOut,
        WorkerStatus::Failed | WorkerStatus::Cancelled => SandboxState::Failed { exit_code },
    }
}

fn state_from_worktree_action(action: WorktreeAction) -> SandboxState {
    match action {
        WorktreeAction::Merged => SandboxState::Merged,
        WorktreeAction::MergeConflicts(_) => SandboxState::MergeConflicts,
        WorktreeAction::Discarded => SandboxState::Discarded,
        WorktreeAction::Preserved => SandboxState::Preserved,
    }
}

fn hook_action_from_worktree_action(action: &WorktreeAction) -> (HookWorktreeAction, Vec<String>) {
    match action {
        WorktreeAction::Merged => (HookWorktreeAction::Merged, Vec::new()),
        WorktreeAction::MergeConflicts(conflicts) => {
            (HookWorktreeAction::MergeConflicts, conflicts.clone())
        }
        WorktreeAction::Discarded => (HookWorktreeAction::Discarded, Vec::new()),
        WorktreeAction::Preserved => (HookWorktreeAction::Preserved, Vec::new()),
    }
}

fn initial_mission_state(
    goal: &str,
    done_contract: Option<String>,
    constraints: Option<String>,
) -> MissionState {
    let mut mission_state = MissionState::default_layout();
    if let Some(obj) = mission_state.0.as_object_mut() {
        obj.insert("objective".to_string(), json!(goal));
        if let Some(done_contract) = done_contract {
            obj.insert("done_contract".to_string(), json!(done_contract));
        }
        obj.insert(
            "constraints".to_string(),
            json!(constraints.into_iter().collect::<Vec<_>>()),
        );
    }
    mission_state
}

fn initial_mission_plan(
    goal: &str,
    done_contract: Option<&str>,
    constraints: Option<&str>,
) -> String {
    format!(
        "# Mission Plan\n\n## Objective\n{}\n\n## Done Contract\n{}\n\n## Constraints\n{}\n\n## Current Assessment\n- Waiting for the first wake.\n\n## Plan\n- [ ] Read the wake, inspect the mission state, and decide the next step.\n\n## Active Wave\n- None.\n\n## Risks And Unknowns\n- None recorded yet.\n\n## Questions For User\n- None.\n\n## Completion Summary\n- Pending.\n",
        goal.trim(),
        done_contract.unwrap_or("Not yet specified.").trim(),
        constraints.unwrap_or("None recorded.").trim(),
    )
}

impl WakeMcpServer {
    fn current_state(&self) -> WakeStopState {
        self.stop_rx.borrow().clone()
    }

    async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = self.join_handle.await;
    }
}

impl WakeMcpServerState {
    async fn handle_post(&self, headers: HeaderMap, body: Bytes) -> Response {
        if !origin_is_allowed(&headers) {
            return empty_response(StatusCode::FORBIDDEN, None);
        }

        let request = match serde_json::from_slice::<McpRequest>(&body) {
            Ok(request) => request,
            Err(err) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    None,
                    &McpResponse {
                        jsonrpc: "2.0",
                        id: json!(null),
                        result: None,
                        error: Some(RpcError {
                            code: -32700,
                            message: format!("invalid JSON-RPC payload: {err}"),
                        }),
                    },
                );
            }
        };

        if let Err(err) = validate_mcp_headers(&headers, &request) {
            return json_response(
                StatusCode::BAD_REQUEST,
                None,
                &McpResponse {
                    jsonrpc: "2.0",
                    id: request.id.clone().unwrap_or(json!(null)),
                    result: None,
                    error: Some(err),
                },
            );
        }

        if let Some(version) = request.jsonrpc.as_deref() {
            if version != "2.0" {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    None,
                    &McpResponse {
                        jsonrpc: "2.0",
                        id: request.id.clone().unwrap_or(json!(null)),
                        result: None,
                        error: Some(RpcError {
                            code: -32600,
                            message: format!("unsupported jsonrpc version '{version}'"),
                        }),
                    },
                );
            }
        }

        if request.id.is_none() {
            return self.handle_notification(headers, request).await;
        }

        self.handle_request(headers, request).await
    }

    async fn handle_notification(&self, headers: HeaderMap, request: McpRequest) -> Response {
        if request.method == "notifications/initialized" {
            if let Some(mut session) = self.session_from_headers(&headers).await {
                session.initialized = true;
                *self.session.lock().await = Some(session.clone());
                return empty_response(StatusCode::ACCEPTED, Some(&session));
            }
            return empty_response(StatusCode::BAD_REQUEST, None);
        }

        let session = self.session_from_headers(&headers).await;
        empty_response(StatusCode::ACCEPTED, session.as_ref())
    }

    async fn handle_request(&self, headers: HeaderMap, request: McpRequest) -> Response {
        let id = request.id.clone().unwrap_or(json!(null));
        match request.method.as_str() {
            "initialize" => {
                let params: McpInitializeParams =
                    serde_json::from_value(request.params).unwrap_or(McpInitializeParams {
                        protocol_version: None,
                    });
                let protocol_version = params
                    .protocol_version
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| MCP_PROTOCOL_VERSION.to_string());
                let session = McpSessionState {
                    id: uuid::Uuid::new_v4().to_string(),
                    protocol_version,
                    initialized: false,
                };
                *self.session.lock().await = Some(session.clone());
                json_response(
                    StatusCode::OK,
                    Some(&session),
                    &McpResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(json!({
                            "protocolVersion": session.protocol_version,
                            "capabilities": {
                                "tools": {
                                    "listChanged": false,
                                }
                            },
                            "serverInfo": {
                                "name": "bakudo",
                                "version": env!("CARGO_PKG_VERSION"),
                            },
                            "instructions": "Bakudo exposes mission tools for planning, abox work dispatch, host-approved actions, and mission completion. End each wake with `complete_mission` or `suspend`."
                        })),
                        error: None,
                    },
                )
            }
            "ping" => {
                let Some(session) = self.session_from_headers(&headers).await else {
                    return empty_response(StatusCode::BAD_REQUEST, None);
                };
                json_response(
                    StatusCode::OK,
                    Some(&session),
                    &McpResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(json!({})),
                        error: None,
                    },
                )
            }
            "tools/list" => {
                let Some(session) = self.session_from_headers(&headers).await else {
                    return empty_response(StatusCode::BAD_REQUEST, None);
                };
                json_response(
                    StatusCode::OK,
                    Some(&session),
                    &McpResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(json!({
                            "tools": tool_definitions(),
                        })),
                        error: None,
                    },
                )
            }
            "tools/call" => {
                let Some(session) = self.session_from_headers(&headers).await else {
                    return empty_response(StatusCode::BAD_REQUEST, None);
                };
                self.handle_tool_call_request(&session, id, request.params)
                    .await
            }
            other => {
                let session = self.session_from_headers(&headers).await;
                json_response(
                    StatusCode::OK,
                    session.as_ref(),
                    &McpResponse {
                        jsonrpc: "2.0",
                        id,
                        result: None,
                        error: Some(RpcError {
                            code: -32601,
                            message: format!("unsupported MCP method '{other}'"),
                        }),
                    },
                )
            }
        }
    }

    async fn handle_tool_call_request(
        &self,
        session: &McpSessionState,
        id: Value,
        params: Value,
    ) -> Response {
        if self
            .tool_calls_used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < self.tool_call_limit).then_some(count + 1)
            })
            .is_err()
        {
            let message = format!(
                "wake tool-call budget exhausted after {} calls",
                self.tool_call_limit
            );
            let _ = self
                .core
                .append_provenance(
                    self.mission.id,
                    json!({
                        "event": "wake_budget_exhausted",
                        "at": Utc::now(),
                        "wake_id": self.wake.id,
                        "kind": "tool_calls",
                        "limit": self.tool_call_limit,
                    }),
                )
                .await;
            let _ = self
                .core
                .enqueue_wake(
                    self.mission.id,
                    WakeReason::Timeout,
                    json!({
                        "kind": "wake_budget_tool_calls",
                        "limit": self.tool_call_limit,
                    }),
                )
                .await;
            self.update_stop_state(Some(MissionStatus::Sleeping), false, true)
                .await;
            return json_response(
                StatusCode::OK,
                Some(session),
                &McpResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(RpcError {
                        code: -32001,
                        message,
                    }),
                },
            );
        }

        let call: ToolCallParams = match serde_json::from_value(params) {
            Ok(call) => call,
            Err(err) => {
                return json_response(
                    StatusCode::OK,
                    Some(session),
                    &McpResponse {
                        jsonrpc: "2.0",
                        id,
                        result: None,
                        error: Some(RpcError {
                            code: -32602,
                            message: format!("invalid tool call arguments: {err}"),
                        }),
                    },
                );
            }
        };

        let tool_name = call.name.clone();
        let tool_args = call.arguments.clone();
        match self
            .core
            .handle_tool_call(&self.mission, &self.wake, call)
            .await
        {
            Ok(outcome) => {
                if outcome.suspend || outcome.mission_status.is_some() {
                    self.update_stop_state(outcome.mission_status, outcome.suspend, false)
                        .await;
                }
                json_response(
                    StatusCode::OK,
                    Some(session),
                    &McpResponse {
                        jsonrpc: "2.0",
                        id,
                        result: Some(json!({
                            "content": [{
                                "type": "text",
                                "text": serde_json::to_string_pretty(&outcome.payload).unwrap_or_else(|_| "{}".to_string()),
                            }],
                            "structuredContent": outcome.payload,
                            "isError": false,
                        })),
                        error: None,
                    },
                )
            }
            Err(err) => {
                let _ = self
                    .core
                    .record_tool_call_error(
                        self.mission.id,
                        self.wake.id,
                        &tool_name,
                        &tool_args,
                        &err,
                    )
                    .await;
                json_response(
                    StatusCode::OK,
                    Some(session),
                    &McpResponse {
                        jsonrpc: "2.0",
                        id,
                        result: None,
                        error: Some(RpcError {
                            code: -32000,
                            message: err.to_string(),
                        }),
                    },
                )
            }
        }
    }

    async fn session_from_headers(&self, headers: &HeaderMap) -> Option<McpSessionState> {
        let session_id = headers.get("mcp-session-id")?.to_str().ok()?;
        let session = self.session.lock().await.clone()?;
        if session.id == session_id {
            Some(session)
        } else {
            None
        }
    }

    async fn update_stop_state(
        &self,
        desired_status: Option<MissionStatus>,
        saw_suspend: bool,
        forced_stop: bool,
    ) {
        let mut next = self.stop_tx.borrow().clone();
        next.desired_status = desired_status.or(next.desired_status);
        next.saw_suspend |= saw_suspend;
        next.forced_stop |= forced_stop;
        let _ = self.stop_tx.send(next);
    }
}

async fn wake_mcp_post(
    State(state): State<Arc<WakeMcpServerState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    state.handle_post(headers, body).await
}

async fn wake_mcp_get(
    State(_state): State<Arc<WakeMcpServerState>>,
    headers: HeaderMap,
) -> Response {
    if !origin_is_allowed(&headers) {
        return empty_response(StatusCode::FORBIDDEN, None);
    }
    let mut response = empty_response(StatusCode::METHOD_NOT_ALLOWED, None);
    response
        .headers_mut()
        .insert(ALLOW, HeaderValue::from_static("POST, DELETE"));
    response
}

async fn wake_mcp_delete(
    State(state): State<Arc<WakeMcpServerState>>,
    headers: HeaderMap,
) -> Response {
    if !origin_is_allowed(&headers) {
        return empty_response(StatusCode::FORBIDDEN, None);
    }
    let session = state.session_from_headers(&headers).await;
    *state.session.lock().await = None;
    empty_response(StatusCode::NO_CONTENT, session.as_ref())
}

fn build_deliberator_prompt(system_prompt: &str, wake: &WakeEvent) -> Result<String> {
    let wake_json = serde_json::to_string_pretty(wake)?;
    Ok(format!(
        "{system_prompt}\n\nBakudo has already attached the mission MCP server for this wake. Use the available Bakudo tools directly; do not invent a custom transport or print JSON-RPC by hand.\n\nWake contract reminders:\n- `WakeEvent` is the source of truth for why you were resumed and what is already in flight.\n- `mission_plan.md` is operator-facing orientation; keep it concise and current.\n- `MissionState` is durable hand-off state; keep it compact, factual, and current.\n- Prefer `abox` work (`dispatch_swarm`, `abox_exec`, `abox_apply_patch`) for repo changes and verification.\n- Use `host_exec` only for real host-boundary actions that cannot happen inside `abox`.\n- End the wake with `complete_mission(...)` or `suspend(...)`, not both.\n\nCurrent WakeEvent JSON:\n{wake_json}\n"
    ))
}

fn tool_definitions() -> Vec<McpToolDefinition> {
    vec![
        McpToolDefinition {
            name: "read_plan",
            description: "Read mission_plan.md from durable mission storage.",
            input_schema: empty_object_schema(),
        },
        McpToolDefinition {
            name: "update_plan",
            description: "Replace mission_plan.md and record why it changed.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string" },
                    "reason": { "type": "string" },
                },
                "required": ["markdown", "reason"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "notify_user",
            description: "Send a non-blocking mission update to the user transcript.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string" },
                },
                "required": ["message"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "ask_user",
            description: "Prompt the user for a blocking decision.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "question": { "type": "string" },
                    "choices": {
                        "type": "array",
                        "items": { "type": "string" },
                    },
                },
                "required": ["question"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "complete_mission",
            description: "Record the completion summary and finish the mission.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "summary": { "type": "string" },
                },
                "required": ["summary"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "read_experiment_summary",
            description: "Read the stored summary and trace bundle path for an experiment.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "experiment_id": { "type": "string" },
                },
                "required": ["experiment_id"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "dispatch_swarm",
            description: "Dispatch a batch of abox experiments. Each experiment item must declare kind:\"script\" with script:{...} or kind:\"agent_task\" with prompt:\"...\". Script workers default to ephemeral/discard unless you request a preserved worktree policy.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "experiments": {
                        "type": "array",
                        "items": dispatch_experiment_schema(),
                    },
                    "concurrency_hint": {
                        "type": "integer",
                        "minimum": 1,
                    },
                    "wake_when": {
                        "type": "string",
                        "enum": ["all_complete", "first_complete", "any_failure"],
                    },
                },
                "required": ["experiments"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "abox_exec",
            description: "Run a one-off shell snippet inside an abox. Pass script as a plain string, not a tagged object.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "script": {
                        "type": "string",
                        "description": "Shell snippet run with bash -lc inside the abox workspace.",
                    },
                    "abox_profile": { "type": "string" },
                    "timeout_secs": { "type": "integer", "minimum": 1 },
                },
                "required": ["script"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "abox_apply_patch",
            description: "Apply a patch in an abox and verify it with a plain shell snippet.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "patch": { "type": "string" },
                    "verify": {
                        "type": "string",
                        "description": "Shell snippet run with bash -lc after the patch is applied.",
                    },
                    "abox_profile": { "type": "string" },
                },
                "required": ["patch", "verify"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "host_exec",
            description: "Run an approval-gated command on the host.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "reason": { "type": "string" },
                },
                "required": ["command", "reason"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "cancel_experiments",
            description: "Cancel running experiments.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "experiment_ids": {
                        "type": "array",
                        "items": { "type": "string" },
                    },
                    "reason": { "type": "string" },
                },
                "required": ["experiment_ids"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "update_mission_state",
            description: "Apply a JSON merge patch to the Mission State.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "patch": {},
                },
                "required": ["patch"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "record_lesson",
            description: "Persist a durable lesson.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                },
                "required": ["title", "body"],
                "additionalProperties": false,
            }),
        },
        McpToolDefinition {
            name: "suspend",
            description: "Suspend the current wake.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "reason": { "type": "string" },
                    "expected_wake": { "type": "string" },
                },
                "additionalProperties": false,
            }),
        },
    ]
}

fn empty_object_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
}

fn experiment_script_schema() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "inline" },
                    "source": { "type": "string" },
                },
                "required": ["kind", "source"],
                "additionalProperties": false,
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "const": "file" },
                    "path": { "type": "string" },
                },
                "required": ["kind", "path"],
                "additionalProperties": false,
            }
        ]
    })
}

fn dispatch_experiment_schema() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "description": "Script experiment. The script field must be an object, not a JSON-encoded string. Script workers default to ephemeral/discard unless you explicitly request a preserved worktree policy.",
                "properties": {
                    "label": { "type": "string" },
                    "hypothesis": { "type": "string" },
                    "skill": { "type": "string" },
                    "base_branch": { "type": "string" },
                    "metric_keys": {
                        "type": "array",
                        "items": { "type": "string" },
                    },
                    "kind": { "type": "string", "const": "script" },
                    "script": experiment_script_schema(),
                    "sandbox_lifecycle": {
                        "type": "string",
                        "enum": ["ephemeral", "preserved"],
                    },
                    "candidate_policy": {
                        "type": "string",
                        "enum": ["auto_apply", "discard", "review"],
                    },
                },
                "required": ["label", "hypothesis", "kind", "script"],
                "additionalProperties": false,
            },
            {
                "type": "object",
                "description": "Provider-backed agent worker. Put prompt and policy fields directly on the experiment item. Do not nest them under workload or agent_task, and do not JSON-encode this object as a string.",
                "properties": {
                    "label": { "type": "string" },
                    "hypothesis": { "type": "string" },
                    "skill": { "type": "string" },
                    "base_branch": { "type": "string" },
                    "metric_keys": {
                        "type": "array",
                        "items": { "type": "string" },
                    },
                    "kind": { "type": "string", "const": "agent_task" },
                    "prompt": {
                        "type": "string",
                        "description": "The worker task instruction. This field is named prompt, not task."
                    },
                    "provider": { "type": "string" },
                    "model": { "type": "string" },
                    "sandbox_lifecycle": {
                        "type": "string",
                        "enum": ["ephemeral", "preserved"],
                    },
                    "candidate_policy": {
                        "type": "string",
                        "enum": ["auto_apply", "discard", "review"],
                    },
                    "timeout_secs": { "type": "integer", "minimum": 1 },
                    "allow_all_tools": { "type": "boolean" },
                },
                "required": ["label", "hypothesis", "kind", "prompt"],
                "additionalProperties": false,
            }
        ]
    })
}

fn validate_mcp_headers(
    headers: &HeaderMap,
    request: &McpRequest,
) -> std::result::Result<(), RpcError> {
    if let Some(method_header) = headers
        .get("mcp-method")
        .and_then(|value| value.to_str().ok())
    {
        if method_header != request.method {
            return Err(RpcError {
                code: -32001,
                message: format!(
                    "Header mismatch: Mcp-Method header value '{method_header}' does not match body value '{}'",
                    request.method
                ),
            });
        }
    }

    if request.method == "tools/call" {
        if let Some(name_header) = headers
            .get("mcp-name")
            .and_then(|value| value.to_str().ok())
        {
            let body_name = request
                .params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if name_header != body_name {
                return Err(RpcError {
                    code: -32001,
                    message: format!(
                        "Header mismatch: Mcp-Name header value '{name_header}' does not match body value '{body_name}'"
                    ),
                });
            }
        }
    }

    Ok(())
}

fn origin_is_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    origin == "null"
        || origin.starts_with("http://127.0.0.1")
        || origin.starts_with("http://localhost")
        || origin.starts_with("https://127.0.0.1")
        || origin.starts_with("https://localhost")
}

fn empty_response(status: StatusCode, session: Option<&McpSessionState>) -> Response {
    let mut response = status.into_response();
    attach_mcp_headers(response.headers_mut(), session);
    response
}

fn json_response(
    status: StatusCode,
    session: Option<&McpSessionState>,
    body: &McpResponse,
) -> Response {
    match serde_json::to_vec(body) {
        Ok(payload) => {
            let mut response = (status, payload).into_response();
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            attach_mcp_headers(response.headers_mut(), session);
            response
        }
        Err(err) => {
            warn!("failed to serialize MCP response: {err}");
            empty_response(StatusCode::INTERNAL_SERVER_ERROR, session)
        }
    }
}

fn attach_mcp_headers(headers: &mut HeaderMap, session: Option<&McpSessionState>) {
    headers.insert(
        HeaderName::from_static("mcp-protocol-version"),
        HeaderValue::from_static(MCP_PROTOCOL_VERSION),
    );
    if let Some(session) = session {
        if let Ok(value) = HeaderValue::from_str(&session.id) {
            headers.insert(HeaderName::from_static("mcp-session-id"), value);
        }
        if let Ok(value) = HeaderValue::from_str(&session.protocol_version) {
            headers.insert(HeaderName::from_static("mcp-protocol-version"), value);
        }
    }
}

fn script_to_command(script: &ExperimentScript) -> Vec<String> {
    match script {
        ExperimentScript::Inline { source } => {
            vec!["bash".to_string(), "-lc".to_string(), source.clone()]
        }
        ExperimentScript::File { path } => vec!["bash".to_string(), path.clone()],
    }
}

fn worker_status_to_experiment_status(status: &WorkerStatus) -> ExperimentStatus {
    match status {
        WorkerStatus::Succeeded => ExperimentStatus::Succeeded,
        WorkerStatus::TimedOut => ExperimentStatus::Timeout,
        WorkerStatus::Failed | WorkerStatus::Cancelled => ExperimentStatus::Failed,
    }
}

fn experiment_is_terminal(status: ExperimentStatus) -> bool {
    matches!(
        status,
        ExperimentStatus::Succeeded
            | ExperimentStatus::Failed
            | ExperimentStatus::Cancelled
            | ExperimentStatus::Timeout
    )
}

fn mission_status_is_terminal(status: MissionStatus) -> bool {
    matches!(
        status,
        MissionStatus::Completed | MissionStatus::Cancelled | MissionStatus::Failed
    )
}

fn compact_single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn render_tool_issue_summary(summary: &str) -> String {
    summary
        .strip_prefix("tool_call_error: ")
        .unwrap_or(summary)
        .to_string()
}

fn experiment_payload(experiment: &Experiment) -> Value {
    json!({
        "id": experiment.id,
        "label": experiment.label,
        "status": experiment.status,
        "summary": experiment.summary,
    })
}

fn experiment_task_id(experiment_id: ExperimentId) -> String {
    bakudo_core::abox::sandbox_task_id(&experiment_id.to_string())
}

fn parse_experiment_id(value: &str) -> Result<ExperimentId> {
    Ok(ExperimentId(uuid::Uuid::parse_str(value)?))
}

fn trim_tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    text[text.len().saturating_sub(max_bytes)..].to_string()
}

fn truncate(text: &str) -> String {
    text.chars().take(160).collect()
}

fn extract_metrics(stdout: &str, metric_keys: &[String]) -> serde_json::Map<String, Value> {
    let mut metrics = serde_json::Map::new();
    if metric_keys.is_empty() {
        return metrics;
    }
    for line in stdout.lines().rev() {
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line.trim()) {
            for key in metric_keys {
                if let Some(value) = obj.get(key) {
                    metrics.insert(key.clone(), value.clone());
                }
            }
            if !metrics.is_empty() {
                break;
            }
        }
    }
    metrics
}

fn patch_apply_script(patch: &str, verify: &str) -> String {
    format!(
        "set -euo pipefail\ncat > /tmp/bakudo.patch <<'PATCH'\n{patch}\nPATCH\ngit apply /tmp/bakudo.patch\n{verify}\n"
    )
}

fn slugify(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn merge_patch(target: &mut Value, patch: Value) {
    match patch {
        Value::Object(patch_obj) => {
            if !target.is_object() {
                *target = json!({});
            }
            let target_obj = target.as_object_mut().expect("target coerced to object");
            for (key, value) in patch_obj {
                if value.is_null() {
                    target_obj.remove(&key);
                } else {
                    match target_obj.get_mut(&key) {
                        Some(existing) => merge_patch(existing, value),
                        None => {
                            target_obj.insert(key, value);
                        }
                    }
                }
            }
        }
        other => *target = other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    use bakudo_core::abox::AboxAdapter;
    use bakudo_core::config::BakudoConfig;
    use bakudo_core::mission::{MissionState, Posture, WakeEvent, WakeId, WakeReason, Wallet};
    use bakudo_core::protocol::SessionId;
    use bakudo_core::provider::ProviderRegistry;
    use bakudo_core::session::SessionRecord;
    use bakudo_core::state::SandboxLedger;
    use chrono::Utc;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn build_deliberator_command_preapproves_bakudo_mcp_tools_for_codex() {
        let dir = TempDir::new("bakudo-session-controller-codex");
        let config = Arc::new(BakudoConfig {
            data_dir: Some(dir.path.join("data")),
            ..Default::default()
        });
        let ledger = Arc::new(SandboxLedger::new());
        let abox = Arc::new(AboxAdapter::new("/bin/true"));
        let registry = Arc::new(ProviderRegistry::with_defaults());
        let (self_tx, cmd_rx) = mpsc::channel(4);
        let (event_tx, _event_rx) = mpsc::channel(4);
        let controller = SessionController::with_session(
            config,
            abox,
            ledger,
            registry,
            SessionBootstrap {
                session: SessionRecord::with_id(
                    SessionId("session-codex".to_string()),
                    "codex",
                    None,
                    Some(dir.path.display().to_string()),
                ),
                resume_only: false,
            },
            self_tx,
            cmd_rx,
            event_tx,
        );
        let provider = crate::provider_runtime::ProviderRuntimeConfig {
            name: "codex-mission".to_string(),
            engine: ProviderEngine::Codex,
            posture: Posture::Mission,
            engine_args: vec!["exec".to_string()],
            allow_all_tools: true,
            abox_profile: "dev-broad".to_string(),
            system_prompt_file: dir.path.join("mission.md"),
            wake_budget: crate::provider_runtime::WakeBudget::default(),
            env: Default::default(),
            worker: None,
        };

        let (_binary, args, mcp_launch) = controller
            .mission_core()
            .build_deliberator_command(
                &provider,
                MissionId(Uuid::new_v4()),
                WakeId(Uuid::new_v4()),
                "mission prompt",
                "http://127.0.0.1:7777/mcp",
            )
            .await
            .unwrap();

        assert!(args.iter().any(|arg| arg == "--ignore-user-config"));
        assert!(args
            .iter()
            .any(|arg| arg == "mcp_servers.bakudo.url=\"http://127.0.0.1:7777/mcp\""));
        assert!(args
            .iter()
            .any(|arg| { arg == "mcp_servers.bakudo.default_tools_approval_mode=\"approve\"" }));
        assert_eq!(mcp_launch["tool_approval_mode"], "approve");
    }

    #[test]
    fn deliberator_prompt_includes_wake_contract_reminders() {
        let wake = WakeEvent {
            id: WakeId(Uuid::new_v4()),
            mission_id: MissionId(Uuid::new_v4()),
            reason: WakeReason::ManualResume,
            created_at: Utc::now(),
            payload: json!({"demo": true}),
            mission_state: MissionState::default_layout(),
            wallet: Wallet::default(),
            user_inbox: Vec::new(),
            recent_ledger: Vec::new(),
        };

        let prompt = build_deliberator_prompt("system prompt", &wake).unwrap();

        assert!(prompt.contains("Wake contract reminders"));
        assert!(prompt.contains("mission_plan.md"));
        assert!(prompt.contains("MissionState"));
        assert!(prompt.contains("Prefer `abox` work"));
        assert!(prompt.contains("Current WakeEvent JSON"));
    }

    #[test]
    fn dispatch_swarm_schema_documents_agent_task_shape() {
        let schema = dispatch_experiment_schema();
        let agent_task = &schema["oneOf"][1];
        let description = agent_task["description"]
            .as_str()
            .expect("dispatch_swarm agent_task description");
        assert!(description.contains("Do not nest"));
        assert!(description.contains("JSON-encode this object as a string"));
        assert_eq!(agent_task["properties"]["kind"]["const"], "agent_task");
        assert_eq!(agent_task["properties"]["prompt"]["type"], "string");
        assert!(agent_task["properties"]["prompt"]["description"]
            .as_str()
            .expect("prompt description")
            .contains("named prompt, not task"));
    }

    #[test]
    fn dispatch_swarm_schema_documents_script_policy_shape() {
        let schema = dispatch_experiment_schema();
        let script = &schema["oneOf"][0];
        let description = script["description"]
            .as_str()
            .expect("dispatch_swarm script description");
        assert!(description.contains("ephemeral/discard"));
        assert_eq!(script["properties"]["kind"]["const"], "script");
        assert_eq!(
            script["properties"]["candidate_policy"]["enum"][0],
            "auto_apply"
        );
    }

    #[test]
    fn dispatch_swarm_args_accept_flat_agent_task_shape() {
        let args: DispatchSwarmArgs = serde_json::from_value(json!({
            "experiments": [{
                "label": "fix",
                "hypothesis": "one worker can fix it",
                "kind": "agent_task",
                "prompt": "Fix the daemon",
                "candidate_policy": "auto_apply",
                "allow_all_tools": true
            }]
        }))
        .expect("flat dispatch_swarm args should parse");

        assert_eq!(args.experiments.len(), 1);
        let experiment = &args.experiments[0];
        assert!(matches!(experiment.kind, DispatchExperimentKind::AgentTask));
        assert_eq!(experiment.prompt.as_deref(), Some("Fix the daemon"));
        assert_eq!(
            experiment.candidate_policy,
            Some(CandidatePolicy::AutoApply)
        );
        assert_eq!(experiment.allow_all_tools, Some(true));
    }

    #[test]
    fn dispatch_swarm_args_accept_script_policy_shape() {
        let args: DispatchSwarmArgs = serde_json::from_value(json!({
            "experiments": [{
                "label": "script-fix",
                "hypothesis": "one script worker can land a deterministic patch",
                "kind": "script",
                "script": {"kind": "inline", "source": "printf OK\\n > smoke.txt"},
                "sandbox_lifecycle": "preserved",
                "candidate_policy": "auto_apply"
            }]
        }))
        .expect("script dispatch_swarm args should parse");

        assert_eq!(args.experiments.len(), 1);
        let experiment = &args.experiments[0];
        assert!(matches!(experiment.kind, DispatchExperimentKind::Script));
        assert_eq!(
            experiment.sandbox_lifecycle,
            Some(SandboxLifecycle::Preserved)
        );
        assert_eq!(
            experiment.candidate_policy,
            Some(CandidatePolicy::AutoApply)
        );
    }

    #[test]
    fn abox_exec_args_accept_plain_script_string() {
        let args: AboxExecArgs = serde_json::from_value(json!({
            "script": "printf OK",
            "timeout_secs": 30,
        }))
        .expect("abox_exec string args should parse");

        assert_eq!(args.script, "printf OK");
        assert_eq!(args.timeout_secs, Some(30));
    }

    #[test]
    fn abox_apply_patch_args_accept_plain_verify_string() {
        let args: AboxApplyPatchArgs = serde_json::from_value(json!({
            "patch": "--- a/x\n+++ b/x\n@@\n-old\n+new\n",
            "verify": "test -f x",
        }))
        .expect("abox_apply_patch string args should parse");

        assert_eq!(args.verify, "test -f x");
    }
}
