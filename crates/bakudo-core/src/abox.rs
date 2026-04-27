//! abox v0.3.2 adapter.
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
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
}

/// The abox adapter wraps the `abox` binary and exposes typed methods for
/// each subcommand bakudo needs.
#[derive(Debug, Clone)]
pub struct AboxAdapter {
    /// Path to the `abox` binary.
    pub bin: PathBuf,
    /// Optional path passed as `--config` on every abox invocation.
    /// Bakudo uses this to point abox at a bakudo-owned config + proxy
    /// policy rather than the operator's own `~/.abox/config.toml`. See
    /// `bakudo_daemon::abox_runtime` for the materialization details.
    config_path: Option<PathBuf>,
}

impl AboxAdapter {
    pub fn new(bin: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            config_path: None,
        }
    }

    /// Construct an adapter that passes `--config <path>` on every abox
    /// invocation. The config file fully replaces the abox-side default
    /// (i.e. it is not merged with `~/.abox/config.toml`).
    pub fn with_config(bin: impl Into<PathBuf>, config_path: impl Into<PathBuf>) -> Self {
        Self {
            bin: bin.into(),
            config_path: Some(config_path.into()),
        }
    }

    /// Path passed on `abox --config <...>`, if any.
    pub fn config_path(&self) -> Option<&Path> {
        self.config_path.as_deref()
    }

    /// Build the base command with the optional global `--config` and
    /// `--repo` flags. abox parses both at the top level (before the
    /// subcommand), so they must be added here, not after the
    /// subcommand argument.
    fn base_cmd(&self, repo: Option<&Path>) -> Command {
        let mut cmd = Command::new(&self.bin);
        if let Some(cfg) = &self.config_path {
            cmd.arg("--config").arg(cfg);
        }
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
        let mut stdout_truncated = false;
        let mut stderr_truncated = false;
        let mut worktree_path = None;
        let mut worktree_branch = None;

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
                                update_worktree_metadata(
                                    &l,
                                    &mut worktree_path,
                                    &mut worktree_branch,
                                );
                                push_capped_line(
                                    &mut out_buf,
                                    &l,
                                    params.max_output_bytes,
                                    &mut stdout_truncated,
                                );
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
                                push_capped_line(
                                    &mut err_buf,
                                    &l,
                                    params.max_output_bytes,
                                    &mut stderr_truncated,
                                );
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
                        stdout_truncated,
                        stderr_truncated,
                        worktree_path,
                        worktree_branch,
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

        let exit_code = status.code().unwrap_or(-1);
        // `abox run --timeout ...` exits with 124 when the sandbox itself hits
        // its wall-clock budget. That is distinct from this adapter's outer
        // read deadline (`timeout_secs + 30`), but it should still surface as a
        // timeout to higher layers so the ledger/UI don't misclassify it as a
        // generic failure.
        let timed_out = timed_out || exit_code == 124;

        Ok(RunResult {
            exit_code,
            stdout: out_buf,
            stderr: err_buf,
            timed_out,
            stdout_truncated,
            stderr_truncated,
            worktree_path,
            worktree_branch,
        })
    }

    /// `abox [--repo <repo>] list` — returns parsed sandbox entries.
    pub async fn list(&self, repo: Option<&Path>) -> Result<Vec<SandboxEntry>, AboxError> {
        let mut cmd = self.base_cmd(repo);
        cmd.arg("list");
        let out = cmd.output().await.map_err(AboxError::Io)?;
        if !out.status.success() {
            return Err(AboxError::ListFailed {
                detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
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

    /// `abox --version` — returns the raw version output.
    pub async fn version(&self) -> Result<String, AboxError> {
        let out = Command::new(&self.bin)
            .arg("--version")
            .output()
            .await
            .map_err(AboxError::Io)?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
    pub max_output_bytes: usize,
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
            max_output_bytes: 512 * 1024,
            env_vars: vec![],
        }
    }
}

fn push_capped_line(buf: &mut String, line: &str, limit: usize, truncated: &mut bool) {
    if *truncated {
        return;
    }
    let additional = line.len() + 1;
    if buf.len().saturating_add(additional) > limit {
        *truncated = true;
        return;
    }
    buf.push_str(line);
    buf.push('\n');
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

pub fn sandbox_branch(task_id: &str) -> String {
    format!("agent/{task_id}")
}

pub fn sandbox_default_worktree_path(task_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home)
        .join(".abox")
        .join("worktrees")
        .join(task_id);
    path.exists().then_some(path)
}

fn update_worktree_metadata(
    line: &str,
    worktree_path: &mut Option<String>,
    worktree_branch: &mut Option<String>,
) {
    if worktree_path.is_none() {
        *worktree_path = extract_worktree_path_from_line(line);
    }
    if worktree_branch.is_none() {
        *worktree_branch = extract_worktree_branch_from_line(line);
    }
}

fn extract_worktree_path_from_line(line: &str) -> Option<String> {
    for marker in ["worktree=", "path="] {
        let Some(candidate) = extract_marker_value(line, marker) else {
            continue;
        };
        if candidate.starts_with('/') {
            return Some(candidate);
        }
    }
    None
}

fn extract_worktree_branch_from_line(line: &str) -> Option<String> {
    extract_marker_value(line, "branch=")
        .filter(|branch| branch.starts_with("agent/") || branch.starts_with("bakudo-"))
}

fn extract_marker_value(line: &str, marker: &str) -> Option<String> {
    let (_, tail) = line.split_once(marker)?;
    Some(
        tail.split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches('"')
            .to_string(),
    )
    .filter(|value| !value.is_empty())
}

/// Parse the tabular output of `abox list`.
/// Header line format: ID  BRANCH  STATE  PID  AHEAD
///
/// Uses the header row to determine fixed column offsets, falling back to
/// whitespace splitting only if the header can't be found. This tolerates
/// state/branch strings that contain spaces (e.g. "merge conflicts").
fn parse_list_output(output: &str) -> Result<Vec<SandboxEntry>, AboxError> {
    let mut lines = output.lines();
    let header = loop {
        match lines.next() {
            Some(line) if line.trim_start().starts_with("ID") => break Some(line),
            Some(_) => continue,
            None => break None,
        }
    };

    let offsets = header.and_then(header_offsets);

    let mut entries = Vec::new();
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            continue;
        }
        if trimmed.starts_with('-') {
            continue;
        }
        if trimmed.trim_start().starts_with("No active") || trimmed.contains("sandbox(es)") {
            continue;
        }
        match &offsets {
            Some(off) => {
                if let Some(entry) = parse_by_offsets(trimmed, off) {
                    entries.push(entry);
                }
            }
            None => {
                let cols: Vec<&str> = trimmed.split_whitespace().collect();
                if cols.len() >= 5 {
                    entries.push(SandboxEntry {
                        id: cols[0].to_string(),
                        branch: cols[1].to_string(),
                        vm_state: cols[2].to_string(),
                        vm_pid: cols[3].to_string(),
                        commits_ahead: cols[4].to_string(),
                    });
                }
            }
        }
    }
    Ok(entries)
}

