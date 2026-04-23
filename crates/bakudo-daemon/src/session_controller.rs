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

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::mpsc;
use tracing::{info, warn};

use bakudo_core::abox::AboxAdapter;
use bakudo_core::config::BakudoConfig;
use bakudo_core::control::{save_run_summary, update_run_summary_outcome, RunSummary};
use bakudo_core::hook::{HookWorktreeAction, PostRunHookPayload};
use bakudo_core::policy::PolicyDecision;
use bakudo_core::protocol::WorkerStatus;
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::session::SessionRecord;
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};

use crate::hooks::run_post_run_hook;
use crate::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
use crate::worktree::{apply_candidate_policy, WorktreeAction};

/// Commands sent from the TUI to the session controller.
#[derive(Debug)]
pub enum SessionCommand {
    /// Dispatch a new task with the current provider/model.
    Dispatch { prompt: String, approved: bool },
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
    /// Shut down the session.
    Shutdown,
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
    current_provider: String,
    current_model: Option<String>,
    resume_only: bool,
    cmd_rx: mpsc::Receiver<SessionCommand>,
    event_tx: mpsc::Sender<SessionEvent>,
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
            cmd_rx,
            event_tx,
        )
    }

    pub fn with_session(
        config: Arc<BakudoConfig>,
        abox: Arc<AboxAdapter>,
        ledger: Arc<SandboxLedger>,
        registry: Arc<ProviderRegistry>,
        bootstrap: SessionBootstrap,
        cmd_rx: mpsc::Receiver<SessionCommand>,
        event_tx: mpsc::Sender<SessionEvent>,
    ) -> Self {
        let SessionBootstrap {
            session,
            resume_only,
        } = bootstrap;
        let current_provider = session.provider_id.clone();
        let current_model = session.model.clone();
        Self {
            session,
            config,
            abox,
            ledger,
            registry,
            current_provider,
            current_model,
            resume_only,
            cmd_rx,
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

        while let Some(cmd) = self.cmd_rx.recv().await {
            match cmd {
                SessionCommand::Dispatch { prompt, approved } => {
                    self.dispatch_task(prompt, approved).await;
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

    async fn dispatch_task(&self, prompt: String, approved: bool) {
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
                return;
            }
        };

        let execution_decision = self
            .config
            .execution_policy
            .evaluate(&self.current_provider);
        match execution_decision.decision {
            PolicyDecision::Forbid => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Execution policy forbids provider '{}'.",
                        self.current_provider
                    )))
                    .await;
                return;
            }
            PolicyDecision::Prompt if !approved => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::Error(format!(
                        "Execution policy requires approval before running '{}'. Use /approve, then resubmit the task.",
                        self.current_provider
                    )))
                    .await;
                return;
            }
            PolicyDecision::Allow | PolicyDecision::Prompt => {}
        }

        let mut spec = self.config.build_attempt_spec(
            &prompt,
            &self.current_provider,
            self.current_model.clone(),
            self.repo_path().map(|p| p.to_string_lossy().to_string()),
            execution_decision.allow_all_tools,
            self.config.candidate_policy,
            self.config.sandbox_lifecycle,
        );
        spec.session_id = self.session.session_id.clone();

        let task_id = bakudo_core::abox::sandbox_task_id(&spec.attempt_id.0);
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

        let (mut rx, handle) = run_attempt(spec, cfg).await;

        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
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
                            provider_id,
                            model,
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
        });
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

    fn persist_session(&self) -> Result<(), bakudo_core::error::SessionError> {
        self.session.save(&self.config.resolved_data_dir())
    }
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
