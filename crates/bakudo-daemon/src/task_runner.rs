//! Task runner — dispatches a single AttemptSpec to an abox VM and streams
//! progress events back to the caller.
//!
//! The runner:
//!   1. Builds the abox RunParams from the AttemptSpec.
//!   2. Writes the AttemptSpec JSON to a temp file in the data dir.
//!   3. Invokes `abox run` with the worker bootstrap command.
//!   4. Parses BAKUDO_EVENT / BAKUDO_RESULT / BAKUDO_ERROR lines from stdout.
//!   5. Updates the SandboxLedger as the VM transitions through states.
//!   6. Returns a WorkerResult when the VM exits.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use chrono::Utc;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use bakudo_core::abox::{sandbox_task_id, AboxAdapter, RunParams};
use bakudo_core::error::BakudoError;
use bakudo_core::protocol::{
    AttemptSpec, WorkerProgressEvent, WorkerResult, WorkerStatus,
    WORKER_ERROR_PREFIX, WORKER_EVENT_PREFIX, WORKER_RESULT_PREFIX,
};
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};

/// Events emitted by the task runner to the TUI / session controller.
#[derive(Debug, Clone)]
pub enum RunnerEvent {
    /// A structured progress event from the worker.
    Progress(WorkerProgressEvent),
    /// A raw stdout line that wasn't a structured event.
    RawLine(String),
    /// The run completed.
    Finished(WorkerResult),
    /// The run failed at the infrastructure level (abox error, not agent error).
    InfraError(String),
}

/// Configuration for a single task run.
pub struct TaskRunnerConfig {
    pub abox: Arc<AboxAdapter>,
    pub ledger: Arc<SandboxLedger>,
    pub data_dir: PathBuf,
    /// The bootstrap command to run inside the VM.
    /// Typically: ["bakudo-worker"] or a shell script path.
    pub worker_command: Vec<String>,
}

/// Run a single attempt. Returns a channel receiver for streaming events.
/// The returned handle can be awaited to get the final WorkerResult.
pub async fn run_attempt(
    spec: AttemptSpec,
    cfg: Arc<TaskRunnerConfig>,
) -> (
    mpsc::Receiver<RunnerEvent>,
    tokio::task::JoinHandle<Result<WorkerResult, BakudoError>>,
) {
    let (tx, rx) = mpsc::channel::<RunnerEvent>(256);
    let handle = tokio::spawn(run_attempt_inner(spec, cfg, tx));
    (rx, handle)
}

