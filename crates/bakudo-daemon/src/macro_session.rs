//! Macro-orchestration session — coordinates multiple concurrent objectives.
//!
//! A macro session is the long-lived orchestrator that manages multiple
//! concurrent user objectives (each of which may have multiple attempts).
//!
//! Key responsibilities:
//!   - Accept new objectives from the session controller.
//!   - Enforce a concurrency limit (max active sandboxes).
//!   - Track the wallet (token/cost budget) across all active objectives.
//!   - Emit aggregated events to the TUI.
//!
//! Wallet reservation uses a tokio Semaphore to prevent races: each objective
//! acquires a permit before dispatching, and releases it when the objective
//! completes.

use std::sync::Arc;

use tokio::sync::{mpsc, Semaphore};
use tracing::{info, warn};

use bakudo_core::abox::AboxAdapter;
use bakudo_core::config::BakudoConfig;
use bakudo_core::protocol::AttemptSpec;
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::state::SandboxLedger;

use crate::objective::{run_objective, RetryPolicy};
use crate::session_controller::SessionEvent;
use crate::task_runner::TaskRunnerConfig;

/// Default maximum number of concurrently running sandboxes.
const DEFAULT_MAX_CONCURRENT: usize = 4;

/// A new objective submitted to the macro session.
pub struct ObjectiveRequest {
    pub spec: AttemptSpec,
    pub retry_policy: RetryPolicy,
}

/// The macro-orchestration session.
pub struct MacroSession {
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    ledger: Arc<SandboxLedger>,
    registry: Arc<ProviderRegistry>,
    /// Semaphore controlling maximum concurrent sandboxes.
    concurrency_limit: Arc<Semaphore>,
    event_tx: mpsc::Sender<SessionEvent>,
}

impl MacroSession {
    pub fn new(
        config: Arc<BakudoConfig>,
        abox: Arc<AboxAdapter>,
        ledger: Arc<SandboxLedger>,
        registry: Arc<ProviderRegistry>,
        event_tx: mpsc::Sender<SessionEvent>,
    ) -> Self {
        Self {
            config,
            abox,
            ledger,
            registry,
            concurrency_limit: Arc::new(Semaphore::new(DEFAULT_MAX_CONCURRENT)),
            event_tx,
        }
    }

    /// Submit a new objective. Returns immediately; the objective runs in the
    /// background. Blocks until a concurrency slot is available.
    pub async fn submit(&self, req: ObjectiveRequest) {
        let permit = match self.concurrency_limit.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => {
                warn!("Concurrency semaphore closed");
                return;
            }
        };

        let provider = match self.registry.get(&req.spec.provider_id) {
            Some(p) => p.clone(),
            None => {
                let _ = self.event_tx.send(crate::session_controller::SessionEvent::Error(
                    format!("Unknown provider '{}'", req.spec.provider_id)
                )).await;
                return;
            }
        };

        let worker_cmd: Vec<String> = std::iter::once(provider.binary.clone())
            .chain(provider.build_args(&req.spec.model, true))
            .collect();

        let cfg = Arc::new(TaskRunnerConfig {
            abox: self.abox.clone(),
            ledger: self.ledger.clone(),
            data_dir: self.config.resolved_data_dir().join("runs"),
            worker_command: worker_cmd,
        });

        let event_tx = self.event_tx.clone();
        let spec = req.spec;
        let retry_policy = req.retry_policy;

        tokio::spawn(async move {
            run_objective(spec, retry_policy, cfg, event_tx).await;
            // Release the concurrency slot when the objective completes.
            drop(permit);
        });

        info!("Objective submitted. Active slots: {}/{}", DEFAULT_MAX_CONCURRENT - self.concurrency_limit.available_permits(), DEFAULT_MAX_CONCURRENT);
    }

    /// Number of currently active objectives.
    pub fn active_count(&self) -> usize {
        DEFAULT_MAX_CONCURRENT - self.concurrency_limit.available_permits()
    }
}
