use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bakudo_core::abox::{sandbox_task_id, AboxAdapter, RunParams};
use bakudo_core::config::BakudoConfig;
use bakudo_core::control::swarm_artifact_root;
use bakudo_core::error::AboxError;
use bakudo_core::mission::{
    Experiment, ExperimentStatus, Mission, MissionId, MissionState, MissionStatus, Posture, Wallet,
};
use bakudo_core::policy::{ExecutionPolicy, ExecutionPolicyRule, PolicyDecision};
use bakudo_core::protocol::{
    AttemptId, AttemptSpec, CandidatePolicy, SessionId, TaskId, WorkerProgressEvent,
    WorkerProgressKind, WorkerStatus, WORKER_EVENT_PREFIX,
};
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::session::SessionRecord;
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};
use bakudo_daemon::mission_store::MissionStore;
use bakudo_daemon::session_controller::{
    SessionBootstrap, SessionCommand, SessionController, SessionEvent,
};
use bakudo_daemon::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
use bakudo_daemon::worktree::{apply_candidate_policy, WorktreeAction};
use bakudo_tui::app::{App, ChatMessage, MessageRole, ShelfColor};
use bakudo_tui::transcript_store::TranscriptStore;
use chrono::{TimeZone, Utc};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use tokio::sync::mpsc;
use tokio::time::timeout;
use uuid::Uuid;

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct TempRepo {
    dir: TempDir,
}

impl TempRepo {
    fn new() -> Self {
        let dir = TempDir::new("bakudo-runtime-repo");
        run_host(&dir.path, "git", &["init", "-b", "main"]);
        run_host(
            &dir.path,
            "git",
            &["config", "user.email", "test@example.com"],
        );
        run_host(&dir.path, "git", &["config", "user.name", "Bakudo Tests"]);
        // Make the fixture repo self-contained: global git config may enforce
        // commit signing in some CI/sandbox envs, which breaks temp-repo setup.
        run_host(&dir.path, "git", &["config", "commit.gpgsign", "false"]);
        run_host(&dir.path, "git", &["config", "tag.gpgsign", "false"]);
        fs::write(dir.path.join("README.md"), "base\n").unwrap();
        run_host(&dir.path, "git", &["add", "README.md"]);
        run_host(&dir.path, "git", &["commit", "-m", "base"]);
        Self { dir }
    }

    fn path(&self) -> &Path {
        &self.dir.path
    }
}

fn run_host(cwd: &Path, program: &str, args: &[&str]) {
    let output = StdCommand::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{program} {:?} failed:\nstdout:\n{}\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn host_output(cwd: &Path, program: &str, args: &[&str]) -> String {
    let output = StdCommand::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{program} {:?} failed:\nstdout:\n{}\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn write_fake_abox_script(dir: &TempDir, body: &str) -> (PathBuf, PathBuf) {
    let script_path = dir.path.join("fake-abox");
    let temp_path = dir.path.join("fake-abox.tmp");
    let log_path = dir.path.join("invocations.log");
    let script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
# Preflight: bakudo calls `abox --version` at startup to verify the minimum
# version. Answer with a version that satisfies the check without logging the
# invocation, so tests that assert on invocation counts stay stable.
if [[ "${{1:-}}" == "--version" ]]; then
  echo "abox 0.3.1"
  exit 0
fi
{{
  printf '%s\n' "$@"
  printf '__END__\n'
}} >> '{log_path}'
if [[ "${{1:-}}" == "--repo" ]]; then
  shift 2
fi
sub="${{1:-}}"
if [[ -n "$sub" ]]; then
  shift
fi
case "$sub" in
{body}
  *)
    echo "unsupported subcommand: $sub" >&2
    exit 1
    ;;
esac
"#,
        log_path = log_path.display(),
        body = body
    );
    let mut file = fs::File::create(&temp_path).unwrap();
    file.write_all(script.as_bytes()).unwrap();
    file.sync_all().unwrap();
    drop(file);
    fs::rename(&temp_path, &script_path).unwrap();
    let mut perms = fs::metadata(&script_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script_path, perms).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    (script_path, log_path)
}

fn write_mock_deliberator_script(dir: &TempDir, body: &str) -> PathBuf {
    let script_path = dir.path.join("mock-deliberator.py");
    let script = format!(
        r#"#!/usr/bin/env python3
import json, os, sys

with open(os.environ["BAKUDO_WAKE_EVENT_PATH"], "r", encoding="utf-8") as handle:
    wake = json.load(handle)

_next_id = 0

def _send(payload):
    print(json.dumps(payload), flush=True)

def _read():
    line = sys.stdin.readline()
    if not line:
        raise SystemExit("no response from bakudo")
    return json.loads(line)

def call(name, arguments=None):
    global _next_id
    _next_id += 1
    _send({{
        "id": _next_id,
        "method": "tools/call",
        "params": {{
            "name": name,
            "arguments": arguments or {{}}
        }}
    }})
    response = _read()
    if "error" in response and response["error"] is not None:
        raise RuntimeError(response["error"]["message"])
    return response["result"]["result"], response["result"]["meta"]

def call_error(name, arguments=None):
    global _next_id
    _next_id += 1
    _send({{
        "id": _next_id,
        "method": "tools/call",
        "params": {{
            "name": name,
            "arguments": arguments or {{}}
        }}
    }})
    return _read()

{body}
"#
    );
    fs::write(&script_path, script).unwrap();
    let mut perms = fs::metadata(&script_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script_path, perms).unwrap();
    script_path
}

fn write_exec_provider_files(repo: &TempRepo, script_path: &Path) {
    write_exec_provider_files_with_budget(repo, script_path, 20, "5m");
}

fn write_exec_provider_files_with_budget(
    repo: &TempRepo,
    script_path: &Path,
    tool_calls: u32,
    wall_clock: &str,
) {
    let providers_dir = repo.path().join(".bakudo").join("providers");
    fs::create_dir_all(&providers_dir).unwrap();
    let mission = format!(
        "name = \"exec-mission\"\nengine = \"exec\"\nposture = \"mission\"\nengine_args = [{:?}]\nabox_profile = \"dev-broad\"\nsystem_prompt_file = \"prompts/mission.md\"\n[wake_budget]\ntool_calls = {}\nwall_clock = {:?}\ndebounce = \"0.1s\"\n",
        script_path.display().to_string(),
        tool_calls,
        wall_clock,
    );
    let explore = format!(
        "name = \"exec-explore\"\nengine = \"exec\"\nposture = \"explore\"\nengine_args = [{:?}]\nabox_profile = \"dev-broad\"\nsystem_prompt_file = \"prompts/explore.md\"\n[wake_budget]\ntool_calls = {}\nwall_clock = {:?}\ndebounce = \"0.1s\"\n",
        script_path.display().to_string(),
        tool_calls,
        wall_clock,
    );
    fs::write(providers_dir.join("exec-mission.toml"), mission).unwrap();
    fs::write(providers_dir.join("exec-explore.toml"), explore).unwrap();
}

fn read_invocations(log_path: &Path) -> Vec<Vec<String>> {
    let text = fs::read_to_string(log_path).unwrap_or_default();
    let mut invocations = Vec::new();
    let mut current = Vec::new();
    for line in text.lines() {
        if line == "__END__" {
            invocations.push(std::mem::take(&mut current));
        } else {
            current.push(line.to_string());
        }
    }
    if !current.is_empty() {
        invocations.push(current);
    }
    invocations
}

fn invocation_task_id(invocation: &[String]) -> String {
    let task_pos = invocation
        .iter()
        .position(|arg| arg == "--task")
        .expect("invocation has --task");
    invocation[task_pos + 1].clone()
}

fn write_config_file(dir: &TempDir, abox_bin: &Path) -> PathBuf {
    write_config_file_with_data_dir(dir, abox_bin, &dir.path.join("data"))
}

fn write_config_file_with_data_dir(dir: &TempDir, abox_bin: &Path, data_dir: &Path) -> PathBuf {
    let config_path = dir.path.join("bakudo.toml");
    let config = format!(
        "abox_bin = {:?}\nbase_branch = \"main\"\ndata_dir = {:?}\n",
        abox_bin.display().to_string(),
        data_dir.display().to_string()
    );
    fs::write(&config_path, config).unwrap();
    config_path
}

fn bakudo_bin() -> &'static str {
    env!("CARGO_BIN_EXE_bakudo")
}

fn make_record(task_id: &str, state: SandboxState) -> SandboxRecord {
    SandboxRecord {
        attempt_id: AttemptId(format!("attempt-{task_id}")),
        session_id: SessionId("session-runtime".to_string()),
        task_id: task_id.to_string(),
        repo_root: None,
        provider_id: "claude".to_string(),
        model: None,
        prompt_summary: "runtime test".to_string(),
        state,
        lifecycle: Default::default(),
        candidate_policy: CandidatePolicy::Review,
        started_at: Utc::now(),
        finished_at: None,
        worktree_path: None,
        branch: None,
    }
}

fn enter_key() -> KeyEvent {
    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
}

async fn lock_real_abox() -> Option<tokio::sync::MutexGuard<'static, ()>> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let version = StdCommand::new("abox").arg("--version").output().ok()?;
    if !version.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&version.stdout);
    if !stdout.contains("abox 0.3.1") {
        return None;
    }
    Some(
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await,
    )
}