/// Determine the byte offsets of each column header in the `abox list` header row.
fn header_offsets(header: &str) -> Option<[usize; 5]> {
    let id = header.find("ID")?;
    let branch = header[id..].find("BRANCH").map(|i| i + id)?;
    let state = header[branch..].find("STATE").map(|i| i + branch)?;
    let pid = header[state..].find("PID").map(|i| i + state)?;
    let ahead = header[pid..].find("AHEAD").map(|i| i + pid)?;
    Some([id, branch, state, pid, ahead])
}

fn parse_by_offsets(line: &str, offsets: &[usize; 5]) -> Option<SandboxEntry> {
    fn slice(line: &str, start: usize, end: Option<usize>) -> Option<String> {
        if start >= line.len() {
            return None;
        }
        let end = end.unwrap_or(line.len()).min(line.len());
        if end <= start {
            return None;
        }
        Some(line[start..end].trim().to_string())
    }
    let id = slice(line, offsets[0], Some(offsets[1]))?;
    let branch = slice(line, offsets[1], Some(offsets[2]))?;
    let vm_state = slice(line, offsets[2], Some(offsets[3]))?;
    let vm_pid = slice(line, offsets[3], Some(offsets[4]))?;
    let commits_ahead = slice(line, offsets[4], None).unwrap_or_default();
    if id.is_empty() {
        return None;
    }
    Some(SandboxEntry {
        id,
        branch,
        vm_state,
        vm_pid,
        commits_ahead,
    })
}

/// Minimum abox version bakudo is known to work with. Keep in sync with the
/// `//! abox v<X.Y.Z> adapter.` doc-comment at the top of this file.
pub const MIN_ABOX_VERSION: (u32, u32, u32) = (0, 3, 2);

/// Result of cross-checking `abox --version` output against [`MIN_ABOX_VERSION`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AboxVersionStatus {
    Ok {
        current: (u32, u32, u32),
    },
    TooOld {
        current: (u32, u32, u32),
        min: (u32, u32, u32),
    },
    /// `--version` returned output we couldn't parse — wrap the raw stdout so
    /// callers can surface it to the user.
    Unparseable(String),
}