async fn run_attempt_inner(
    spec: AttemptSpec,
    cfg: Arc<TaskRunnerConfig>,
    tx: mpsc::Sender<RunnerEvent>,
) -> Result<WorkerResult, BakudoError> {
    let task_id = sandbox_task_id(&spec.attempt_id.0);
    let start = Instant::now();

    // Write the spec to a temp file so the worker can read it.
    let spec_path = cfg.data_dir.join(format!("{}.spec.json", task_id));
    let spec_json = serde_json::to_string(&spec)?;
    tokio::fs::create_dir_all(&cfg.data_dir).await?;
    tokio::fs::write(&spec_path, &spec_json).await?;

    // Register in the ledger.
    let record = SandboxRecord {
        attempt_id: spec.attempt_id.clone(),
        session_id: spec.session_id.clone(),
        task_id: task_id.clone(),
        provider_id: spec.provider_id.clone(),
        model: spec.model.clone(),
        prompt_summary: spec.prompt.chars().take(120).collect(),
        state: SandboxState::Starting,
        lifecycle: spec.sandbox_lifecycle.clone(),
        candidate_policy: spec.candidate_policy.clone(),
        started_at: Utc::now(),
        finished_at: None,
        worktree_path: None,
        branch: None,
    };
    cfg.ledger.insert(record).await;
    cfg.ledger.update_state(&task_id, SandboxState::Running).await;

    info!("Starting task {task_id} with provider '{}'", spec.provider_id);

    // Build the abox run params.
    let mut command = cfg.worker_command.clone();
    // Pass the spec file path as an env var so the worker can find it.
    let env_vars = vec![
        ("BAKUDO_SPEC_PATH".to_string(), spec_path.to_string_lossy().to_string()),
        ("BAKUDO_TASK_ID".to_string(), task_id.clone()),
    ];

    let params = RunParams {
        task_id: task_id.clone(),
        command,
        repo: spec.repo_root.as_deref().map(PathBuf::from),
        ephemeral: spec.sandbox_lifecycle == bakudo_core::protocol::SandboxLifecycle::Ephemeral,
        memory_mib: None, // will be overridden by provider spec if set
        cpus: None,
        timeout_secs: Some(spec.budget.timeout_secs),
        env_vars,
    };

    let tx_clone = tx.clone();
    let run_result = cfg
        .abox
        .run(&params, move |line| {
            let line = line.to_string();
            let event = parse_worker_line(&line);
            let _ = tx_clone.try_send(event);
        })
        .await;

    let duration_ms = start.elapsed().as_millis() as u64;

    // Clean up the spec file.
    let _ = tokio::fs::remove_file(&spec_path).await;

    match run_result {
        Ok(run) => {
            let status = if run.timed_out {
                WorkerStatus::TimedOut
            } else if run.exit_code == 0 {
                WorkerStatus::Succeeded
            } else {
                WorkerStatus::Failed
            };

            let new_state = match &status {
                WorkerStatus::Succeeded => SandboxState::Preserved,
                WorkerStatus::TimedOut => SandboxState::TimedOut,
                _ => SandboxState::Failed { exit_code: run.exit_code },
            };
            cfg.ledger.update_state(&task_id, new_state).await;

            let result = WorkerResult {
                schema_version: bakudo_core::protocol::PROTOCOL_SCHEMA_VERSION,
                attempt_id: spec.attempt_id,
                session_id: spec.session_id,
                task_id: spec.task_id,
                status,
                summary: extract_summary(&run.stdout),
                finished_at: Utc::now(),
                exit_code: run.exit_code,
                duration_ms,
                timed_out: run.timed_out,
                stdout: run.stdout.clone(),
                stderr: run.stderr.clone(),
                stdout_truncated: run.stdout.len() >= spec.budget.max_output_bytes,
                stderr_truncated: false,
            };

            let _ = tx.send(RunnerEvent::Finished(result.clone())).await;
            Ok(result)
        }
        Err(e) => {
            cfg.ledger
                .update_state(&task_id, SandboxState::Failed { exit_code: -1 })
                .await;
            let msg = e.to_string();
            let _ = tx.send(RunnerEvent::InfraError(msg.clone())).await;
            Err(e.into())
        }
    }
}

/// Parse a single stdout line from the worker process.
fn parse_worker_line(line: &str) -> RunnerEvent {
    if let Some(json) = line.strip_prefix(WORKER_EVENT_PREFIX).map(|s| s.trim()) {
        match serde_json::from_str::<WorkerProgressEvent>(json) {
            Ok(event) => return RunnerEvent::Progress(event),
            Err(e) => warn!("Failed to parse worker event: {e}: {json}"),
        }
    }
    if let Some(json) = line.strip_prefix(WORKER_RESULT_PREFIX).map(|s| s.trim()) {
        match serde_json::from_str::<WorkerResult>(json) {
            Ok(result) => return RunnerEvent::Finished(result),
            Err(e) => warn!("Failed to parse worker result: {e}: {json}"),
        }
    }
    if let Some(msg) = line.strip_prefix(WORKER_ERROR_PREFIX).map(|s| s.trim()) {
        return RunnerEvent::InfraError(msg.to_string());
    }
    RunnerEvent::RawLine(line.to_string())
}

/// Extract a one-line summary from the worker's stdout.
fn extract_summary(stdout: &str) -> String {
    // Look for the last non-empty line as the summary.
    stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("(no output)")
        .chars()
        .take(200)
        .collect()
}