#[tokio::test]
async fn adapter_run_builds_expected_invocation() {
    let dir = TempDir::new("bakudo-fake-abox");
    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "hello from fake abox"
    ;;
"#,
    );
    let repo = dir.path.join("repo");
    fs::create_dir_all(&repo).unwrap();

    let adapter = AboxAdapter::new(&script);
    let mut params = RunParams::new(
        "task-123",
        vec!["bash".to_string(), "-lc".to_string(), "echo hi".to_string()],
    );
    params.repo = Some(repo.clone());
    params.ephemeral = true;
    params.memory_mib = Some(512);
    params.cpus = Some(2);
    params.timeout_secs = Some(9);
    params.env_vars = vec![
        ("A".to_string(), "1".to_string()),
        ("B".to_string(), "two words".to_string()),
    ];

    let lines = Arc::new(Mutex::new(Vec::new()));
    let lines_for_cb = lines.clone();
    let result = adapter
        .run(&params, move |line| {
            lines_for_cb.lock().unwrap().push(line.to_string());
        })
        .await
        .unwrap();

    assert_eq!(result.exit_code, 0);
    assert!(result.stdout.contains("hello from fake abox"));
    assert_eq!(lines.lock().unwrap().as_slice(), ["hello from fake abox"]);

    let invocations = read_invocations(&log);
    assert_eq!(invocations.len(), 1);
    let expected = vec![
        "--repo".to_string(),
        repo.display().to_string(),
        "run".to_string(),
        "--task".to_string(),
        "task-123".to_string(),
        "--ephemeral".to_string(),
        "--memory".to_string(),
        "512".to_string(),
        "--cpus".to_string(),
        "2".to_string(),
        "--timeout".to_string(),
        "9".to_string(),
        "-e".to_string(),
        "A=1".to_string(),
        "-e".to_string(),
        "B=two words".to_string(),
        "--".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        "echo hi".to_string(),
    ];
    assert_eq!(invocations[0], expected);
}

#[tokio::test]
async fn adapter_merge_returns_conflict_paths() {
    let dir = TempDir::new("bakudo-fake-abox");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  merge)
    cat <<'EOF'
  src/lib.rs
  src/main.rs
EOF
    exit 1
    ;;
"#,
    );
    let adapter = AboxAdapter::new(&script);
    let conflicts = adapter.merge(None, "task-merge", "main").await.unwrap();
    assert_eq!(conflicts, vec!["src/lib.rs", "src/main.rs"]);
}

#[tokio::test]
async fn adapter_run_captures_stderr_after_stdout_closes() {
    let dir = TempDir::new("bakudo-fake-abox");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "stderr line one" >&2
    sleep 0.05
    echo "stderr line two" >&2
    ;;
"#,
    );
    let adapter = AboxAdapter::new(&script);
    let params = RunParams::new(
        "task-stderr-only",
        vec!["bash".to_string(), "-lc".to_string(), "true".to_string()],
    );

    let result = adapter.run(&params, |_| {}).await.unwrap();
    assert_eq!(result.exit_code, 0);
    assert!(result.stderr.contains("stderr line one"));
    assert!(result.stderr.contains("stderr line two"));
}

#[tokio::test]
async fn adapter_stop_returns_error_on_failure() {
    let dir = TempDir::new("bakudo-fake-abox");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  stop)
    echo "stop failed" >&2
    exit 7
    ;;
"#,
    );
    let adapter = AboxAdapter::new(&script);
    let err = adapter.stop(None, "task-stop", true).await.unwrap_err();
    match err {
        AboxError::StopFailed { task_id, detail } => {
            assert_eq!(task_id, "task-stop");
            assert!(detail.contains("stop failed"));
        }
        other => panic!("expected StopFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn adapter_list_returns_error_on_failure() {
    let dir = TempDir::new("bakudo-fake-abox");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "list failed" >&2
    exit 9
    ;;
"#,
    );
    let adapter = AboxAdapter::new(&script);
    let err = adapter.list(None).await.unwrap_err();
    match err {
        AboxError::ListFailed { detail } => assert!(detail.contains("list failed")),
        other => panic!("expected ListFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn adapter_run_marks_stdout_as_truncated_when_limit_hit() {
    let dir = TempDir::new("bakudo-fake-abox");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "1234567890"
    ;;
"#,
    );
    let adapter = AboxAdapter::new(&script);
    let mut params = RunParams::new(
        "task-truncated",
        vec!["bash".to_string(), "-lc".to_string(), "true".to_string()],
    );
    params.max_output_bytes = 4;

    let result = adapter.run(&params, |_| {}).await.unwrap();
    assert_eq!(result.exit_code, 0);
    assert!(result.stdout_truncated);
    assert!(result.stdout.len() <= 4);
}

#[tokio::test]
async fn adapter_run_treats_abox_exit_124_as_timeout() {
    let dir = TempDir::new("bakudo-fake-abox");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "sandbox timed out" >&2
    exit 124
    ;;
"#,
    );
    let adapter = AboxAdapter::new(&script);
    let mut params = RunParams::new(
        "task-timeout-124",
        vec![
            "bash".to_string(),
            "-lc".to_string(),
            "sleep 999".to_string(),
        ],
    );
    params.timeout_secs = Some(30);

    let result = adapter.run(&params, |_| {}).await.unwrap();
    assert_eq!(result.exit_code, 124);
    assert!(result.timed_out);
    assert!(result.stderr.contains("sandbox timed out"));
}

#[tokio::test]
async fn task_runner_emits_progress_and_updates_ledger() {
    let dir = TempDir::new("bakudo-task-runner");
    let progress = WorkerProgressEvent {
        attempt_id: AttemptId("attempt-runner-progress".to_string()),
        kind: WorkerProgressKind::AssistantMessage,
        message: "worker is thinking".to_string(),
        timestamp: Utc::now(),
    };
    let progress_line = format!(
        "{} {}",
        WORKER_EVENT_PREFIX,
        serde_json::to_string(&progress).unwrap()
    );
    let (script, _log) = write_fake_abox_script(
        &dir,
        &format!(
            r#"  run)
    cat <<'EOF'
{progress_line}
raw output from worker
EOF
    ;;
"#
        ),
    );

    let ledger = Arc::new(SandboxLedger::new());
    let data_dir = dir.path.join("data");
    let adapter = Arc::new(AboxAdapter::new(&script));
    let cfg = Arc::new(TaskRunnerConfig {
        abox: adapter,
        ledger: ledger.clone(),
        data_dir: data_dir.clone(),
        trace_recorder: bakudo_daemon::trace::TraceRecorder::new(data_dir.clone()),
        worker_command: vec!["fake-worker".to_string(), "--headless".to_string()],
        memory_mib: None,
        cpus: None,
    });

    let mut spec = AttemptSpec::new("say hello", "codex");
    spec.attempt_id = progress.attempt_id.clone();
    spec.session_id = SessionId("session-runner".to_string());
    spec.task_id = TaskId("task-runner".to_string());
    spec.repo_root = Some(dir.path.display().to_string());

    let sandbox_id = sandbox_task_id(&spec.attempt_id.0);
    let (mut rx, handle) = run_attempt(spec, cfg).await;

    let mut saw_progress = false;
    let mut saw_raw = false;
    let mut final_result = None;
    while let Some(event) = rx.recv().await {
        match event {
            RunnerEvent::Progress(evt) => {
                saw_progress = evt.message == "worker is thinking";
            }
            RunnerEvent::RawLine(line) => {
                saw_raw = line == "raw output from worker";
            }
            RunnerEvent::Finished(result) => {
                final_result = Some(result);
                break;
            }
            RunnerEvent::InfraError(err) => panic!("unexpected infra error: {err}"),
        }
    }

    let joined = handle.await.unwrap().unwrap();
    let result = final_result.expect("runner finished event");
    assert_eq!(result.status, WorkerStatus::Succeeded);
    assert_eq!(joined.status, WorkerStatus::Succeeded);
    assert!(saw_progress);
    assert!(saw_raw);

    let record = ledger.get(&sandbox_id).await.unwrap();
    assert_eq!(record.state, SandboxState::Preserved);
    assert!(record.finished_at.is_some());
    assert!(!data_dir.join(format!("{sandbox_id}.spec.json")).exists());
}

#[tokio::test]
async fn task_runner_maps_exit_124_to_timed_out_state() {
    let dir = TempDir::new("bakudo-task-runner-timeout");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "sandbox timed out" >&2
    exit 124
    ;;
"#,
    );

    let ledger = Arc::new(SandboxLedger::new());
    let adapter = Arc::new(AboxAdapter::new(&script));
    let cfg = Arc::new(TaskRunnerConfig {
        abox: adapter,
        ledger: ledger.clone(),
        data_dir: dir.path.join("data"),
        trace_recorder: bakudo_daemon::trace::TraceRecorder::new(dir.path.join("data")),
        worker_command: vec!["fake-worker".to_string()],
        memory_mib: None,
        cpus: None,
    });

    let mut spec = AttemptSpec::new("wait forever", "claude");
    spec.attempt_id = AttemptId("attempt-runner-timeout".to_string());
    let sandbox_id = sandbox_task_id(&spec.attempt_id.0);

    let (mut rx, handle) = run_attempt(spec, cfg).await;
    let mut final_result = None;
    while let Some(event) = rx.recv().await {
        if let RunnerEvent::Finished(result) = event {
            final_result = Some(result);
            break;
        }
    }

    let joined = handle.await.unwrap().unwrap();
    let result = final_result.expect("runner finished event");
    assert_eq!(result.exit_code, 124);
    assert!(result.timed_out);
    assert_eq!(result.status, WorkerStatus::TimedOut);
    assert_eq!(joined.status, WorkerStatus::TimedOut);

    let record = ledger.get(&sandbox_id).await.unwrap();
    assert_eq!(record.state, SandboxState::TimedOut);
    assert!(record.finished_at.is_some());
}

