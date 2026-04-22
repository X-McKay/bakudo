//! abox v0.3.1 adapter.
//!
//! All abox invocations follow the pattern:
//!   abox [--repo <path>] <subcommand> [args...]
//!
//! The `--repo` flag is a global flag on the root Cli struct, so it must come
//! BEFORE the subcommand.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{debug, warn};

use crate::error::AboxError;

/// A single row from `abox list` output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxEntry {
    pub id: String,
    pub branch: String,
    pub vm_state: String,
    pub vm_pid: String,
    pub commits_ahead: String,
}

/// Result of an `abox run` invocation (blocking, not --detach).
#[derive(Debug)]
pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// The abox adapter wraps the `abox` binary and exposes typed methods for
/// each subcommand bakudo needs.
#[derive(Debug, Clone)]
pub struct AboxAdapter {
    /// Path to the `abox` binary.
    pub bin: PathBuf,
}

impl AboxAdapter {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self { bin: bin.into() }
    }

    /// Build the base command with the optional `--repo` global flag.
    fn base_cmd(&self, repo: Option<&Path>) -> Command {
        let mut cmd = Command::new(&self.bin);
        if let Some(r) = repo {
            cmd.args(["--repo", r.to_str().unwrap_or(".")]);
        }
        cmd
    }

    /// `abox [--repo <repo>] run --task <task_id> [--ephemeral] [--memory N]
    ///   [--cpus N] [--timeout N] [-e KEY=VAL ...] -- <command>`
    ///
    /// Runs the sandbox and streams stdout/stderr to the provided callbacks.
    /// Returns when the VM exits or the timeout fires.
    pub async fn run<F>(&self, params: &RunParams, on_line: F) -> Result<RunResult, AboxError>
    where
        F: Fn(&str) + Send + 'static,
    {
        let mut cmd = self.base_cmd(params.repo.as_deref());
        cmd.arg("run").arg("--task").arg(&params.task_id);

        if params.ephemeral {
            cmd.arg("--ephemeral");
        }
        if let Some(m) = params.memory_mib {
            cmd.args(["--memory", &m.to_string()]);
        }
        if let Some(c) = params.cpus {
            cmd.args(["--cpus", &c.to_string()]);
        }
        if let Some(t) = params.timeout_secs {
            cmd.args(["--timeout", &t.to_string()]);
        }
        for (k, v) in &params.env_vars {
            cmd.args(["-e", &format!("{k}={v}")]);
        }
        cmd.arg("--").args(&params.command);

        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        debug!("abox run: {:?}", cmd);

        let mut child = cmd.spawn().map_err(|e| AboxError::BinaryNotFound {
            path: self.bin.display().to_string(),
            source: e,
        })?;

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let mut out_buf = String::new();
        let mut err_buf = String::new();

        let mut out_reader = BufReader::new(stdout).lines();
        let mut err_reader = BufReader::new(stderr).lines();

        let deadline = params.timeout_secs.map(|s| Duration::from_secs(s + 30));

        // Drive stdout/stderr concurrently and collect into buffers.
        let read_fut = async {
            let mut stdout_open = true;
            let mut stderr_open = true;
            while stdout_open || stderr_open {
                tokio::select! {
                    line = out_reader.next_line(), if stdout_open => {
                        match line {
                            Ok(Some(l)) => {
                                on_line(&l);
                                out_buf.push_str(&l);
                                out_buf.push('\n');
                            }
                            Ok(None) => {
                                stdout_open = false;
                            }
                            Err(e) => {
                                warn!("stdout read error: {e}");
                                stdout_open = false;
                            }
                        }
                    }
                    line = err_reader.next_line(), if stderr_open => {
                        match line {
                            Ok(Some(l)) => {
                                err_buf.push_str(&l);
                                err_buf.push('\n');
                            }
                            Ok(None) => {
                                stderr_open = false;
                            }
                            Err(e) => {
                                warn!("stderr read error: {e}");
                                stderr_open = false;
                            }
                        }
                    }
                }
            }
        };

        let (status, timed_out) = if let Some(d) = deadline {
            match timeout(d, read_fut).await {
                Ok(()) => match child.wait().await {
                    Ok(s) => (s, false),
                    Err(e) => return Err(AboxError::Io(e)),
                },
                Err(_elapsed) => {
                    // Kill the child and return a timeout error.
                    let _ = child.kill().await;
                    let _ = child.wait().await; // reap zombie
                    return Ok(RunResult {
                        exit_code: -1,
                        stdout: out_buf,
                        stderr: err_buf,
                        timed_out: true,
                    });
                }
            }
        } else {
            read_fut.await;
            match child.wait().await {
                Ok(s) => (s, false),
                Err(e) => return Err(AboxError::Io(e)),
            }
        };

        Ok(RunResult {
            exit_code: status.code().unwrap_or(-1),
            stdout: out_buf,
            stderr: err_buf,
            timed_out,
        })
    }

    /// `abox [--repo <repo>] list` — returns parsed sandbox entries.
    pub async fn list(&self, repo: Option<&Path>) -> Result<Vec<SandboxEntry>, AboxError> {
        let mut cmd = self.base_cmd(repo);
        cmd.arg("list");
        let out = cmd.output().await.map_err(AboxError::Io)?;
        parse_list_output(&String::from_utf8_lossy(&out.stdout))
    }

    /// `abox [--repo <repo>] stop <task_id> [--clean]`
    pub async fn stop(
        &self,
        repo: Option<&Path>,
        task_id: &str,
        clean: bool,
    ) -> Result<(), AboxError> {
        let mut cmd = self.base_cmd(repo);
        cmd.arg("stop").arg(task_id);
        if clean {
            cmd.arg("--clean");
        }
        let out = cmd.output().await.map_err(AboxError::Io)?;
        if !out.status.success() {
            return Err(AboxError::StopFailed {
                task_id: task_id.to_string(),
                detail: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }
        Ok(())
    }

    /// `abox [--repo <repo>] merge <task_id> [--base <base>]`
    pub async fn merge(
        &self,
        repo: Option<&Path>,
        task_id: &str,
        base: &str,
    ) -> Result<Vec<String>, AboxError> {
        let mut cmd = self.base_cmd(repo);
        cmd.arg("merge").arg(task_id).args(["--base", base]);
        let out = cmd.output().await.map_err(AboxError::Io)?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        if !out.status.success() {
            // abox merge prints conflict paths on failure
            let conflicts: Vec<String> = stdout
                .lines()
                .filter(|l| l.starts_with("  "))
                .map(|l| l.trim().to_string())
                .collect();
            if !conflicts.is_empty() {
                return Ok(conflicts); // non-empty = merge conflicts
            }
            return Err(AboxError::MergeFailed {
                task_id: task_id.to_string(),
                detail: String::from_utf8_lossy(&out.stderr).to_string(),
            });
        }
        Ok(vec![]) // empty = clean merge
    }

    /// `abox [--repo <repo>] divergence [--base <base>]`
    pub async fn divergence(&self, repo: Option<&Path>, base: &str) -> Result<String, AboxError> {
        let mut cmd = self.base_cmd(repo);
        cmd.arg("divergence").args(["--base", base]);
        let out = cmd.output().await.map_err(AboxError::Io)?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }
}

/// Parameters for `abox run`.
#[derive(Debug, Clone)]
pub struct RunParams {
    pub task_id: String,
    pub command: Vec<String>,
    pub repo: Option<PathBuf>,
    pub ephemeral: bool,
    pub memory_mib: Option<u32>,
    pub cpus: Option<u8>,
    pub timeout_secs: Option<u64>,
    pub env_vars: Vec<(String, String)>,
}

impl RunParams {
    pub fn new(task_id: impl Into<String>, command: Vec<String>) -> Self {
        Self {
            task_id: task_id.into(),
            command,
            repo: None,
            ephemeral: false,
            memory_mib: None,
            cpus: None,
            timeout_secs: None,
            env_vars: vec![],
        }
    }
}

/// Generate a deterministic abox task ID from an attempt ID.
/// Sanitises the attempt ID to only contain characters valid in a git branch name.
pub fn sandbox_task_id(attempt_id: &str) -> String {
    let sanitised: String = attempt_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitised.trim_matches('-');
    format!(
        "bakudo-{}",
        if trimmed.is_empty() {
            "attempt"
        } else {
            trimmed
        }
    )
}

/// Parse the tabular output of `abox list`.
/// Header line format: ID  BRANCH  STATE  PID  AHEAD
fn parse_list_output(output: &str) -> Result<Vec<SandboxEntry>, AboxError> {
    let mut entries = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("ID") || line.starts_with('-') {
            continue;
        }
        if line.starts_with("No active") || line.contains("sandbox(es)") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 {
            continue;
        }
        entries.push(SandboxEntry {
            id: cols[0].to_string(),
            branch: cols[1].to_string(),
            vm_state: cols[2].to_string(),
            vm_pid: cols[3].to_string(),
            commits_ahead: cols[4].to_string(),
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_task_id_sanitises() {
        assert_eq!(sandbox_task_id("attempt-abc-123"), "bakudo-attempt-abc-123");
        assert_eq!(sandbox_task_id(""), "bakudo-attempt");
    }

    #[test]
    fn parse_list_empty() {
        let out = "No active sandboxes.\n";
        let entries = parse_list_output(out).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_list_with_entries() {
        let out = "\
ID               BRANCH                   STATE      PID      AHEAD   
----------------------------------------------------------------------
bakudo-abc       agent/bakudo-abc         running    12345    3       
bakudo-def       agent/bakudo-def         stopped    0        0       

2 sandbox(es) active
";
        let entries = parse_list_output(out).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "bakudo-abc");
        assert_eq!(entries[0].vm_state, "running");
        assert_eq!(entries[1].id, "bakudo-def");
        assert_eq!(entries[1].vm_state, "stopped");
    }
}
