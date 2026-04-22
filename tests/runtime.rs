use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bakudo_core::abox::{sandbox_task_id, AboxAdapter, RunParams};
use bakudo_core::config::BakudoConfig;
use bakudo_core::error::AboxError;
use bakudo_core::protocol::{
    AttemptId, AttemptSpec, CandidatePolicy, SessionId, TaskId, WorkerProgressEvent,
    WorkerProgressKind, WorkerStatus, WORKER_EVENT_PREFIX,
};
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::session::SessionRecord;
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};
use bakudo_daemon::session_controller::{
    SessionBootstrap, SessionCommand, SessionController, SessionEvent,
};
use bakudo_daemon::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
use bakudo_daemon::worktree::{apply_candidate_policy, WorktreeAction};
use bakudo_tui::app::{App, MessageRole, ShelfColor};
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
        cmd_rx,
        event_tx,
    );

    let handle = tokio::spawn(controller.run());
    cmd_tx
        .send(SessionCommand::Dispatch {
            prompt: "break immediately".to_string(),
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
fn app_submits_provider_command_when_idle() {
    let (cmd_tx, mut cmd_rx) = mpsc::channel(8);
    let (_event_tx, event_rx) = mpsc::channel(8);
    let mut app = App::new(
        Arc::new(BakudoConfig::default()),
        Arc::new(ProviderRegistry::with_defaults()),
        Arc::new(SandboxLedger::new()),
        cmd_tx,
        event_rx,
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
