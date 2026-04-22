//! Objective controller — manages multi-attempt retry logic for a single
//! user objective.
//!
//! An objective is a high-level user goal. It may require multiple attempts
//! (retries) to complete, e.g. if the first attempt times out or the agent
//! fails to produce a clean result.
//!
//! The objective controller:
//!   1. Accepts a prompt and a retry policy.
//!   2. Dispatches attempts via the task runner.
//!   3. Evaluates the result of each attempt.
//!   4. Retries up to `max_attempts` times if the attempt fails.
//!   5. Applies the candidate policy on success.
//!   6. Emits events to the session controller.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tracing::{info, warn};

use bakudo_core::protocol::{AttemptSpec, WorkerStatus};

use crate::session_controller::SessionEvent;
use crate::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
use crate::worktree::apply_candidate_policy;

/// Retry policy for an objective.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum number of attempts (including the first).
    pub max_attempts: u32,
    /// Delay between retries.
    pub retry_delay: Duration,
    /// Whether to retry on timeout.
    pub retry_on_timeout: bool,
    /// Whether to retry on agent failure (non-zero exit code).
    pub retry_on_failure: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            retry_delay: Duration::from_secs(5),
            retry_on_timeout: true,
            retry_on_failure: false,
        }
    }
}

/// Run an objective with retry logic.
pub async fn run_objective(
    spec: AttemptSpec,
    retry_policy: RetryPolicy,
    cfg: Arc<TaskRunnerConfig>,
    event_tx: mpsc::Sender<SessionEvent>,
    base_branch: String,
) {
    let base_spec = spec;
    let mut attempt_num = 0u32;

    loop {
        attempt_num += 1;
        let mut attempt_spec = base_spec.clone();
        // Give each retry a fresh attempt ID so abox creates a new worktree.
        attempt_spec.attempt_id = bakudo_core::protocol::AttemptId::new();

        let task_id = bakudo_core::abox::sandbox_task_id(&attempt_spec.attempt_id.0);
        info!(
            "Objective attempt {}/{}: task_id={}",
            attempt_num, retry_policy.max_attempts, task_id
        );

        let (mut rx, handle) = run_attempt(attempt_spec.clone(), cfg.clone()).await;

        // Forward progress events.
        let mut final_result = None;
        while let Some(event) = rx.recv().await {
            match &event {
                RunnerEvent::Finished(r) => {
                    final_result = Some(r.clone());
                }
                RunnerEvent::InfraError(e) => {
                    let _ = event_tx.send(SessionEvent::Error(format!(
                        "[attempt {attempt_num}] infra error: {e}"
                    ))).await;
                }
                _ => {}
            }
            let _ = event_tx.send(SessionEvent::TaskProgress {
                task_id: task_id.clone(),
                event,
            }).await;
        }

        let result = match final_result {
            Some(r) => r,
            None => {
                warn!("No result from attempt {attempt_num}");
                break;
            }
        };

        let should_retry = match result.status {
            WorkerStatus::Succeeded => false,
            WorkerStatus::TimedOut => retry_policy.retry_on_timeout,
            WorkerStatus::Failed => retry_policy.retry_on_failure,
            WorkerStatus::Cancelled => false,
        };

        // Ensure the spawned task is cleaned up regardless of outcome.
        let _ = handle.await;

        if !should_retry || attempt_num >= retry_policy.max_attempts {
            // Apply candidate policy.
            let abox = cfg.abox.clone();
            let ledger = cfg.ledger.clone();
            match apply_candidate_policy(
                &task_id,
                &attempt_spec.candidate_policy,
                &base_branch,
                None,
                &abox,
                &ledger,
            ).await {
                Ok(action) => {
                    let action_str = format!("{:?}", action);
                    let _ = event_tx.send(SessionEvent::TaskFinished {
                        task_id: task_id.clone(),
                        action: action_str,
                    }).await;
                }
                Err(e) => {
                    let _ = event_tx.send(SessionEvent::Error(e.to_string())).await;
                }
            }
            break;
        }

        info!(
            "Retrying objective after {:?} (attempt {}/{})",
            retry_policy.retry_delay, attempt_num, retry_policy.max_attempts
        );
        tokio::time::sleep(retry_policy.retry_delay).await;
    }
}
