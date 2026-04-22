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
use bakudo_core::protocol::{
    AttemptBudget, AttemptPermissions, AttemptSpec, CandidatePolicy, SandboxLifecycle,
};
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::session::SessionRecord;
use bakudo_core::state::SandboxLedger;

use crate::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
use crate::worktree::{apply_candidate_policy, WorktreeAction};

/// Commands sent from the TUI to the session controller.
#[derive(Debug)]
pub enum SessionCommand {
    /// Dispatch a new task with the current provider/model.
    Dispatch { prompt: String },
    /// Change the active provider.
    SetProvider { provider_id: String },
    /// Change the active model.
    SetModel { model: String },
    /// Apply (merge) a preserved worktree.
    Apply { task_id: String },
    /// Discard a preserved worktree.
    Discard { task_id: String },
    /// Show divergence summary for a preserved worktree.
    Diverge { task_id: String },
    /// Shut down the session.
    Shutdown,
}

/// Events emitted by the session controller to the TUI.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// A new task was dispatched.
    TaskStarted { task_id: String, prompt_summary: String },
    /// A progress event from a running task.
    TaskProgress { task_id: String, event: RunnerEvent },
    /// A task finished.
    TaskFinished { task_id: String, action: String },
    /// Provider changed.
    ProviderChanged { provider_id: String, model: String },
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
    current_model: String,
    cmd_rx: mpsc::Receiver<SessionCommand>,
    event_tx: mpsc::Sender<SessionEvent>,
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
        let session = SessionRecord::new(&current_provider, &current_model);
        Self {
            session,
            config,
            abox,
            ledger,
            registry,
            current_provider,
            current_model,
            cmd_rx,
            event_tx,
        }
    }

    /// Run the session event loop. This should be spawned as a tokio task.
    pub async fn run(mut self) {
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
                    let _ = self.event_tx.send(SessionEvent::ProviderChanged {
                        provider_id: self.current_provider.clone(),
                        model,
                    }).await;
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
                SessionCommand::Shutdown => {
                    let _ = self.event_tx.send(SessionEvent::Shutdown).await;
                    break;
                }
            }
        }
    }

    async fn reconcile_on_startup(&self) {
        match self.abox.list(self.repo_path().as_deref()).await {
            Ok(entries) => {
                self.ledger.reconcile(&entries).await;
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
                let _ = self.event_tx.send(SessionEvent::Error(format!(
                    "Unknown provider '{}'", self.current_provider
                ))).await;
                return;
            }
        };

        let mut spec = AttemptSpec::new(&prompt, &self.current_provider);
        spec.session_id = self.session.session_id.clone();
        spec.model = self.current_model.clone();
        spec.repo_root = self.repo_path().map(|p| p.to_string_lossy().to_string());
        spec.budget = AttemptBudget {
            timeout_secs: self.config.timeout_secs,
            ..Default::default()
        };
        spec.permissions = AttemptPermissions { allow_all_tools: true };
        spec.sandbox_lifecycle = match self.config.sandbox_lifecycle.as_str() {
            "ephemeral" => SandboxLifecycle::Ephemeral,
            _ => SandboxLifecycle::Preserved,
        };
        spec.candidate_policy = match self.config.candidate_policy.as_str() {
            "auto_apply" => CandidatePolicy::AutoApply,
            "discard" => CandidatePolicy::Discard,
            _ => CandidatePolicy::Review,
        };

        let task_id = bakudo_core::abox::sandbox_task_id(&spec.attempt_id.0);
        let prompt_summary: String = prompt.chars().take(80).collect();

        let _ = self.event_tx.send(SessionEvent::TaskStarted {
            task_id: task_id.clone(),
            prompt_summary: prompt_summary.clone(),
        }).await;

        let worker_cmd = vec![
            provider.binary.clone(),
        ]
        .into_iter()
        .chain(provider.build_args(&self.current_model, true))
        .collect::<Vec<_>>();

        let cfg = Arc::new(TaskRunnerConfig {
            abox: self.abox.clone(),
            ledger: self.ledger.clone(),
            data_dir: self.config.resolved_data_dir().join("runs"),
            worker_command: worker_cmd,
        });

        let event_tx = self.event_tx.clone();
        let ledger = self.ledger.clone();
        let abox = self.abox.clone();
        let base_branch = self.config.base_branch.clone();
        let repo = self.repo_path();
        let candidate_policy = spec.candidate_policy.clone();
        let tid = task_id.clone();

        let (mut rx, _handle) = run_attempt(spec, cfg).await;

        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                let is_finished = matches!(&event, RunnerEvent::Finished(_));
                let _ = event_tx.send(SessionEvent::TaskProgress {
                    task_id: tid.clone(),
                    event: event.clone(),
                }).await;

                if is_finished {
                    // Apply the candidate policy.
                    match apply_candidate_policy(
                        &tid,
                        &candidate_policy,
                        &base_branch,
                        repo.as_deref(),
                        &abox,
                        &ledger,
                    ).await {
                        Ok(action) => {
                            let action_str = match &action {
                                WorktreeAction::Merged => "merged".to_string(),
                                WorktreeAction::MergeConflicts(c) => format!("conflicts: {}", c.len()),
                                WorktreeAction::Discarded => "discarded".to_string(),
                                WorktreeAction::Preserved => "preserved".to_string(),
                            };
                            let _ = event_tx.send(SessionEvent::TaskFinished {
                                task_id: tid.clone(),
                                action: action_str,
                            }).await;
                        }
                        Err(e) => {
                            let _ = event_tx.send(SessionEvent::Error(format!(
                                "Candidate policy error for {tid}: {e}"
                            ))).await;
                        }
                    }
                    break;
                }
            }
        });
    }

    async fn set_provider(&mut self, provider_id: String) {
        if self.registry.get(&provider_id).is_none() {
            let _ = self.event_tx.send(SessionEvent::Error(format!(
                "Unknown provider '{provider_id}'"
            ))).await;
            return;
        }
        self.current_provider = provider_id.clone();
        let _ = self.event_tx.send(SessionEvent::ProviderChanged {
            provider_id,
            model: self.current_model.clone(),
        }).await;
    }

    async fn apply_worktree(&self, task_id: &str) {
        match crate::worktree::manual_apply(
            task_id,
            &self.config.base_branch,
            self.repo_path().as_deref(),
            &self.abox,
            &self.ledger,
        ).await {
            Ok(_) => {
                let _ = self.event_tx.send(SessionEvent::TaskFinished {
                    task_id: task_id.to_string(),
                    action: "merged".to_string(),
                }).await;
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
        ).await {
            Ok(_) => {
                let _ = self.event_tx.send(SessionEvent::TaskFinished {
                    task_id: task_id.to_string(),
                    action: "discarded".to_string(),
                }).await;
            }
            Err(e) => {
                let _ = self.event_tx.send(SessionEvent::Error(e.to_string())).await;
            }
        }
    }

    async fn show_divergence(&self, task_id: &str) {
        match self.abox.divergence(self.repo_path().as_deref(), task_id).await {
            Ok(summary) => {
                let msg = if summary.is_empty() {
                    format!("[{task_id}] No divergence (worktree matches base branch).")
                } else {
                    format!("[{task_id}] Divergence:\n{summary}")
                };
                let _ = self.event_tx.send(SessionEvent::Error(msg)).await;
            }
            Err(e) => {
                let _ = self.event_tx.send(SessionEvent::Error(format!(
                    "Divergence check failed for {task_id}: {e}"
                ))).await;
            }
        }
    }

    fn repo_path(&self) -> Option<PathBuf> {
        // Try to detect the repo root from the current directory.
        std::env::current_dir().ok()
    }
}
