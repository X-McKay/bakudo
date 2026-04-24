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
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::sync::{oneshot, Mutex};
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
use crate::mission_store::{ActiveWaveRecord, MissionStore};
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
    pub wall_clock_remaining_secs: u64,
    pub abox_workers_remaining: u32,
    pub abox_workers_in_flight: u32,
    pub concurrent_max: u32,
    pub pending_user_messages: usize,
    pub fleet: FleetCounts,
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
    pending_approvals: HashMap<String, oneshot::Sender<HostExecResolution>>,
    pending_questions: HashMap<String, oneshot::Sender<String>>,
    deliberating: HashSet<MissionId>,
    wake_user_message_ids: HashMap<WakeId, Vec<i64>>,
    next_agent_wave_approved: bool,
}

struct HostExecResolution {
    approved: bool,
    edited_command: Option<String>,
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

#[derive(Debug, serde::Deserialize)]
struct RpcRequest {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, serde::Serialize)]
struct RpcResponse {
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
    workload: DispatchExperimentWorkload,
    #[serde(default)]
    metric_keys: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DispatchExperimentWorkload {
    Script {
        script: ExperimentScript,
    },
    AgentTask {
        prompt: String,
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
    },
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct AboxExecArgs {
    script: ExperimentScript,
    #[serde(default)]
    abox_profile: Option<String>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
struct AboxApplyPatchArgs {
    patch: String,
    verify: ExperimentScript,
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
        {
            let mut state = self.runtime_state.lock().await;
            if state.active_mission_id.is_none() {
                state.active_mission_id = missions.first().map(|mission| mission.id);
            }
        }

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
            mission.status = MissionStatus::AwaitingDeliberator;
            self.mission_store.upsert_mission(&mission).await?;
            self.host
                .mark_mission_started(&mission.id.to_string(), &mission.goal, mission.posture);
            self.evaluate_active_wave(mission.id).await?;
            self.schedule_active_wave(mission.id).await?;
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
            wall_clock_remaining_secs: mission.wallet.wall_clock_remaining.as_secs(),
            abox_workers_remaining: mission.wallet.abox_workers_remaining,
            abox_workers_in_flight: mission.wallet.abox_workers_in_flight,
            concurrent_max: mission.wallet.concurrent_max,
            pending_user_messages,
            fleet,
        }))
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
        {
            let mut state = self.runtime_state.lock().await;
            state.active_mission_id = Some(mission.id);
        }
        self.host
            .mark_mission_started(&mission.id.to_string(), &mission.goal, posture);
        self.emit_banner().await;
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
        let message = UserMessage {
            at: Utc::now(),
            text: text.clone(),
            urgent,
        };
        self.mission_store
            .enqueue_user_message(mission_id, &message)
            .await?;
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::UserSteering,
                summary: text.clone(),
                mission_id,
                experiment_id: None,
            })
            .await?;
        self.emit_banner().await;
        self.queue_wake(
            mission_id,
            WakeReason::UserMessage,
            json!({ "text": text, "urgent": urgent }),
            true,
        )
        .await?;
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
            state.pending_approvals.remove(&request_id)
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
        let tx = {
            let mut state = self.runtime_state.lock().await;
            state.pending_questions.remove(&request_id)
        };
        let Some(tx) = tx else {
            anyhow::bail!("unknown question request '{}'", request_id);
        };
        let _ = tx.send(answer);
        Ok(())
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
                self.host.mark_mission_completed(&mission.id.to_string());
            }
            self.mission_store.upsert_mission(&mission).await?;
            self.emit_banner().await;
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
        let (binary, mut args) = match provider.engine {
            ProviderEngine::Exec => {
                let (first, rest) = provider.engine_args.split_first().ok_or_else(|| {
                    anyhow!("exec provider '{}' is missing engine_args", provider.name)
                })?;
                (first.clone(), rest.to_vec())
            }
            engine => (engine.binary().to_string(), provider.engine_args.clone()),
        };
        args.push(deliberator_prompt.clone());

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
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("BAKUDO_WAKE_EVENT_PATH", &wake_path)
            .env("BAKUDO_SYSTEM_PROMPT_PATH", &provider.system_prompt_file)
            .env("BAKUDO_MISSION_ID", mission.id.to_string())
            .env("BAKUDO_POSTURE", mission.posture.to_string())
            .env("BAKUDO_MCP_TRANSPORT", "stdio");
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
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("missing deliberator stdin"))?;
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

        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut desired_status = None;
        let mut saw_suspend = false;
        let deadline = tokio::time::Instant::now() + provider.wake_budget.wall_clock;
        let mut tool_calls_used = 0_u32;
        let mut forced_stop = false;
        loop {
            let next_line = match tokio::time::timeout_at(deadline, stdout_lines.next_line()).await
            {
                Ok(result) => result?,
                Err(_) => {
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
            };
            let Some(line) = next_line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<RpcRequest>(trimmed) {
                Ok(request) => {
                    let id = request.id.clone().unwrap_or(json!(null));
                    if request.method == "tools/call"
                        && tool_calls_used >= provider.wake_budget.tool_calls
                    {
                        let message = format!(
                            "wake tool-call budget exhausted after {} calls",
                            provider.wake_budget.tool_calls
                        );
                        let response = RpcResponse {
                            jsonrpc: "2.0",
                            id,
                            result: None,
                            error: Some(RpcError {
                                code: -32001,
                                message: message.clone(),
                            }),
                        };
                        stdin
                            .write_all(serde_json::to_string(&response)?.as_bytes())
                            .await?;
                        stdin.write_all(b"\n").await?;
                        stdin.flush().await?;
                        self.append_provenance(
                            mission.id,
                            json!({
                                "event": "wake_budget_exhausted",
                                "at": Utc::now(),
                                "wake_id": wake.id,
                                "kind": "tool_calls",
                                "limit": provider.wake_budget.tool_calls,
                            }),
                        )
                        .await?;
                        self.enqueue_wake(
                            mission.id,
                            WakeReason::Timeout,
                            json!({
                                "kind": "wake_budget_tool_calls",
                                "limit": provider.wake_budget.tool_calls,
                            }),
                        )
                        .await?;
                        desired_status = Some(MissionStatus::Sleeping);
                        forced_stop = true;
                        break;
                    }
                    if request.method == "tools/call" {
                        tool_calls_used = tool_calls_used.saturating_add(1);
                    }
                    match self.handle_rpc_request(mission, wake, request).await {
                        Ok(outcome) => {
                            let response = RpcResponse {
                                jsonrpc: "2.0",
                                id,
                                result: Some(outcome.payload),
                                error: None,
                            };
                            stdin
                                .write_all(serde_json::to_string(&response)?.as_bytes())
                                .await?;
                            stdin.write_all(b"\n").await?;
                            stdin.flush().await?;
                            if let Some(status) = outcome.mission_status {
                                desired_status = Some(status);
                            }
                            if outcome.suspend {
                                saw_suspend = true;
                                break;
                            }
                        }
                        Err(err) => {
                            let response = RpcResponse {
                                jsonrpc: "2.0",
                                id,
                                result: None,
                                error: Some(RpcError {
                                    code: -32000,
                                    message: err.to_string(),
                                }),
                            };
                            stdin
                                .write_all(serde_json::to_string(&response)?.as_bytes())
                                .await?;
                            stdin.write_all(b"\n").await?;
                            stdin.flush().await?;
                        }
                    }
                }
                Err(_) => {
                    self.trace_recorder
                        .append_wake_stdout(mission.id, wake.id, trimmed)
                        .await;
                    let _ = self
                        .event_tx
                        .send(SessionEvent::Info(format!(
                            "[mission {}] {}",
                            mission.id, trimmed
                        )))
                        .await;
                }
            }
        }

        if forced_stop {
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
        } else {
            let status = child.wait().await?;
            if !status.success() {
                desired_status = Some(MissionStatus::Failed);
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

    async fn handle_rpc_request(
        &self,
        mission: &Mission,
        wake: &WakeEvent,
        request: RpcRequest,
    ) -> Result<ToolCallOutcome> {
        match request.method.as_str() {
            "initialize" => Ok(ToolCallOutcome {
                payload: json!({
                    "server_info": { "name": "bakudo", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "tools": true }
                }),
                suspend: false,
                mission_status: None,
            }),
            "tools/list" => Ok(ToolCallOutcome {
                payload: json!({ "tools": tool_list_value() }),
                suspend: false,
                mission_status: None,
            }),
            "tools/call" => {
                let call: ToolCallParams = serde_json::from_value(request.params)?;
                let tool_name = call.name.clone();
                let tool_args = call.arguments.clone();
                match self.handle_tool_call(mission, wake, call).await {
                    Ok(outcome) => Ok(outcome),
                    Err(err) => {
                        let _ = self
                            .append_provenance(
                                mission.id,
                                json!({
                                    "event": "tool_call_error",
                                    "at": Utc::now(),
                                    "wake_id": wake.id,
                                    "tool": tool_name,
                                    "arguments": tool_args,
                                    "error": err.to_string(),
                                }),
                            )
                            .await;
                        Err(err)
                    }
                }
            }
            other => anyhow::bail!("unsupported rpc method '{}'", other),
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
                let workload = match spec.workload {
                    DispatchExperimentWorkload::Script { script } => {
                        ExperimentWorkload::Script { script }
                    }
                    DispatchExperimentWorkload::AgentTask {
                        prompt,
                        provider,
                        model,
                        sandbox_lifecycle,
                        candidate_policy,
                        timeout_secs,
                        allow_all_tools,
                    } => {
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
                    label: spec.label,
                    spec: bakudo_core::mission::ExperimentSpec {
                        base_branch: spec
                            .base_branch
                            .unwrap_or_else(|| self.config.base_branch.clone()),
                        workload,
                        skill: spec.skill,
                        hypothesis: spec.hypothesis,
                        metric_keys: spec.metric_keys,
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
                args.script,
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
        let script = ExperimentScript::Inline {
            source: patch_apply_script(&args.patch, &args.verify),
        };
        let inner = self
            .tool_abox_exec(
                mission,
                wake,
                serde_json::to_value(AboxExecArgs {
                    script,
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
            state.pending_approvals.insert(request_id.clone(), tx);
        }
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
        {
            let mut state = self.runtime_state.lock().await;
            state.pending_questions.insert(request_id.clone(), tx);
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
        let answer = rx.await.unwrap_or_default();
        self.mission_store
            .append_ledger(&LedgerEntry {
                at: Utc::now(),
                kind: LedgerKind::UserSteering,
                summary: format!("ask_user: {}", answer),
                mission_id: mission.id,
                experiment_id: None,
            })
            .await?;
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
        Ok(json!({
            "wallet": mission.wallet,
            "fleet": {
                "active": experiments.iter().filter(|experiment| experiment.status == ExperimentStatus::Running).count(),
                "queued": experiments.iter().filter(|experiment| experiment.status == ExperimentStatus::Queued).count(),
                "completed_this_mission": experiments.iter().filter(|experiment| experiment.status == ExperimentStatus::Succeeded).count(),
                "failed_this_mission": experiments.iter().filter(|experiment| matches!(experiment.status, ExperimentStatus::Failed | ExperimentStatus::Cancelled | ExperimentStatus::Timeout)).count(),
            },
            "pending_user_messages": pending_user_messages,
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
            ExperimentWorkload::Script { script } => (
                experiment.spec.hypothesis.clone(),
                mission.provider_name.clone(),
                None,
                build_script_worker_command(&script),
                300,
                512 * 1024,
                None,
                None,
                SandboxLifecycle::Ephemeral,
                CandidatePolicy::Discard,
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

fn build_deliberator_prompt(system_prompt: &str, wake: &WakeEvent) -> Result<String> {
    let wake_json = serde_json::to_string_pretty(wake)?;
    Ok(format!(
        "{system_prompt}\n\nTool transport:\n- Use line-delimited JSON-RPC over stdio.\n- Write exactly one JSON object per line to stdout.\n- Read exactly one JSON response line per request from stdin.\n- Start by calling `initialize`, then `tools/list`.\n- Call tools with `tools/call` and params `{{\"name\": ..., \"arguments\": ...}}`.\n- Do not wrap JSON in Markdown fences.\n- End this wake with `complete_mission` or `suspend`.\n\nExamples:\n{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{{}}}}\n{{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{{\"name\":\"read_plan\",\"arguments\":{{}}}}}}\n\nCurrent WakeEvent JSON:\n{wake_json}\n"
    ))
}

fn tool_list_value() -> Vec<Value> {
    vec![
        json!({"name": "read_plan", "description": "Read mission_plan.md from durable mission storage."}),
        json!({"name": "update_plan", "description": "Replace mission_plan.md and record why it changed."}),
        json!({"name": "notify_user", "description": "Send a non-blocking mission update to the user transcript."}),
        json!({"name": "ask_user", "description": "Prompt the user for a blocking decision."}),
        json!({"name": "complete_mission", "description": "Record the completion summary and finish the mission."}),
        json!({"name": "read_experiment_summary", "description": "Read the stored summary and trace bundle path for an experiment."}),
        json!({"name": "dispatch_swarm", "description": "Dispatch a batch of abox experiments."}),
        json!({"name": "abox_exec", "description": "Run a one-off command inside an abox."}),
        json!({"name": "abox_apply_patch", "description": "Apply a patch in an abox and verify it."}),
        json!({"name": "host_exec", "description": "Run an approved command on the host."}),
        json!({"name": "update_mission_state", "description": "Apply a JSON merge patch to the Mission State."}),
        json!({"name": "record_lesson", "description": "Persist a durable lesson."}),
        json!({"name": "cancel_experiments", "description": "Cancel running experiments."}),
        json!({"name": "suspend", "description": "Suspend the current wake."}),
    ]
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

fn patch_apply_script(patch: &str, verify: &ExperimentScript) -> String {
    let verify_cmd = match verify {
        ExperimentScript::Inline { source } => source.clone(),
        ExperimentScript::File { path } => format!("bash {}", shell_escape(path)),
    };
    format!(
        "set -euo pipefail\ncat > /tmp/bakudo.patch <<'PATCH'\n{patch}\nPATCH\ngit apply /tmp/bakudo.patch\n{verify_cmd}\n"
    )
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
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