#[tokio::test]
async fn task_runner_marks_nonzero_exit_as_failed() {
    let dir = TempDir::new("bakudo-task-runner-fail");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "worker failed" >&2
    exit 17
    ;;
"#,
    );

    let ledger = Arc::new(SandboxLedger::new());
    let adapter = Arc::new(AboxAdapter::new(&script));
    let cfg = Arc::new(TaskRunnerConfig {
        abox: adapter,
        ledger: ledger.clone(),
        data_dir: dir.path.join("data"),
        trace_recorder: bakudo_daemon::trace::TraceRecorder::new(dir.path.join("data")),
        worker_command: vec!["fake-worker".to_string()],
        memory_mib: None,
        cpus: None,
    });

    let mut spec = AttemptSpec::new("fail please", "codex");
    spec.attempt_id = AttemptId("attempt-runner-fail".to_string());
    let sandbox_id = sandbox_task_id(&spec.attempt_id.0);

    let (mut rx, handle) = run_attempt(spec, cfg).await;
    let mut final_result = None;
    while let Some(event) = rx.recv().await {
        if let RunnerEvent::Finished(result) = event {
            final_result = Some(result);
            break;
        }
    }

    let joined = handle.await.unwrap().unwrap();
    let result = final_result.expect("runner finished event");
    assert_eq!(result.status, WorkerStatus::Failed);
    assert_eq!(result.exit_code, 17);
    assert_eq!(result.summary, "worker failed");
    assert_eq!(joined.status, WorkerStatus::Failed);

    let record = ledger.get(&sandbox_id).await.unwrap();
    assert_eq!(record.state, SandboxState::Failed { exit_code: 17 });
    assert!(record.finished_at.is_some());
}

#[tokio::test]
async fn apply_candidate_policy_tracks_merge_conflicts_as_terminal() {
    let dir = TempDir::new("bakudo-worktree-policy");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  merge)
    cat <<'EOF'
  src/lib.rs
  src/main.rs
EOF
    exit 1
    ;;
"#,
    );
    let adapter = AboxAdapter::new(&script);
    let ledger = Arc::new(SandboxLedger::new());
    ledger
        .insert(make_record("task-conflicts", SandboxState::Preserved))
        .await;

    let action = apply_candidate_policy(
        "task-conflicts",
        &CandidatePolicy::AutoApply,
        "main",
        None,
        &adapter,
        &ledger,
    )
    .await
    .unwrap();

    match action {
        WorktreeAction::MergeConflicts(conflicts) => {
            assert_eq!(conflicts, vec!["src/lib.rs", "src/main.rs"]);
        }
        other => panic!("expected conflicts, got {other:?}"),
    }

    let record = ledger.get("task-conflicts").await.unwrap();
    assert_eq!(record.state, SandboxState::MergeConflicts);
    assert!(record.finished_at.is_some());
}

