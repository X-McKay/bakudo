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
use std::sync::{Arc as StdArc, Mutex};
use std::time::Instant;

use chrono::Utc;
use serde_json::json;
use tokio::sync::mpsc;
use tracing::{info, warn};

use bakudo_core::abox::{sandbox_task_id, AboxAdapter, RunParams};
use bakudo_core::error::BakudoError;
use bakudo_core::protocol::{
    AttemptSpec, SandboxLifecycle, TaskId, WorkerProgressEvent, WorkerResult, WorkerStatus,
    WORKER_ERROR_PREFIX, WORKER_EVENT_PREFIX, WORKER_RESULT_PREFIX, WORKER_SUMMARY_PREFIX,
};
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};

use crate::trace::TraceRecorder;

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
    pub trace_recorder: TraceRecorder,
    /// The bootstrap command to run inside the VM.
    /// Typically: ["python3", "-c", <wrapper>, <provider-binary>, ...].
    pub worker_command: Vec<String>,
    /// Optional provider-specific sandbox sizing overrides.
    pub memory_mib: Option<u32>,
    pub cpus: Option<u8>,
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
    let spec_for_trace = spec.clone();
    cfg.trace_recorder
        .record_attempt_start(
            &task_id,
            &json!({
                "captured_at": Utc::now(),
                "attempt_spec": spec.clone(),
                "worker_command": cfg.worker_command.clone(),
                "memory_mib": cfg.memory_mib,
                "cpus": cfg.cpus,
            }),
        )
        .await;

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
        repo_root: spec.repo_root.clone(),
        provider_id: spec.provider_id.clone(),
        model: spec.model.clone(),
        prompt_summary: spec.prompt.chars().take(120).collect(),
        state: SandboxState::Starting,
        lifecycle: spec.sandbox_lifecycle,
        candidate_policy: spec.candidate_policy,
        started_at: Utc::now(),
        finished_at: None,
        worktree_path: None,
        branch: None,
    };
    cfg.ledger.insert(record).await;
    cfg.ledger
        .update_state(&task_id, SandboxState::Running)
        .await;

    info!(
        "Starting task {task_id} with provider '{}'",
        spec.provider_id
    );

    // Build the abox run params.
    let command = cfg.worker_command.clone();
    // Pass the spec file path as an env var so the worker can find it.
    let mut env_vars = vec![
        (
            "BAKUDO_SPEC_PATH".to_string(),
            spec_path.to_string_lossy().to_string(),
        ),
        ("BAKUDO_ATTEMPT_ID".to_string(), spec.attempt_id.0.clone()),
        ("BAKUDO_SESSION_ID".to_string(), spec.session_id.0.clone()),
        ("BAKUDO_TASK_ID".to_string(), task_id.clone()),
        ("BAKUDO_PROMPT".to_string(), spec.prompt.clone()),
        ("BAKUDO_PROVIDER".to_string(), spec.provider_id.clone()),
        (
            "BAKUDO_PROTOCOL_SCHEMA_VERSION".to_string(),
            bakudo_core::protocol::PROTOCOL_SCHEMA_VERSION.to_string(),
        ),
        (
            "BAKUDO_HEARTBEAT_INTERVAL_MS".to_string(),
            spec.budget.heartbeat_interval_ms.to_string(),
        ),
    ];
    if let Some(m) = spec.model.as_ref() {
        env_vars.push(("BAKUDO_MODEL".to_string(), m.clone()));
    }

    let params = RunParams {
        task_id: task_id.clone(),
        command,
        repo: spec.repo_root.as_deref().map(PathBuf::from),
        ephemeral: spec.sandbox_lifecycle == SandboxLifecycle::Ephemeral,
        memory_mib: cfg.memory_mib,
        cpus: cfg.cpus,
        timeout_secs: Some(spec.budget.timeout_secs),
        max_output_bytes: spec.budget.max_output_bytes,
        env_vars,
    };

    let tx_clone = tx.clone();
    let structured_result: StdArc<Mutex<Option<WorkerResult>>> = StdArc::new(Mutex::new(None));
    let structured_result_cb = structured_result.clone();
    let trace_recorder = cfg.trace_recorder.clone();
    let task_id_for_trace = task_id.clone();
    let run_result = cfg
        .abox
        .run(&params, move |line| {
            let line = line.to_string();
            let trace_line = line.clone();
            let trace_recorder = trace_recorder.clone();
            let task_id = task_id_for_trace.clone();
            tokio::spawn(async move {
                trace_recorder
                    .append_attempt_stream(&task_id, "stdout", &trace_line)
                    .await;
            });
            match parse_worker_line(&line) {
                RunnerEvent::Finished(result) => {
                    *structured_result_cb
                        .lock()
                        .expect("worker result mutex poisoned") = Some(result);
                }
                event => {
                    let _ = tx_clone.try_send(event);
                }
            }
        })
        .await;

    let duration_ms = start.elapsed().as_millis() as u64;

    // Clean up the spec file.
    let _ = tokio::fs::remove_file(&spec_path).await;

    match run_result {
        Ok(run) => {
            let clean_stdout = strip_structured_worker_output(&run.stdout);
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
                _ => SandboxState::Failed {
                    exit_code: run.exit_code,
                },
            };
            if let Some(path) =
                extract_worktree_path(&run.stdout).or_else(|| default_worktree_path(&task_id))
            {
                cfg.ledger
                    .set_worktree(&task_id, path, sandbox_branch_name(&task_id))
                    .await;
            }
            cfg.ledger.update_state(&task_id, new_state).await;

            let mut result = structured_result
                .lock()
                .expect("worker result mutex poisoned")
                .clone()
                .unwrap_or_else(|| WorkerResult {
                    schema_version: bakudo_core::protocol::PROTOCOL_SCHEMA_VERSION,
                    attempt_id: spec.attempt_id.clone(),
                    session_id: spec.session_id.clone(),
                    task_id: TaskId(task_id.clone()),
                    status: status.clone(),
                    summary: extract_summary(&clean_stdout, &run.stderr),
                    finished_at: Utc::now(),
                    exit_code: run.exit_code,
                    duration_ms,
                    timed_out: run.timed_out,
                    stdout: String::new(),
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                });

            result.schema_version = bakudo_core::protocol::PROTOCOL_SCHEMA_VERSION;
            result.attempt_id = spec.attempt_id;
            result.session_id = spec.session_id;
            result.task_id = TaskId(task_id.clone());
            result.status = status;
            if result.summary.trim().is_empty() {
                result.summary = extract_summary(&clean_stdout, &run.stderr);
            }
            result.finished_at = Utc::now();
            result.exit_code = run.exit_code;
            result.duration_ms = duration_ms;
            result.timed_out = run.timed_out;
            result.stdout = clean_stdout;
            result.stderr = run.stderr.clone();
            result.stdout_truncated = run.stdout_truncated;
            result.stderr_truncated = run.stderr_truncated;
            if !run.stderr.is_empty() {
                cfg.trace_recorder
                    .append_attempt_stream(&task_id, "stderr", &run.stderr)
                    .await;
            }
            cfg.trace_recorder
                .record_attempt_finish(
                    &task_id,
                    &result,
                    &attempt_trace_bundle(&spec_for_trace, &result),
                )
                .await;

            let _ = tx.send(RunnerEvent::Finished(result.clone())).await;
            Ok(result)
        }
        Err(e) => {
            cfg.ledger
                .update_state(&task_id, SandboxState::Failed { exit_code: -1 })
                .await;
            let msg = e.to_string();
            cfg.trace_recorder
                .record_attempt_finish(
                    &task_id,
                    &json!({
                        "status": "infra_error",
                        "error": msg.clone(),
                    }),
                    &format!(
                        "# Attempt Trace\n\n- task_id: `{}`\n- provider: `{}`\n- status: `infra_error`\n\n## Error\n{}\n",
                        task_id,
                        spec.provider_id,
                        msg
                    ),
                )
                .await;
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

fn strip_structured_worker_output(stdout: &str) -> String {
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            !line.starts_with(WORKER_EVENT_PREFIX)
                && !line.starts_with(WORKER_RESULT_PREFIX)
                && !line.starts_with(WORKER_ERROR_PREFIX)
        })
        .collect();
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

