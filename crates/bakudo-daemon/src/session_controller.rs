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
use bakudo_core::protocol::WorkerStatus;
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::session::SessionRecord;
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};

use crate::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
use crate::worktree::{apply_candidate_policy, WorktreeAction};

/// Commands sent from the TUI to the session controller.
#[derive(Debug)]
pub enum SessionCommand {
    /// Dispatch a new task with the current provider/model.
    Dispatch { prompt: String },
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
                SessionCommand::Dispatch { prompt } => {
                    self.dispatch_task(prompt).await;
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

    async fn dispatch_task(&self, prompt: String) {
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

        let mut spec = self.config.build_attempt_spec(
            &prompt,
            &self.current_provider,
            self.current_model.clone(),
            self.repo_path().map(|p| p.to_string_lossy().to_string()),
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

        let worker_cmd = provider.build_worker_command(self.current_model.as_deref(), true);

        let cfg = Arc::new(TaskRunnerConfig {
            abox: self.abox.clone(),
            ledger: self.ledger.clone(),
            data_dir: self.config.resolved_data_dir().join("runs"),
            worker_command: worker_cmd,
            memory_mib: provider.memory_mib,
            cpus: provider.cpus,
        });

        let event_tx = self.event_tx.clone();
        let ledger = self.ledger.clone();
        let abox = self.abox.clone();
        let base_branch = self.config.base_branch.clone();
        let repo = self.repo_path();
        let candidate_policy = spec.candidate_policy;
        let tid = task_id.clone();

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

            let final_state = match handle.await {
                Ok(Ok(result)) => {
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
                            Ok(action) => state_from_worktree_action(action),
                            Err(e) => {
                                let _ = event_tx
                                    .send(SessionEvent::Error(format!(
                                        "Candidate policy error for {tid}: {e}"
                                    )))
                                    .await;
                                ledger
                                    .get(&tid)
                                    .await
                                    .map(|record| record.state)
                                    .unwrap_or(SandboxState::Preserved)
                            }
                        }
                    } else {
                        state_from_worker_status(&result.status, result.exit_code)
                    }
                }
                Ok(Err(e)) => {
                    warn!("Task {tid} failed before producing a final result: {e}");
                    SandboxState::Failed { exit_code: -1 }
                }
                Err(e) => {
                    let _ = event_tx
                        .send(SessionEvent::Error(format!(
                            "Task join error for {tid}: {e}"
                        )))
                        .await;
                    SandboxState::Failed { exit_code: -1 }
                }
            };

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
            Ok(_) => {
                let _ = self
                    .event_tx
                    .send(SessionEvent::TaskFinished {
                        task_id: task_id.to_string(),
                        state: SandboxState::Merged,
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