#[tokio::test]
async fn session_controller_diverge_uses_configured_base_branch() {
    let dir = TempDir::new("bakudo-session-controller");
    let repo = TempRepo::new();
    fs::write(repo.path().join("diverge.txt"), "base\n").unwrap();
    run_host(repo.path(), "git", &["add", "diverge.txt"]);
    run_host(repo.path(), "git", &["commit", "-m", "add base file"]);
    run_host(repo.path(), "git", &["checkout", "-b", "agent/task-123"]);
    fs::write(repo.path().join("diverge.txt"), "base\nchanged\n").unwrap();
    run_host(repo.path(), "git", &["add", "diverge.txt"]);
    run_host(repo.path(), "git", &["commit", "-m", "branch change"]);
    run_host(repo.path(), "git", &["checkout", "main"]);

    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
"#,
    );

    let config = BakudoConfig {
        abox_bin: script.display().to_string(),
        base_branch: "main".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let controller = SessionController::with_session(
        Arc::new(config),
        Arc::new(AboxAdapter::new(&script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-diverge".to_string()),
                "claude",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::Diverge {
            task_id: "task-123".to_string(),
        })
        .await
        .unwrap();

    let msg = timeout(Duration::from_secs(1), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::Info(msg)) if msg.contains("[task-123]") => break msg,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert!(msg.contains("Divergence"));
    assert!(msg.contains("M\tdiverge.txt"));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();

    let invocations = read_invocations(&log);
    assert_eq!(
        invocations.len(),
        1,
        "expected only the startup list invocation"
    );
    assert!(invocations[0].iter().any(|arg| arg == "list"));
}

#[tokio::test]
async fn session_controller_diff_uses_task_branch() {
    let dir = TempDir::new("bakudo-session-diff");
    let repo = TempRepo::new();
    run_host(repo.path(), "git", &["checkout", "-b", "agent/task-diff"]);
    fs::write(repo.path().join("diff-target.txt"), "before\nafter\n").unwrap();
    run_host(repo.path(), "git", &["add", "diff-target.txt"]);
    run_host(repo.path(), "git", &["commit", "-m", "diff change"]);
    run_host(repo.path(), "git", &["checkout", "main"]);

    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
"#,
    );

    let config = BakudoConfig {
        abox_bin: script.display().to_string(),
        base_branch: "main".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let controller = SessionController::with_session(
        Arc::new(config),
        Arc::new(AboxAdapter::new(&script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-diff".to_string()),
                "claude",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::Diff {
            task_id: "task-diff".to_string(),
        })
        .await
        .unwrap();

    let msg = timeout(Duration::from_secs(1), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::Info(msg)) if msg.contains("[task-diff]") => break msg,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert!(msg.contains("Diff"));
    assert!(msg.contains("+++ b/diff-target.txt"));
    assert!(msg.contains("+before"));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn session_controller_resume_only_filters_snapshot_to_requested_session() {
    let dir = TempDir::new("bakudo-session-resume");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
"#,
    );

    let mut keep = make_record("task-keep", SandboxState::Preserved);
    keep.session_id = SessionId("session-resume".to_string());
    let mut drop = make_record("task-drop", SandboxState::Preserved);
    drop.session_id = SessionId("session-other".to_string());
    let ledger = Arc::new(SandboxLedger::new());
    ledger.insert(keep).await;
    ledger.insert(drop).await;

    let config = BakudoConfig {
        abox_bin: script.display().to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let controller = SessionController::with_session(
        Arc::new(config),
        Arc::new(AboxAdapter::new(&script)),
        ledger,
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-resume".to_string()),
                "claude",
                None,
                None,
            ),
            resume_only: true,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());

    let entries = timeout(Duration::from_secs(1), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::LedgerSnapshot { entries }) => break entries,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].task_id, "task-keep");

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn session_controller_reports_failed_tasks_as_failed() {
    let dir = TempDir::new("bakudo-session-failed");
    let script = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    echo "worker exploded"
    exit 23
    ;;
"#,
    )
    .0;

    let config = BakudoConfig {
        abox_bin: script.display().to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(32);
    let controller = SessionController::new(
        Arc::new(config),
        Arc::new(AboxAdapter::new(&script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::Dispatch {
            prompt: "break immediately".to_string(),
            approved: false,
        })
        .await
        .unwrap();

    let final_state = timeout(Duration::from_secs(2), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::TaskFinished { state, .. }) => break state,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(final_state, SandboxState::Failed { exit_code: 23 });

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn session_controller_requires_approval_when_policy_prompts() {
    let dir = TempDir::new("bakudo-session-approval");
    let script = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    echo "approved run"
    ;;
"#,
    )
    .0;

    let config = BakudoConfig {
        abox_bin: script.display().to_string(),
        data_dir: Some(dir.path.join("data")),
        execution_policy: ExecutionPolicy {
            default_decision: PolicyDecision::Prompt,
            default_allow_all_tools: true,
            rules: vec![ExecutionPolicyRule {
                provider: "claude".to_string(),
                decision: PolicyDecision::Prompt,
                allow_all_tools: Some(true),
            }],
        },
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(32);
    let controller = SessionController::new(
        Arc::new(config),
        Arc::new(AboxAdapter::new(&script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::Dispatch {
            prompt: "needs approval".to_string(),
            approved: false,
        })
        .await
        .unwrap();

    let first_error = timeout(Duration::from_secs(1), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::Error(msg)) => break msg,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert!(first_error.contains("requires approval"));

    cmd_tx
        .send(SessionCommand::Dispatch {
            prompt: "approved".to_string(),
            approved: true,
        })
        .await
        .unwrap();

    let saw_started = timeout(Duration::from_secs(2), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::TaskStarted { prompt_summary, .. }) => break prompt_summary,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert!(saw_started.contains("approved"));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn session_controller_routes_host_objectives_into_direct_mission_start() {
    let dir = TempDir::new("bakudo-session-host-plan");
    let script = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    echo "worker completed"
    ;;
"#,
    )
    .0;

    let config = BakudoConfig {
        abox_bin: script.display().to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(16);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let controller = SessionController::new(
        Arc::new(config),
        Arc::new(AboxAdapter::new(&script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());

    cmd_tx
        .send(SessionCommand::HostInput {
            text: "Restore the missing host layer".to_string(),
        })
        .await
        .unwrap();
    let first_reply = timeout(Duration::from_secs(1), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::Info(msg)) => break msg,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert!(first_reply.contains("Starting mission"));

    let mut saw_banner = false;
    timeout(Duration::from_secs(2), async {
        while !saw_banner {
            match event_rx.recv().await {
                Some(SessionEvent::MissionUpdated { banner }) => {
                    if let Some(banner) = banner {
                        saw_banner = banner.goal.contains("Restore the missing host layer");
                    }
                }
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert!(saw_banner);

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn session_controller_answers_progress_queries_from_host_layer() {
    let dir = TempDir::new("bakudo-session-host-progress");
    let script = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    echo "worker is warming up"
    sleep 1
    echo "worker completed"
    ;;
"#,
    )
    .0;

    let config = BakudoConfig {
        abox_bin: script.display().to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(16);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let controller = SessionController::new(
        Arc::new(config),
        Arc::new(AboxAdapter::new(&script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::Dispatch {
            prompt: "do a long-running thing".to_string(),
            approved: false,
        })
        .await
        .unwrap();

    timeout(Duration::from_secs(1), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::TaskStarted { .. }) => break,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();

    cmd_tx
        .send(SessionCommand::HostInput {
            text: "Tell me about how things are progressing".to_string(),
        })
        .await
        .unwrap();

    let progress_reply = timeout(Duration::from_secs(1), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::Info(msg)) if msg.contains("running 1") => break msg,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    assert!(progress_reply.contains("Host status"));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_completes_wake_flow_and_persists_mission_state() {
    let dir = TempDir::new("bakudo-mission-runtime");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
if wake["reason"] in ("manual_resume", "user_message"):
    call("update_mission_state", {"patch": {"next_steps": ["wave-1"], "best_known": {"label": "baseline", "score": 0}}})
    call("dispatch_swarm", {
        "experiments": [{
            "label": "wave-1",
            "hypothesis": "measure baseline",
            "base_branch": "main",
            "workload": {
                "kind": "script",
                "script": {"kind": "inline", "source": "echo '{\"score\": 42}'"}
            },
            "metric_keys": ["score"]
        }],
        "wake_when": "all_complete"
    })
    call("suspend", {"reason": "experiments_dispatched"})
elif wake["reason"] == "experiments_complete":
    call("update_mission_state", {"patch": {"best_known": {"label": "wave-1", "score": 42}, "next_steps": []}})
    call("complete_mission", {"summary": "wave-1 finished with score 42"})
else:
    call("complete_mission", {"summary": "mission ended without extra work"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );

    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-mission".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());

    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Persist wake state".to_string(),
            done_contract: Some("score must be recorded".to_string()),
            constraints: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mut observed_events = Vec::new();
    let mission_wait = timeout(Duration::from_secs(3), async {
        loop {
            while let Ok(event) = event_rx.try_recv() {
                observed_events.push(format!("{event:?}"));
            }
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                break mission;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    let mission = match mission_wait {
        Ok(mission) => mission,
        Err(_) => {
            let missions = store.list_missions().await.unwrap();
            let experiments = if let Some(mission) = missions.first() {
                store.experiments_for_mission(mission.id).await.unwrap()
            } else {
                Vec::new()
            };
            panic!(
                "missions after timeout: {:?}\nexperiments: {:?}\nobserved events: {:?}",
                missions, experiments, observed_events,
            );
        }
    };

    let mission_state = store.mission_state(mission.id).await.unwrap();
    assert_eq!(mission_state.0["best_known"]["score"].as_i64(), Some(42));
    let experiments = store.experiments_for_mission(mission.id).await.unwrap();
    assert_eq!(experiments.len(), 1);
    assert_eq!(experiments[0].status, ExperimentStatus::Succeeded);

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_dispatches_multiple_waves() {
    let dir = TempDir::new("bakudo-multi-wave-runtime");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
if wake["reason"] == "manual_resume":
    call("dispatch_swarm", {
        "experiments": [{
            "label": "wave-1",
            "hypothesis": "first pass",
            "base_branch": "main",
            "workload": {
                "kind": "script",
                "script": {"kind": "inline", "source": "echo '{\"score\": 21}'"}
            },
            "metric_keys": ["score"]
        }],
        "wake_when": "all_complete"
    })
    call("suspend", {"reason": "wave-1"})
elif wake["reason"] == "experiments_complete":
    experiments = wake["payload"]["experiments"]
    if experiments[0]["label"] == "wave-1":
        call("update_mission_state", {"patch": {"next_steps": ["wave-2"]}})
        call("dispatch_swarm", {
            "experiments": [{
                "label": "wave-2",
                "hypothesis": "second pass",
                "base_branch": "main",
                "workload": {
                    "kind": "script",
                    "script": {"kind": "inline", "source": "echo '{\"score\": 84}'"}
                },
                "metric_keys": ["score"]
            }],
            "wake_when": "all_complete"
        })
        call("suspend", {"reason": "wave-2"})
    else:
        call("update_mission_state", {"patch": {
            "best_known": {"label": "wave-2", "score": 84},
            "next_steps": []
        }})
        call("complete_mission", {"summary": "wave-2 finished with score 84"})
else:
    call("complete_mission", {"summary": "mission ended without extra work"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );

    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };

    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-multi-wave".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());

    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Run multiple waves".to_string(),
            done_contract: Some("second wave should complete".to_string()),
            constraints: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mut observed_events = Vec::new();
    let mission_wait = timeout(Duration::from_secs(3), async {
        loop {
            while let Ok(event) = event_rx.try_recv() {
                observed_events.push(format!("{event:?}"));
            }
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                break mission;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    let mission = match mission_wait {
        Ok(mission) => mission,
        Err(_) => {
            let missions = store.list_missions().await.unwrap();
            let experiments = if let Some(mission) = missions.first() {
                store.experiments_for_mission(mission.id).await.unwrap()
            } else {
                Vec::new()
            };
            panic!(
                "missions after timeout: {:?}\nexperiments: {:?}\nobserved events: {:?}",
                missions, experiments, observed_events,
            );
        }
    };

    let mission_state = store.mission_state(mission.id).await.unwrap();
    assert_eq!(
        mission_state.0["best_known"]["label"].as_str(),
        Some("wave-2")
    );
    assert_eq!(mission_state.0["best_known"]["score"].as_i64(), Some(84));
    let experiments = store.experiments_for_mission(mission.id).await.unwrap();
    assert_eq!(experiments.len(), 2);
    assert!(experiments
        .iter()
        .all(|experiment| experiment.status == ExperimentStatus::Succeeded));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_enforces_wallet_on_dispatch_swarm() {
    let dir = TempDir::new("bakudo-wallet-enforcement");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
experiments = [{
    "label": f"exp-{idx}",
    "hypothesis": "overflow wallet",
    "base_branch": "main",
    "workload": {
        "kind": "script",
        "script": {"kind": "inline", "source": "echo wallet"}
    },
    "metric_keys": []
} for idx in range(13)]
response = call_error("dispatch_swarm", {"experiments": experiments, "wake_when": "all_complete"})
assert response.get("error"), response
call("complete_mission", {"summary": "wallet rejected oversized wave"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, _event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-wallet".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Reject oversized wave".to_string(),
            done_contract: None,
            constraints: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mission = timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                break mission;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert!(store
        .experiments_for_mission(mission.id)
        .await
        .unwrap()
        .is_empty());

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_bootstraps_prompt_as_argument_and_keeps_stdio_for_tools() {
    let dir = TempDir::new("bakudo-prompt-bootstrap");
    let repo = TempRepo::new();
    let prompt_log = dir.path.join("deliberator-prompt.txt");
    let script = write_mock_deliberator_script(
        &dir,
        &format!(
            r#"
with open({prompt_log:?}, "w", encoding="utf-8") as handle:
    handle.write(sys.argv[1] if len(sys.argv) > 1 else "")

plan, _meta = call("read_plan")
assert "Mission Plan" in plan["markdown"]
call("complete_mission", {{"summary": "prompt bootstrap completed"}})
"#,
            prompt_log = prompt_log.display().to_string(),
        ),
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, _event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-prompt-bootstrap".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Bootstrap the wake prompt".to_string(),
            done_contract: Some("Verify prompt transport and tool IO".to_string()),
            constraints: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mission = timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                break mission;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();

    let prompt = fs::read_to_string(&prompt_log).unwrap();
    assert!(prompt.contains("You are the Bakudo mission conductor operating in MISSION posture."));
    assert!(prompt.contains("Tool transport:"));
    assert!(prompt.contains("Bootstrap the wake prompt"));
    assert!(prompt.contains("\"reason\": \"manual_resume\""));
    assert!(prompt.contains("\"method\":\"tools/call\""));

    let provider_trace_path = config
        .resolved_repo_data_dir(Some(repo.path()))
        .join("traces")
        .join("missions")
        .join(mission.id.to_string())
        .join("wakes");
    assert!(provider_trace_path.exists());

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_requests_host_approval_for_host_exec() {
    let dir = TempDir::new("bakudo-host-approval");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
result, _meta = call("host_exec", {"command": "echo host-ok", "reason": "verify approval"})
assert result["approved"] is True
assert "host-ok" in result["stdout_tail"]
call("complete_mission", {"summary": "host exec approval path completed"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-approval".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Approve host exec".to_string(),
            done_contract: None,
            constraints: None,
        })
        .await
        .unwrap();

    let mut observed_events = Vec::new();
    let approval_wait = timeout(Duration::from_secs(2), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::ApprovalRequested { request_id, .. }) => break request_id,
                Some(event) => observed_events.push(format!("{event:?}")),
                None => panic!("event channel closed"),
            }
        }
    })
    .await;
    let request_id = match approval_wait {
        Ok(request_id) => request_id,
        Err(_) => panic!(
            "mission events timed out before approval; observed events: {:?}",
            observed_events
        ),
    };
    cmd_tx
        .send(SessionCommand::ResolveHostApproval {
            request_id,
            approved: true,
            edited_command: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if missions
                .iter()
                .any(|mission| mission.status == MissionStatus::Completed)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_asks_user_and_records_answer() {
    let dir = TempDir::new("bakudo-ask-user");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
result, _meta = call("ask_user", {
    "question": "Choose the next step",
    "choices": ["wave-1", "wave-2"]
})
assert result["answer"] == "wave-2"
call("complete_mission", {"summary": "user answered the blocking question"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, mut event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-ask-user".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Ask the user".to_string(),
            done_contract: None,
            constraints: None,
        })
        .await
        .unwrap();

    let request_id = timeout(Duration::from_secs(2), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::UserQuestionRequested { request_id, .. }) => break request_id,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();
    cmd_tx
        .send(SessionCommand::AnswerUserQuestion {
            request_id,
            answer: "wave-2".to_string(),
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mission = timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                break mission;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let ledger = store.recent_ledger(mission.id, 8).await.unwrap();
    assert!(ledger.iter().any(|entry| entry.summary.contains("wave-2")
        && entry.kind == bakudo_core::mission::LedgerKind::UserSteering));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_records_lessons_to_repo_storage() {
    let dir = TempDir::new("bakudo-record-lesson");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
result, _meta = call("record_lesson", {
    "title": "Start with the baseline",
    "body": "Measure the baseline before dispatching a second wave."
})
assert result["path"].endswith(".md")
call("complete_mission", {"summary": "lesson recorded"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, _event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-record-lesson".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Record a lesson".to_string(),
            done_contract: None,
            constraints: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mission = timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                break mission;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let lessons_dir = repo.path().join(".bakudo").join("lessons");
    let lesson_entries = fs::read_dir(&lessons_dir)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(lesson_entries.len(), 1);
    let lesson_text = fs::read_to_string(lesson_entries[0].path()).unwrap();
    assert!(lesson_text.contains("Start with the baseline"));
    let ledger = store.recent_ledger(mission.id, 8).await.unwrap();
    assert!(ledger
        .iter()
        .any(|entry| entry.kind == bakudo_core::mission::LedgerKind::Lesson));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_writes_append_only_provenance_log() {
    let dir = TempDir::new("bakudo-provenance");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
call("update_mission_state", {"patch": {"next_steps": ["done"]}})
call("complete_mission", {"summary": "provenance mission completed"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, _event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-provenance".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Write provenance".to_string(),
            done_contract: None,
            constraints: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mission = timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                break mission;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();

    let provenance_path = repo
        .path()
        .join(".bakudo")
        .join("provenance")
        .join(format!("{}.ndjson", mission.id));
    let provenance = fs::read_to_string(&provenance_path).unwrap();
    let events: Vec<serde_json::Value> = provenance
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(events.iter().any(|entry| entry["event"] == "wake_queued"));
    assert!(events.iter().any(|entry| entry["event"] == "wake_started"));
    assert!(events
        .iter()
        .any(|entry| { entry["event"] == "tool_call" && entry["tool"] == "update_mission_state" }));
    assert!(events.iter().any(|entry| entry["event"] == "wake_finished"));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_enforces_per_wake_tool_call_budget() {
    let dir = TempDir::new("bakudo-wake-budget");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
if wake["reason"] == "manual_resume":
    call("update_mission_state", {"patch": {"next_steps": ["first"]}})
    response = call_error("update_mission_state", {"patch": {"next_steps": ["second"]}})
    assert response["error"]["message"].startswith("wake tool-call budget exhausted")
elif wake["reason"] == "timeout":
    assert wake["payload"]["kind"] == "wake_budget_tool_calls"
    call("complete_mission", {"summary": "wake budget exhaustion handled"})
else:
    call("complete_mission", {"summary": "wake budget mission completed"})
"#,
    );
    write_exec_provider_files_with_budget(&repo, &script, 1, "5m");
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, _event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-wake-budget".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::StartMission {
            posture: Posture::Mission,
            goal: "Enforce wake budget".to_string(),
            done_contract: None,
            constraints: None,
        })
        .await
        .unwrap();

    let store = MissionStore::open(
        config
            .resolved_repo_data_dir(Some(repo.path()))
            .join("state.db"),
    )
    .unwrap();
    let mission = timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if let Some(mission) = missions
                .into_iter()
                .find(|mission| mission.status == MissionStatus::Completed)
            {
                let wakes = store.unprocessed_wakes(Some(mission.id)).await.unwrap();
                if wakes.is_empty() {
                    break mission;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();

    let wakes = store.unprocessed_wakes(Some(mission.id)).await.unwrap();
    assert!(wakes.is_empty());
    let provenance_path = repo
        .path()
        .join(".bakudo")
        .join("provenance")
        .join(format!("{}.ndjson", mission.id));
    let provenance = fs::read_to_string(&provenance_path).unwrap();
    assert!(provenance.contains("\"event\":\"wake_budget_exhausted\""));
    assert!(provenance.contains("\"kind\":\"tool_calls\""));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn mission_runtime_recovers_running_experiment_on_restart() {
    let dir = TempDir::new("bakudo-mission-recovery");
    let repo = TempRepo::new();
    let script = write_mock_deliberator_script(
        &dir,
        r#"
call("complete_mission", {"summary": "restart recovery completed"})
"#,
    );
    write_exec_provider_files(&repo, &script);
    let (abox_script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    while [[ "$1" != "--" ]]; do shift; done
    shift
    "$@"
    ;;
  stop)
    ;;
"#,
    );
    let config = BakudoConfig {
        abox_bin: abox_script.display().to_string(),
        default_provider: "exec".to_string(),
        data_dir: Some(dir.path.join("data")),
        ..Default::default()
    };
    let repo_data_dir = config.resolved_repo_data_dir(Some(repo.path()));
    let store = MissionStore::open(repo_data_dir.join("state.db")).unwrap();
    let mission = Mission {
        id: MissionId::new(),
        goal: "Recover after restart".to_string(),
        posture: Posture::Mission,
        provider_name: "exec-mission".to_string(),
        abox_profile: "dev-broad".to_string(),
        wallet: Wallet::default(),
        status: MissionStatus::Sleeping,
        created_at: Utc::now(),
        completed_at: None,
    };
    store.upsert_mission(&mission).await.unwrap();
    store
        .save_mission_state(mission.id, &MissionState::default_layout())
        .await
        .unwrap();
    store
        .upsert_experiment(&Experiment {
            id: bakudo_core::mission::ExperimentId::new(),
            mission_id: mission.id,
            label: "stale-running".to_string(),
            spec: bakudo_core::mission::ExperimentSpec {
                base_branch: "main".to_string(),
                workload: bakudo_core::mission::ExperimentWorkload::Script {
                    script: bakudo_core::mission::ExperimentScript::Inline {
                        source: "echo stale".to_string(),
                    },
                },
                skill: None,
                hypothesis: "stale".to_string(),
                metric_keys: Vec::new(),
            },
            status: ExperimentStatus::Running,
            started_at: Some(Utc::now()),
            finished_at: None,
            summary: None,
        })
        .await
        .unwrap();

    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let (event_tx, _event_rx) = mpsc::channel(64);
    let controller = SessionController::with_session(
        Arc::new(config.clone()),
        Arc::new(AboxAdapter::new(&abox_script)),
        Arc::new(SandboxLedger::new()),
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-recovery".to_string()),
                "exec",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    let handle = tokio::spawn(controller.run());

    timeout(Duration::from_secs(3), async {
        loop {
            let missions = store.list_missions().await.unwrap();
            if missions.iter().any(|candidate| {
                candidate.id == mission.id && candidate.status == MissionStatus::Completed
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let recovered = store.experiments_for_mission(mission.id).await.unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].status, ExperimentStatus::Failed);

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[test]
fn app_can_reload_persisted_transcript() {
    let dir = TempDir::new("bakudo-transcript-store");
    let store = TranscriptStore::new(dir.path.join("session.jsonl"));

    let (cmd_tx, _cmd_rx) = mpsc::channel(8);
    let (_event_tx, event_rx) = mpsc::channel(8);
    let mut app = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
        Some(store.clone()),
        false,
    );
    app.push_message(ChatMessage::user("hello"));
    app.push_message(ChatMessage::info("world"));

    let (cmd_tx, _cmd_rx) = mpsc::channel(8);
    let (_event_tx, event_rx) = mpsc::channel(8);
    let mut resumed = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
        Some(store),
        false,
    );
    resumed.load_transcript();

    assert_eq!(resumed.transcript.len(), 2);
    assert_eq!(resumed.transcript.front().unwrap().role, MessageRole::User);
    assert!(resumed.transcript.back().unwrap().content.contains("world"));
}

#[test]
fn app_routes_freeform_input_through_host_layer() {
    let (cmd_tx, mut cmd_rx) = mpsc::channel(8);
    let (_event_tx, event_rx) = mpsc::channel(8);
    let mut app = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
        None,
        true,
    );

    app.input = "Restore the missing host layer".to_string();
    app.cursor = app.input.len();
    app.handle_input_key(enter_key());

    match cmd_rx.try_recv() {
        Ok(SessionCommand::HostInput { text }) => {
            assert!(text.contains("Restore the missing host layer"));
        }
        other => panic!("expected HostInput command, got {other:?}"),
    }
}

#[test]
fn bakudo_run_cli_forwards_prompt_to_provider_and_discards() {
    let dir = TempDir::new("bakudo-cli-run");
    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "FAKE_PROVIDER_OUTPUT"
    ;;
  stop)
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let prompt = "Reply with exactly TEST_OK.";

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "run",
            "-p",
            "codex",
            "--discard",
            prompt,
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "bakudo run failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Dispatching task"));
    assert!(stdout.contains("FAKE_PROVIDER_OUTPUT"));
    assert!(stdout.contains("Task finished: Succeeded"));
    assert!(stdout.contains("Worktree discarded."));

    let invocations = read_invocations(&log);
    assert_eq!(invocations.len(), 2, "expected run + stop invocations");

    let run_invocation = &invocations[0];
    assert!(run_invocation
        .windows(2)
        .any(|window| window[0] == "--memory" && window[1] == "4096"));
    assert!(run_invocation
        .windows(2)
        .any(|window| window[0] == "--cpus" && window[1] == "2"));
    let task_pos = run_invocation
        .iter()
        .position(|arg| arg == "--task")
        .expect("run invocation has --task");
    let task_id = run_invocation[task_pos + 1].clone();
    assert!(task_id.starts_with("bakudo-attempt-"));
    assert!(run_invocation
        .iter()
        .any(|arg| arg == &format!("BAKUDO_PROMPT={prompt}")));
    assert!(run_invocation
        .iter()
        .any(|arg| arg.starts_with("BAKUDO_SPEC_PATH=")));
    assert!(run_invocation
        .iter()
        .any(|arg| arg == &format!("BAKUDO_TASK_ID={task_id}")));
    assert!(run_invocation
        .iter()
        .any(|arg| arg == "BAKUDO_PROTOCOL_SCHEMA_VERSION=1"));
    assert!(run_invocation
        .iter()
        .any(|arg| arg.starts_with("BAKUDO_ATTEMPT_ID=")));
    assert!(run_invocation
        .iter()
        .any(|arg| arg.starts_with("BAKUDO_SESSION_ID=")));

    let command_start = run_invocation
        .iter()
        .position(|arg| arg == "--")
        .expect("run invocation has command delimiter");
    assert_eq!(run_invocation[command_start + 1], "python3");
    assert_eq!(run_invocation[command_start + 2], "-c");
    assert!(run_invocation
        .iter()
        .any(|arg| arg.contains("BAKUDO_RESULT")));
    assert!(run_invocation.iter().any(|arg| arg == "codex"));
    assert!(run_invocation.iter().any(|arg| arg == "exec"));
    assert!(run_invocation.iter().any(|arg| arg == "--full-auto"));

    let stop_invocation = &invocations[1];
    assert!(stop_invocation.iter().any(|arg| arg == "stop"));
    assert!(stop_invocation.iter().any(|arg| arg == &task_id));
    assert!(stop_invocation.iter().any(|arg| arg == "--clean"));
}

#[test]
fn bakudo_sessions_lists_saved_sessions_for_current_repo() {
    let dir = TempDir::new("bakudo-cli-sessions");
    let script = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
"#,
    )
    .0;
    let data_dir = dir.path.join("saved-sessions");
    let config = write_config_file_with_data_dir(&dir, &script, &data_dir);
    let repo = TempRepo::new();
    let other_repo = TempRepo::new();
    let nested_dir = repo.path().join("nested").join("workspace");
    fs::create_dir_all(&nested_dir).unwrap();

    let mut current = SessionRecord::with_id(
        SessionId("session-current".to_string()),
        "codex",
        Some("gpt-5".to_string()),
        Some(repo.path().display().to_string()),
    );
    current.started_at = Utc.timestamp_opt(1_800_000_000, 0).single().unwrap();
    current.save(&data_dir).unwrap();

    let mut other = SessionRecord::with_id(
        SessionId("session-other".to_string()),
        "claude",
        None,
        Some(other_repo.path().display().to_string()),
    );
    other.started_at = Utc.timestamp_opt(1_700_000_000, 0).single().unwrap();
    other.save(&data_dir).unwrap();

    let output = StdCommand::new(bakudo_bin())
        .args(["-c", config.to_str().unwrap(), "sessions"])
        .current_dir(&nested_dir)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "bakudo sessions failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("SESSION ID"));
    assert!(stdout.contains("session-current"));
    assert!(!stdout.contains("session-other"));
    assert!(stdout.contains(&repo.path().display().to_string()));
}

#[test]
fn bakudo_run_cli_emits_json_and_validates_schema() {
    let dir = TempDir::new("bakudo-cli-json");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "JSON_PROVIDER_OUTPUT"
    ;;
  stop)
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let schema_path = dir.path.join("summary.schema.json");
    fs::write(
        &schema_path,
        r#"{
  "type": "object",
  "required": ["task_id", "worker_status", "worktree_action"],
  "properties": {
    "worker_status": { "const": "succeeded" },
    "worktree_action": { "const": "discarded" }
  }
}"#,
    )
    .unwrap();

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "run",
            "-p",
            "codex",
            "--discard",
            "--json",
            "--output-schema",
            schema_path.to_str().unwrap(),
            "Return JSON",
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "bakudo run --json failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout
        .lines()
        .any(|line| line.contains("\"event\":\"task_started\"")));
    assert!(stdout
        .lines()
        .any(|line| line.contains("\"event\":\"finished\"")));
    assert!(stdout.contains("\"worker_status\":\"succeeded\""));
    assert!(stdout.contains("\"worktree_action\":\"discarded\""));
}

#[test]
fn bakudo_run_cli_executes_post_run_hook() {
    let dir = TempDir::new("bakudo-cli-hook");
    let payload_path = dir.path.join("hook-payload.json");
    let hook_script = dir.path.join("hook.sh");
    fs::write(
        &hook_script,
        format!(
            "#!/usr/bin/env bash\nset -euo pipefail\ncat > '{}'\n",
            payload_path.display()
        ),
    )
    .unwrap();
    let mut perms = fs::metadata(&hook_script).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&hook_script, perms).unwrap();

    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "HOOK_PROVIDER_OUTPUT"
    ;;
  stop)
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    fs::OpenOptions::new()
        .append(true)
        .open(&config)
        .unwrap()
        .write_all(
            format!(
                "post_run_hook = [{:?}]\n",
                hook_script.display().to_string()
            )
            .as_bytes(),
        )
        .unwrap();
    let repo = TempRepo::new();

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "run",
            "-p",
            "codex",
            "--discard",
            "Run hook",
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "bakudo run with hook failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let payload: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&payload_path).unwrap()).unwrap();
    assert_eq!(payload["worker_status"], "succeeded");
    assert_eq!(payload["worktree_action"], "discarded");
    assert_eq!(payload["provider_id"], "codex");
}

#[test]
fn bakudo_run_cli_does_not_apply_policy_after_failure() {
    let dir = TempDir::new("bakudo-cli-failed-policy");
    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "provider failed" >&2
    exit 19
    ;;
  stop)
    echo "unexpected stop"
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "run",
            "-p",
            "codex",
            "--discard",
            "Fail without discard",
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "expected failed headless run:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let invocations = read_invocations(&log);
    assert_eq!(
        invocations.len(),
        1,
        "failed run should not call stop/merge"
    );
}

#[test]
fn bakudo_result_cli_reads_persisted_summary() {
    let dir = TempDir::new("bakudo-cli-result");
    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "RESULT_PROVIDER_OUTPUT"
    ;;
  stop)
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();

    let run_output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "run",
            "-p",
            "codex",
            "--discard",
            "persist a result",
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();
    assert!(
        run_output.status.success(),
        "bakudo run failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&run_output.stdout),
        String::from_utf8_lossy(&run_output.stderr)
    );

    let invocations = read_invocations(&log);
    let task_id = invocation_task_id(&invocations[0]);
    let result_output = StdCommand::new(bakudo_bin())
        .args(["-c", config.to_str().unwrap(), "result", "--json", &task_id])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        result_output.status.success(),
        "bakudo result failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&result_output.stdout),
        String::from_utf8_lossy(&result_output.stderr)
    );
    let stdout = String::from_utf8_lossy(&result_output.stdout);
    assert!(stdout.contains(&format!("\"task_id\":\"{task_id}\"")));
    assert!(stdout.contains("\"worker_status\":\"succeeded\""));
    assert!(stdout.contains("\"final_state\":\"discarded\""));
    assert!(stdout.contains("\"worktree_action\":\"discarded\""));
}

#[tokio::test]
async fn bakudo_wait_cli_observes_session_controller_result() {
    let dir = TempDir::new("bakudo-cli-wait");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
  run)
    sleep 0.4
    echo "WAIT_PROVIDER_OUTPUT"
    ;;
"#,
    );
    let config_path = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let loaded_config = Arc::new(BakudoConfig::load(&config_path).unwrap());
    let repo_data_dir = loaded_config.resolved_repo_data_dir(Some(repo.path()));
    let ledger = Arc::new(SandboxLedger::with_persistence(
        repo_data_dir.join("ledger.jsonl"),
    ));

    let (cmd_tx, cmd_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(32);
    let controller = SessionController::with_session(
        loaded_config.clone(),
        Arc::new(AboxAdapter::new(&script)),
        ledger,
        Arc::new(ProviderRegistry::with_defaults()),
        SessionBootstrap {
            session: SessionRecord::with_id(
                SessionId("session-wait".to_string()),
                "codex",
                None,
                Some(repo.path().display().to_string()),
            ),
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::Dispatch {
            prompt: "wait for me".to_string(),
            approved: false,
        })
        .await
        .unwrap();

    let task_id = timeout(Duration::from_secs(2), async {
        loop {
            match event_rx.recv().await {
                Some(SessionEvent::TaskStarted { task_id, .. }) => break task_id,
                Some(_) => continue,
                None => panic!("event channel closed"),
            }
        }
    })
    .await
    .unwrap();

    let config_for_wait = config_path.clone();
    let repo_for_wait = repo.path().to_path_buf();
    let task_for_wait = task_id.clone();
    let wait_output = tokio::task::spawn_blocking(move || {
        StdCommand::new(bakudo_bin())
            .args([
                "-c",
                config_for_wait.to_str().unwrap(),
                "wait",
                "--json",
                "--timeout-secs",
                "5",
                &task_for_wait,
            ])
            .current_dir(repo_for_wait)
            .output()
            .unwrap()
    })
    .await
    .unwrap();

    assert!(
        wait_output.status.success(),
        "bakudo wait failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&wait_output.stdout),
        String::from_utf8_lossy(&wait_output.stderr)
    );
    let stdout = String::from_utf8_lossy(&wait_output.stdout);
    assert!(stdout.contains(&format!("\"task_id\":\"{task_id}\"")));
    assert!(stdout.contains("\"summary\":\"WAIT_PROVIDER_OUTPUT\""));

    cmd_tx.send(SessionCommand::Shutdown).await.unwrap();
    handle.await.unwrap();
}

#[tokio::test]
async fn bakudo_candidates_cli_lists_actionable_candidates() {
    let dir = TempDir::new("bakudo-cli-candidates");
    let script = write_fake_abox_script(
        &dir,
        r#"  list)
    echo "No active sandboxes."
    ;;
"#,
    )
    .0;
    let config = write_config_file(&dir, &script);
    let loaded_config = BakudoConfig::load(&config).unwrap();
    let repo = TempRepo::new();
    let ledger_path = loaded_config
        .resolved_repo_data_dir(Some(repo.path()))
        .join("ledger.jsonl");
    let ledger = SandboxLedger::with_persistence(&ledger_path);

    ledger
        .insert(make_record("task-preserved", SandboxState::Preserved))
        .await;
    ledger
        .insert(make_record("task-conflicts", SandboxState::MergeConflicts))
        .await;
    ledger
        .insert(make_record("task-merged", SandboxState::Merged))
        .await;

    let output = StdCommand::new(bakudo_bin())
        .args(["-c", config.to_str().unwrap(), "candidates", "--json"])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "bakudo candidates failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let candidates: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).expect("valid candidates json");
    assert_eq!(candidates.len(), 2);
    let ids: Vec<_> = candidates
        .iter()
        .map(|candidate| candidate["task_id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"task-preserved"));
    assert!(ids.contains(&"task-conflicts"));
    assert!(!ids.contains(&"task-merged"));
}

#[test]
fn bakudo_artifact_cli_reads_swarm_artifact() {
    let dir = TempDir::new("bakudo-cli-artifact");
    let (script, _log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "ARTIFACT_PROVIDER_OUTPUT"
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let plan_path = dir.path.join("swarm-plan-artifact.json");
    fs::write(
        &plan_path,
        r#"{
  "mission_id": "artifact-mission",
  "concurrent_max": 1,
  "tasks": [
    {
      "id": "capture",
      "prompt": "capture artifact",
      "provider": "codex",
      "artifact_path": "artifacts/capture.json"
    }
  ]
}"#,
    )
    .unwrap();

    let swarm_output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "swarm",
            "--plan",
            plan_path.to_str().unwrap(),
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();
    assert!(
        swarm_output.status.success(),
        "bakudo swarm failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&swarm_output.stdout),
        String::from_utf8_lossy(&swarm_output.stderr)
    );

    let artifact_output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "artifact",
            "--mission",
            "artifact-mission",
            "--path",
            "artifacts/capture.json",
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        artifact_output.status.success(),
        "bakudo artifact failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&artifact_output.stdout),
        String::from_utf8_lossy(&artifact_output.stderr)
    );
    let stdout = String::from_utf8_lossy(&artifact_output.stdout);
    assert!(stdout.contains("\"status\": \"succeeded\""));
    assert!(stdout.contains("\"summary\": \"ARTIFACT_PROVIDER_OUTPUT\""));
}

#[test]
fn bakudo_swarm_cli_runs_plan_and_writes_artifacts() {
    let dir = TempDir::new("bakudo-cli-swarm");
    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  run)
    if printf '%s\n' "$@" | grep -q 'BAKUDO_PROMPT=prepare repo'; then
      echo "PREPARE_DONE"
    elif printf '%s\n' "$@" | grep -q 'BAKUDO_PROMPT=run tests'; then
      echo "TESTS_DONE"
    else
      echo "UNKNOWN_PROMPT"
    fi
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let plan_path = dir.path.join("swarm-plan.json");
    fs::write(
        &plan_path,
        r#"{
  "mission_id": "mission-build",
  "goal": "prepare and verify",
  "concurrent_max": 2,
  "tasks": [
    {
      "id": "prepare",
      "prompt": "prepare repo",
      "provider": "codex",
      "role": "builder",
      "goal": "prepare the repo",
      "artifact_path": "artifacts/prepare.json"
    },
    {
      "id": "verify",
      "prompt": "run tests",
      "provider": "codex",
      "depends_on": ["prepare"],
      "parent_task_id": "prepare",
      "role": "verifier",
      "goal": "verify the output",
      "artifact_path": "artifacts/verify.json"
    }
  ]
}"#,
    )
    .unwrap();

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "swarm",
            "--plan",
            plan_path.to_str().unwrap(),
            "--json",
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "bakudo swarm failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"event\":\"task_started\""));
    assert!(stdout.contains("\"plan_task_id\":\"prepare\""));
    assert!(stdout.contains("\"plan_task_id\":\"verify\""));
    assert!(stdout.contains("\"event\":\"finished\""));
    assert!(stdout.contains("\"mission_id\":\"mission-build\""));
    assert!(stdout.contains("\"status\":\"succeeded\""));

    let loaded_config = BakudoConfig::load(&config).unwrap();
    let artifact_root = swarm_artifact_root(
        &loaded_config.resolved_repo_data_dir(Some(repo.path())),
        "mission-build",
    );
    let prepare_artifact = artifact_root.join("artifacts").join("prepare.json");
    let verify_artifact = artifact_root.join("artifacts").join("verify.json");
    let prepare_summary: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&prepare_artifact).unwrap()).unwrap();
    let verify_summary: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&verify_artifact).unwrap()).unwrap();
    assert_eq!(prepare_summary["status"], "succeeded");
    assert_eq!(prepare_summary["run"]["summary"], "PREPARE_DONE");
    assert_eq!(verify_summary["status"], "succeeded");
    assert_eq!(verify_summary["depends_on"][0], "prepare");
    assert_eq!(verify_summary["parent_task_id"], "prepare");
    assert_eq!(verify_summary["run"]["summary"], "TESTS_DONE");

    let invocations = read_invocations(&log);
    let prompts: Vec<String> = invocations
        .iter()
        .filter_map(|invocation| {
            invocation
                .iter()
                .find(|arg| arg.starts_with("BAKUDO_PROMPT="))
                .cloned()
        })
        .collect();
    let prepare_idx = prompts
        .iter()
        .position(|prompt| prompt == "BAKUDO_PROMPT=prepare repo")
        .unwrap();
    let verify_idx = prompts
        .iter()
        .position(|prompt| prompt == "BAKUDO_PROMPT=run tests")
        .unwrap();
    assert!(prepare_idx < verify_idx);
}

#[test]
fn bakudo_swarm_cli_rejects_unsafe_artifact_paths() {
    let dir = TempDir::new("bakudo-cli-swarm-unsafe-artifact");
    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  run)
    echo "should not run"
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let forbidden = dir.path.join("escape.json");
    let plan_path = dir.path.join("swarm-plan-unsafe.json");
    fs::write(
        &plan_path,
        format!(
            r#"{{
  "mission_id": "mission-unsafe",
  "concurrent_max": 1,
  "tasks": [
    {{
      "id": "unsafe",
      "prompt": "should not dispatch",
      "provider": "codex",
      "artifact_path": "{}"
    }}
  ]
}}"#,
            forbidden.display()
        ),
    )
    .unwrap();

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "swarm",
            "--plan",
            plan_path.to_str().unwrap(),
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "expected unsafe artifact plan to fail:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("invalid swarm plan"));
    assert!(stderr.contains("artifact_path"));
    assert!(!forbidden.exists());

    let invocations = read_invocations(&log);
    assert!(
        invocations.is_empty(),
        "unsafe plan should not dispatch abox"
    );
}

#[test]
fn bakudo_swarm_cli_blocks_tasks_on_failed_dependency() {
    let dir = TempDir::new("bakudo-cli-swarm-blocked");
    let (script, log) = write_fake_abox_script(
        &dir,
        r#"  run)
    if printf '%s\n' "$@" | grep -q 'BAKUDO_PROMPT=fail root'; then
      echo "root failed" >&2
      exit 17
    fi
    echo "unexpected child run"
    ;;
"#,
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let plan_path = dir.path.join("swarm-plan-blocked.json");
    fs::write(
        &plan_path,
        r#"{
  "mission_id": "mission-blocked",
  "concurrent_max": 2,
  "tasks": [
    {
      "id": "root",
      "prompt": "fail root",
      "provider": "codex"
    },
    {
      "id": "child",
      "prompt": "should never run",
      "provider": "codex",
      "depends_on": ["root"]
    }
  ]
}"#,
    )
    .unwrap();

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "swarm",
            "--plan",
            plan_path.to_str().unwrap(),
            "--json",
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "expected blocked swarm to fail:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"event\":\"task_blocked\""));
    assert!(stdout.contains("\"plan_task_id\":\"child\""));
    assert!(stdout.contains("\"blocked_by\":[\"root\"]"));
    assert!(stdout.contains("\"mission_id\":\"mission-blocked\""));
    assert!(stdout.contains("\"status\":\"blocked\""));

    let invocations = read_invocations(&log);
    assert_eq!(invocations.len(), 1, "dependent task should not have run");
    assert!(invocations[0]
        .join("\n")
        .contains("BAKUDO_PROMPT=fail root"));
}

#[test]
fn bakudo_swarm_cli_runs_independent_tasks_in_parallel() {
    let dir = TempDir::new("bakudo-cli-swarm-parallel");
    let lock_path = dir.path.join("parallel.lock");
    let count_path = dir.path.join("parallel-count.txt");
    let max_path = dir.path.join("parallel-max.txt");
    let (script, _log) = write_fake_abox_script(
        &dir,
        &format!(
            r#"  run)
    python3 - <<'PY'
import fcntl
import pathlib
import time

lock = pathlib.Path(r"{lock_path}")
count = pathlib.Path(r"{count_path}")
peak = pathlib.Path(r"{max_path}")

with lock.open("w") as handle:
    fcntl.flock(handle, fcntl.LOCK_EX)
    current = int(count.read_text() if count.exists() else "0") + 1
    count.write_text(str(current))
    highest = max(int(peak.read_text() if peak.exists() else "0"), current)
    peak.write_text(str(highest))
    fcntl.flock(handle, fcntl.LOCK_UN)

time.sleep(0.2)

with lock.open("w") as handle:
    fcntl.flock(handle, fcntl.LOCK_EX)
    current = int(count.read_text() if count.exists() else "0") - 1
    count.write_text(str(current))
    fcntl.flock(handle, fcntl.LOCK_UN)
PY
    echo "parallel run"
    ;;
"#,
            lock_path = lock_path.display(),
            count_path = count_path.display(),
            max_path = max_path.display(),
        ),
    );
    let config = write_config_file(&dir, &script);
    let repo = TempRepo::new();
    let plan_path = dir.path.join("swarm-plan-parallel.json");
    fs::write(
        &plan_path,
        r#"{
  "mission_id": "mission-parallel",
  "concurrent_max": 2,
  "tasks": [
    { "id": "one", "prompt": "first", "provider": "codex" },
    { "id": "two", "prompt": "second", "provider": "codex" }
  ]
}"#,
    )
    .unwrap();

    let output = StdCommand::new(bakudo_bin())
        .args([
            "-c",
            config.to_str().unwrap(),
            "swarm",
            "--plan",
            plan_path.to_str().unwrap(),
        ])
        .current_dir(repo.path())
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "parallel swarm failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    assert_eq!(fs::read_to_string(&max_path).unwrap().trim(), "2");
}

#[test]
fn app_submits_provider_command_when_idle() {
    let (cmd_tx, mut cmd_rx) = mpsc::channel(8);
    let (_event_tx, event_rx) = mpsc::channel(8);
    let mut app = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
        None,
        true,
    );

    app.input = "/provider codex".to_string();
    app.cursor = app.input.len();
    app.handle_input_key(enter_key());

    match cmd_rx.try_recv() {
        Ok(SessionCommand::SetProvider { provider_id }) => assert_eq!(provider_id, "codex"),
        other => panic!("expected SetProvider command, got {other:?}"),
    }
}

#[test]
fn app_drain_session_events_updates_shelf_and_blocks_mutating_commands() {
    let (cmd_tx, mut cmd_rx) = mpsc::channel(8);
    let (event_tx, event_rx) = mpsc::channel(8);
    let mut app = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
        None,
        true,
    );

    event_tx
        .try_send(SessionEvent::TaskStarted {
            task_id: "task-1".to_string(),
            provider_id: "claude".to_string(),
            model: None,
            prompt_summary: "test prompt".to_string(),
        })
        .unwrap();
    app.drain_session_events();

    assert_eq!(app.active_task_count, 1);
    let entry = app.shelf.front().expect("shelf entry");
    assert_eq!(entry.task_id, "task-1");
    assert_eq!(entry.state_color, ShelfColor::Running);

    app.input = "/provider codex".to_string();
    app.cursor = app.input.len();
    app.handle_input_key(enter_key());

    assert!(cmd_rx.try_recv().is_err());
    let last = app.transcript.back().expect("transcript message");
    assert_eq!(last.role, MessageRole::Error);
    assert!(last
        .content
        .contains("cannot be used while a task is in progress"));

    event_tx
        .try_send(SessionEvent::TaskFinished {
            task_id: "task-1".to_string(),
            state: SandboxState::Merged,
        })
        .unwrap();
    app.drain_session_events();

    assert_eq!(app.active_task_count, 0);
    let entry = app.shelf.front().expect("shelf entry");
    assert_eq!(entry.state_color, ShelfColor::Merged);
    assert!(entry.last_note.contains("merged"));
}

#[test]
fn app_drain_session_info_events_use_info_role() {
    let (cmd_tx, _cmd_rx) = mpsc::channel(8);
    let (event_tx, event_rx) = mpsc::channel(8);
    let mut app = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
        None,
        true,
    );

    event_tx
        .try_send(SessionEvent::Info(
            "[task-1] Divergence:\nM src/lib.rs".to_string(),
        ))
        .unwrap();
    app.drain_session_events();

    let last = app.transcript.back().expect("transcript message");
    assert_eq!(last.role, MessageRole::Info);
    assert!(last.content.contains("Divergence"));
}

#[test]
fn app_rebuilds_shelf_from_recovered_ledger_snapshot() {
    let (cmd_tx, _cmd_rx) = mpsc::channel(8);
    let (event_tx, event_rx) = mpsc::channel(8);
    let mut app = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
        None,
        true,
    );

    event_tx
        .try_send(SessionEvent::LedgerSnapshot {
            entries: vec![
                make_record("task-running", SandboxState::Running),
                make_record("task-conflicts", SandboxState::MergeConflicts),
            ],
        })
        .unwrap();
    app.drain_session_events();

    assert_eq!(app.active_task_count, 1);
    assert_eq!(app.shelf.len(), 2);
    assert_eq!(
        app.shelf.front().unwrap().state_color,
        ShelfColor::Conflicts
    );
    assert!(app
        .transcript
        .back()
        .unwrap()
        .content
        .contains("Recovered 2 sandbox(es)"));
}

#[tokio::test]
async fn real_abox_ephemeral_run_smoke() {
    let Some(_guard) = lock_real_abox().await else {
        eprintln!("skipping real abox smoke: abox 0.3.1 not available");
        return;
    };

    let repo = TempRepo::new();
    let adapter = AboxAdapter::new("abox");
    let task_id = format!("bakudo-real-ephemeral-{}", Uuid::new_v4());
    let mut params = RunParams::new(
        task_id.clone(),
        vec![
            "bash".to_string(),
            "-lc".to_string(),
            "echo hello-from-real-abox".to_string(),
        ],
    );
    params.repo = Some(repo.path().to_path_buf());
    params.ephemeral = true;
    params.timeout_secs = Some(30);

    let lines = Arc::new(Mutex::new(Vec::new()));
    let lines_for_cb = lines.clone();
    let result = adapter
        .run(&params, move |line| {
            lines_for_cb.lock().unwrap().push(line.to_string());
        })
        .await
        .unwrap();

    assert_eq!(result.exit_code, 0);
    assert!(!result.timed_out);
    assert!(result.stdout.contains("hello-from-real-abox"));
    assert!(lines
        .lock()
        .unwrap()
        .iter()
        .any(|line| line.contains("hello-from-real-abox")));

    let sandboxes = adapter.list(Some(repo.path())).await.unwrap();
    assert!(sandboxes.is_empty());
}

#[tokio::test]
async fn real_abox_preserved_stop_cleans_agent_branch() {
    let Some(_guard) = lock_real_abox().await else {
        eprintln!("skipping real abox smoke: abox 0.3.1 not available");
        return;
    };

    let repo = TempRepo::new();
    let adapter = AboxAdapter::new("abox");
    let task_id = format!("bakudo-real-preserved-{}", Uuid::new_v4());
    let mut params = RunParams::new(
        task_id.clone(),
        vec![
            "bash".to_string(),
            "-lc".to_string(),
            "printf kept".to_string(),
        ],
    );
    params.repo = Some(repo.path().to_path_buf());
    params.timeout_secs = Some(30);

    let result = adapter.run(&params, |_| {}).await.unwrap();
    assert_eq!(result.exit_code, 0);

    let branch_ref = format!("refs/heads/agent/{task_id}");
    let refs_after_run = host_output(repo.path(), "git", &["show-ref", "--heads"]);
    assert!(refs_after_run.contains(&branch_ref));

    adapter
        .stop(Some(repo.path()), &task_id, true)
        .await
        .unwrap();

    let output = StdCommand::new("git")
        .args(["show-ref", "--verify", "--quiet", &branch_ref])
        .current_dir(repo.path())
        .status()
        .unwrap();
    assert!(!output.success(), "agent branch still present after stop");
}