/// Extract a one-line summary from the worker's stdout.
fn extract_summary(stdout: &str, stderr: &str) -> String {
    if let Some(summary) =
        extract_prefixed_summary(stdout).or_else(|| extract_prefixed_summary(stderr))
    {
        return summary;
    }

    // Prefer the last meaningful stdout line, but fall back to stderr so
    // provider failures still produce a useful summary.
    [stdout, stderr]
        .into_iter()
        .flat_map(|stream| stream.lines().rev())
        .find(|line| !line.trim().is_empty())
        .unwrap_or("(no output)")
        .chars()
        .take(200)
        .collect()
}

fn extract_prefixed_summary(stream: &str) -> Option<String> {
    stream.lines().find_map(|line| {
        line.trim()
            .strip_prefix(WORKER_SUMMARY_PREFIX)
            .map(str::trim)
            .filter(|summary| !summary.is_empty())
            .map(|summary| summary.chars().take(200).collect())
    })
}

fn attempt_trace_bundle(spec: &AttemptSpec, result: &WorkerResult) -> String {
    format!(
        "# Attempt Trace\n\n- task_id: `{}`\n- provider: `{}`\n- model: `{}`\n- status: `{:?}`\n- exit_code: `{}`\n- duration_ms: `{}`\n- lifecycle: `{}`\n- candidate_policy: `{}`\n\n## Prompt Summary\n{}\n\n## Files\n- `start.json`\n- `stdout.log`\n- `stderr.log`\n- `result.json`\n",
        result.task_id.0,
        spec.provider_id,
        spec.model.as_deref().unwrap_or("default"),
        result.status,
        result.exit_code,
        result.duration_ms,
        spec.sandbox_lifecycle,
        spec.candidate_policy,
        spec.prompt.chars().take(200).collect::<String>(),
    )
}

