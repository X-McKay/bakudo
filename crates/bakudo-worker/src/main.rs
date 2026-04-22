//! bakudo-worker — a small wrapper that runs inside the abox VM, invokes the
//! provider CLI, and emits `BAKUDO_EVENT` / `BAKUDO_RESULT` envelopes on stdout
//! so the host can parse structured events.
//!
//! Invocation (from the host, via `abox run -- bakudo-worker <provider-cmd>...`):
//!
//!     bakudo-worker claude -p --model claude-opus-4-5 --dangerously-skip-permissions
//!
//! The worker reads the prompt from `$BAKUDO_PROMPT` and forwards it to the
//! provider via stdin. Every non-empty line of the provider's stdout is
//! emitted as a `BAKUDO_EVENT` envelope with kind `assistant_message`.
//! On exit, the worker writes a final `BAKUDO_RESULT` envelope.
//!
//! This is a deliberately minimal first pass. Per-provider output parsing
//! (tool calls, token counts, etc.) can be layered on top by matching
//! `$BAKUDO_PROVIDER` and dispatching to a provider-specific adapter.

use std::env;
use std::process::Stdio;
use std::time::Instant;

use anyhow::{Context, Result};
use chrono::Utc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use bakudo_core::protocol::{
    AttemptId, SessionId, TaskId, WorkerProgressEvent, WorkerProgressKind, WorkerResult,
    WorkerStatus, PROTOCOL_SCHEMA_VERSION, WORKER_ERROR_PREFIX, WORKER_EVENT_PREFIX,
    WORKER_RESULT_PREFIX,
};

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let binary = args
        .next()
        .context("bakudo-worker requires at least one argument (the provider binary)")?;
    let rest: Vec<String> = args.collect();

    let prompt = env::var("BAKUDO_PROMPT").unwrap_or_default();
    let task_id = env::var("BAKUDO_TASK_ID").unwrap_or_else(|_| "unknown".to_string());
    let attempt_id = AttemptId(format!("attempt-{task_id}"));

    let mut child = Command::new(&binary)
        .args(&rest)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn provider binary '{binary}'"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.ok();
        drop(stdin);
    }

    let stdout = child.stdout.take().context("child stdout piped")?;
    let stderr = child.stderr.take().context("child stderr piped")?;

    let start = Instant::now();
    let mut last_line = String::new();

    let stdout_task = tokio::spawn({
        let attempt_id = attempt_id.clone();
        async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut final_line = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                emit_event(
                    &attempt_id,
                    WorkerProgressKind::AssistantMessage,
                    trimmed.to_string(),
                );
                final_line = trimmed.to_string();
            }
            final_line
        }
    });

    let stderr_task = tokio::spawn({
        let attempt_id = attempt_id.clone();
        async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                emit_event(
                    &attempt_id,
                    WorkerProgressKind::StatusUpdate,
                    format!("(stderr) {trimmed}"),
                );
            }
        }
    });

    let status = child.wait().await.context("wait on provider process")?;
    let _ = stderr_task.await;
    if let Ok(line) = stdout_task.await {
        last_line = line;
    }

    let exit_code = status.code().unwrap_or(-1);
    let worker_status = if exit_code == 0 {
        WorkerStatus::Succeeded
    } else {
        WorkerStatus::Failed
    };

    let result = WorkerResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        attempt_id: attempt_id.clone(),
        session_id: SessionId(format!("session-{task_id}")),
        task_id: TaskId(task_id.clone()),
        status: worker_status,
        summary: if last_line.is_empty() {
            format!("provider exited with code {exit_code}")
        } else {
            last_line.chars().take(200).collect()
        },
        finished_at: Utc::now(),
        exit_code,
        duration_ms: start.elapsed().as_millis() as u64,
        timed_out: false,
        stdout: String::new(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    };

    match serde_json::to_string(&result) {
        Ok(json) => println!("{WORKER_RESULT_PREFIX} {json}"),
        Err(e) => println!("{WORKER_ERROR_PREFIX} failed to serialise result: {e}"),
    }

    Ok(())
}

fn emit_event(attempt_id: &AttemptId, kind: WorkerProgressKind, message: String) {
    let event = WorkerProgressEvent {
        attempt_id: attempt_id.clone(),
        kind,
        message,
        timestamp: Utc::now(),
    };
    match serde_json::to_string(&event) {
        Ok(json) => println!("{WORKER_EVENT_PREFIX} {json}"),
        Err(e) => println!("{WORKER_ERROR_PREFIX} failed to serialise event: {e}"),
    }
}