/// Parse `"abox 0.3.2"` (or a line containing that phrase) into `(0, 3, 2)`.
pub fn parse_abox_version(output: &str) -> Option<(u32, u32, u32)> {
    let trimmed = output.trim();
    let after_prefix = trimmed
        .lines()
        .find_map(|line| line.trim().strip_prefix("abox "))?
        .trim();
    // Take everything up to the first whitespace/plus/dash-followed-by-letter so
    // a build-metadata suffix like "0.3.2-dev" or "0.3.2 (abcdef)" doesn't break us.
    let core = after_prefix
        .split(|c: char| c.is_whitespace() || c == '+')
        .next()?
        .trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.');
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// Classify the abox version output against [`MIN_ABOX_VERSION`].
pub fn check_abox_version(output: &str) -> AboxVersionStatus {
    match parse_abox_version(output) {
        Some(current) if current >= MIN_ABOX_VERSION => AboxVersionStatus::Ok { current },
        Some(current) => AboxVersionStatus::TooOld {
            current,
            min: MIN_ABOX_VERSION,
        },
        None => AboxVersionStatus::Unparseable(output.trim().to_string()),
    }
}

impl AboxAdapter {
    /// Run `abox --version` and classify the result against [`MIN_ABOX_VERSION`].
    pub async fn check_version(&self) -> Result<AboxVersionStatus, AboxError> {
        let raw = self.version().await?;
        Ok(check_abox_version(&raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_new_has_no_config_path() {
        let adapter = AboxAdapter::new("/usr/local/bin/abox");
        assert!(
            adapter.config_path().is_none(),
            "AboxAdapter::new must not invent a config path; \
             only with_config opts into bakudo-managed runtime",
        );
    }

    #[test]
    fn adapter_with_config_remembers_path() {
        let adapter = AboxAdapter::with_config(
            "/usr/local/bin/abox",
            "/var/data/bakudo/abox-runtime/abox-config.toml",
        );
        assert_eq!(
            adapter.config_path().map(|p| p.to_path_buf()),
            Some(PathBuf::from(
                "/var/data/bakudo/abox-runtime/abox-config.toml"
            )),
        );
    }

    #[test]
    fn sandbox_task_id_sanitises() {
        assert_eq!(sandbox_task_id("attempt-abc-123"), "bakudo-attempt-abc-123");
        assert_eq!(sandbox_task_id(""), "bakudo-attempt");
    }

    #[test]
    fn sandbox_branch_formats_agent_namespace() {
        assert_eq!(sandbox_branch("bakudo-task"), "agent/bakudo-task");
    }

    #[test]
    fn parse_abox_version_plain() {
        assert_eq!(parse_abox_version("abox 0.3.2"), Some((0, 3, 2)));
        assert_eq!(parse_abox_version("abox 1.2.3\n"), Some((1, 2, 3)));
    }

    #[test]
    fn parse_abox_version_tolerates_suffixes_and_build_metadata() {
        assert_eq!(parse_abox_version("abox 0.3.2-dev"), Some((0, 3, 2)));
        assert_eq!(parse_abox_version("abox 0.3.2+gabcdef"), Some((0, 3, 2)));
        assert_eq!(parse_abox_version("abox 0.3.2 (abcdef)"), Some((0, 3, 2)));
    }

    #[test]
    fn parse_abox_version_accepts_two_component_versions() {
        assert_eq!(parse_abox_version("abox 1.0"), Some((1, 0, 0)));
    }

    #[test]
    fn parse_abox_version_rejects_garbage() {
        assert_eq!(parse_abox_version(""), None);
        assert_eq!(parse_abox_version("not abox output"), None);
        assert_eq!(parse_abox_version("abox vX.Y"), None);
    }

    #[test]
    fn check_abox_version_ok_when_meets_minimum() {
        assert!(matches!(
            check_abox_version("abox 0.3.2"),
            AboxVersionStatus::Ok { current: (0, 3, 2) }
        ));
        assert!(matches!(
            check_abox_version("abox 1.0.0"),
            AboxVersionStatus::Ok { .. }
        ));
    }

    #[test]
    fn check_abox_version_too_old() {
        assert_eq!(
            check_abox_version("abox 0.2.0"),
            AboxVersionStatus::TooOld {
                current: (0, 2, 0),
                min: MIN_ABOX_VERSION,
            }
        );
        assert_eq!(
            check_abox_version("abox 0.3.0"),
            AboxVersionStatus::TooOld {
                current: (0, 3, 0),
                min: MIN_ABOX_VERSION,
            }
        );
        assert_eq!(
            check_abox_version("abox 0.3.1"),
            AboxVersionStatus::TooOld {
                current: (0, 3, 1),
                min: MIN_ABOX_VERSION,
            }
        );
    }

    #[test]
    fn check_abox_version_unparseable_preserves_raw() {
        match check_abox_version("something weird") {
            AboxVersionStatus::Unparseable(raw) => assert_eq!(raw, "something weird"),
            other => panic!("expected Unparseable, got {other:?}"),
        }
    }

    #[test]
    fn parse_list_empty() {
        let out = "No active sandboxes.\n";
        let entries = parse_list_output(out).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_list_tolerates_multi_word_state() {
        let out = "\
ID               BRANCH                   STATE            PID      AHEAD
------------------------------------------------------------------------------
bakudo-abc       agent/bakudo-abc         merge conflicts  12345    3
";
        let entries = parse_list_output(out).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].vm_state, "merge conflicts");
        assert_eq!(entries[0].vm_pid, "12345");
        assert_eq!(entries[0].commits_ahead, "3");
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

    #[test]
    fn extract_worktree_metadata_from_run_line() {
        let line = "2026-04-24T11:49:56Z INFO Created worktree sandbox_id=\"bakudo-task\" branch=agent/bakudo-task path=/tmp/abox/worktrees/bakudo-task";
        assert_eq!(
            extract_worktree_path_from_line(line).as_deref(),
            Some("/tmp/abox/worktrees/bakudo-task")
        );
        assert_eq!(
            extract_worktree_branch_from_line(line).as_deref(),
            Some("agent/bakudo-task")
        );
    }
}