fn sandbox_branch_name(task_id: &str) -> String {
    format!("agent/{task_id}")
}

fn extract_worktree_path(stdout: &str) -> Option<String> {
    stdout.lines().find_map(extract_worktree_path_from_line)
}

fn extract_worktree_path_from_line(line: &str) -> Option<String> {
    for marker in ["worktree=", "path="] {
        let Some((_, tail)) = line.split_once(marker) else {
            continue;
        };
        let candidate = tail
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches('"');
        if candidate.starts_with('/') {
            return Some(candidate.to_string());
        }
    }
    None
}

fn default_worktree_path(task_id: &str) -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home)
        .join(".abox")
        .join("worktrees")
        .join(task_id);
    path.exists().then(|| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bakudo_core::protocol::{
        AttemptId, SessionId, TaskId, WorkerProgressKind, WorkerProgressMetadata,
        PROTOCOL_SCHEMA_VERSION,
    };

    #[test]
    fn parse_worker_line_parses_structured_progress_events() {
        let event = WorkerProgressEvent {
            attempt_id: AttemptId("attempt-parse-progress".to_string()),
            kind: WorkerProgressKind::CommandExecution,
            message: "cargo test -p bakudo-tui".to_string(),
            metadata: Some(WorkerProgressMetadata {
                command: Some("cargo test -p bakudo-tui".to_string()),
                path: None,
                tool_name: None,
                detail: None,
            }),
            timestamp: Utc::now(),
        };
        let line = format!(
            "{} {}",
            WORKER_EVENT_PREFIX,
            serde_json::to_string(&event).unwrap()
        );

        match parse_worker_line(&line) {
            RunnerEvent::Progress(parsed) => {
                assert_eq!(parsed.kind, WorkerProgressKind::CommandExecution);
                assert_eq!(parsed.message, "cargo test -p bakudo-tui");
                assert_eq!(
                    parsed
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.command.as_deref()),
                    Some("cargo test -p bakudo-tui")
                );
            }
            other => panic!("expected Progress event, got {other:?}"),
        }
    }

    #[test]
    fn parse_worker_line_invalid_payload_falls_back_to_raw_line() {
        let line = format!("{WORKER_EVENT_PREFIX} {{not valid json}}");
        match parse_worker_line(&line) {
            RunnerEvent::RawLine(raw) => assert_eq!(raw, line),
            other => panic!("expected RawLine fallback, got {other:?}"),
        }
    }

    #[test]
    fn parse_worker_line_parses_result_payloads() {
        let result = WorkerResult {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            attempt_id: AttemptId("attempt-parse-result".to_string()),
            session_id: SessionId("session-parse-result".to_string()),
            task_id: TaskId("task-parse-result".to_string()),
            status: WorkerStatus::Succeeded,
            summary: "done".to_string(),
            finished_at: Utc::now(),
            exit_code: 0,
            duration_ms: 42,
            timed_out: false,
            stdout: "done".to_string(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let line = format!(
            "{} {}",
            WORKER_RESULT_PREFIX,
            serde_json::to_string(&result).unwrap()
        );

        match parse_worker_line(&line) {
            RunnerEvent::Finished(parsed) => {
                assert_eq!(parsed.summary, "done");
                assert_eq!(parsed.status, WorkerStatus::Succeeded);
            }
            other => panic!("expected Finished event, got {other:?}"),
        }
    }

    #[test]
    fn extract_summary_uses_last_non_empty_line_and_truncates() {
        let long_line = "x".repeat(250);
        let stdout = format!("first line\n\n{long_line}\n");
        let summary = extract_summary(&stdout, "");
        assert_eq!(summary.len(), 200);
        assert!(summary.chars().all(|ch| ch == 'x'));
    }

    #[test]
    fn extract_summary_falls_back_to_stderr() {
        let summary = extract_summary("", "first\n\nfatal: provider exploded\n");
        assert_eq!(summary, "fatal: provider exploded");
    }

    #[test]
    fn extract_summary_prefers_explicit_worker_summary_prefix() {
        let stdout =
            "working note\nBAKUDO_SUMMARY: verified README.md exists\nplain trailing line\n";
        let summary = extract_summary(stdout, "");
        assert_eq!(summary, "verified README.md exists");
    }

    #[test]
    fn extract_worktree_path_parses_abox_logs() {
        let line = "2026-04-24T11:49:56Z INFO Created worktree sandbox_id=\"bakudo-task\" branch=agent/bakudo-task path=/tmp/abox/worktrees/bakudo-task";
        assert_eq!(
            extract_worktree_path_from_line(line).as_deref(),
            Some("/tmp/abox/worktrees/bakudo-task")
        );
    }
}
