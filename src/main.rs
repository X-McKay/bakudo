//! Bakudo v2 — main entry point.
//!
//! Usage:
//!   bakudo [OPTIONS]
//!   bakudo run <prompt>
//!   bakudo list
//!   bakudo apply <task_id>
//!   bakudo discard <task_id>
//!   bakudo divergence <task_id>
//!   bakudo doctor
//!   bakudo sessions
//!   bakudo resume <session_id>
//!
//! With no subcommand, bakudo launches the interactive ratatui TUI.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use crossterm::{
    event::{DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use serde::Serialize;
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

use bakudo_core::{
    abox::AboxAdapter,
    config::BakudoConfig,
    hook::{HookWorktreeAction, PostRunHookPayload},
    policy::PolicyDecision,
    provider::ProviderRegistry,
    session::SessionRecord,
    state::{SandboxLedger, SandboxState},
};
use bakudo_daemon::session_controller::{
    SessionBootstrap, SessionCommand, SessionController, SessionEvent,
};
use bakudo_tui::{
    app::App,
    events::{poll_event, TermEvent},
    transcript_store::TranscriptStore,
    ui::render,
};

#[derive(Parser)]
#[command(
    name = "bakudo",
    version = env!("CARGO_PKG_VERSION"),
    about = "Bakudo v2 — agentic coding assistant with abox VM sandboxing",
    long_about = None
)]
struct Cli {
    /// Path to the config file. Defaults to layered lookup under
    /// ~/.config/bakudo/config.toml and ./.bakudo/config.toml.
    #[arg(short, long, global = true)]
    config: Option<PathBuf>,

    /// Log level (trace, debug, info, warn, error).
    #[arg(long, global = true, default_value = "warn")]
    log_level: String,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Dispatch a single task non-interactively and wait for the result.
    Run {
        /// The prompt to send to the agent.
        prompt: String,
        /// Provider ID (overrides config default).
        #[arg(short, long)]
        provider: Option<String>,
        /// Model override.
        #[arg(short, long)]
        model: Option<String>,
        /// Discard the worktree after completion (default: preserve).
        #[arg(long)]
        discard: bool,
        /// Auto-apply (merge) the worktree after success.
        #[arg(long)]
        apply: bool,
        /// Approve execution when policy requires an explicit opt-in.
        #[arg(long)]
        approve_execution: bool,
        /// Emit newline-delimited JSON events instead of human-readable output.
        #[arg(long)]
        json: bool,
        /// Validate the final run summary against a JSON Schema file.
        #[arg(long)]
        output_schema: Option<PathBuf>,
    },
    /// List all sandboxes for the current repo.
    List,
    /// Apply (merge) a preserved worktree.
    Apply {
        /// The task ID of the sandbox to merge.
        task_id: String,
    },
    /// Discard a preserved worktree.
    Discard {
        /// The task ID of the sandbox to discard.
        task_id: String,
    },
    /// Show divergence between a worktree and the base branch.
    Divergence {
        task_id: String,
        #[arg(short, long, default_value = "main")]
        base: String,
    },
    /// Run health checks on abox and all registered provider binaries.
    Doctor,
    /// List saved interactive sessions, newest first.
    Sessions,
    /// Resume a previous TUI session by loading its persisted ledger.
    Resume {
        /// The session ID to resume.
        session_id: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Initialise logging (to a file, not stderr, so it doesn't corrupt the TUI).
    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("bakudo");
    std::fs::create_dir_all(&log_dir)?;
    let log_file = log_dir.join("bakudo.log");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&cli.log_level)),
        )
        .with_writer(file)
        .with_ansi(false)
        .init();

    let repo_root = current_repo_root_path().or_else(|| std::env::current_dir().ok());
    let config = Arc::new(
        BakudoConfig::load_layered(cli.config.as_deref(), repo_root.as_deref())
            .context("failed to load config")?,
    );

    // Build shared components.
    let abox = Arc::new(AboxAdapter::new(&config.abox_bin));
    let registry = Arc::new(ProviderRegistry::with_defaults());
    let ledger_path = config
        .resolved_repo_data_dir(repo_root.as_deref())
        .join("ledger.jsonl");
    let ledger = Arc::new(SandboxLedger::with_persistence(&ledger_path));

    match cli.command {
        None => {
            let session = create_session(&config)?;
            run_tui(config, abox, registry, ledger, session, false).await
        }
        Some(Commands::Run {
            prompt,
            provider,
            model,
            discard,
            apply,
            approve_execution,
            json,
            output_schema,
        }) => {
            run_headless(
                config,
                abox,
                registry,
                ledger,
                HeadlessRunRequest {
                    prompt,
                    provider_override: provider,
                    model_override: model,
                    discard,
                    apply,
                    approve_execution,
                    output_mode: if json {
                        HeadlessOutputMode::Json
                    } else {
                        HeadlessOutputMode::Human
                    },
                    output_schema,
                },
            )
            .await
        }
        Some(Commands::List) => cmd_list(&abox, &config).await,
        Some(Commands::Apply { task_id }) => cmd_apply(&abox, &config, &task_id).await,
        Some(Commands::Discard { task_id }) => cmd_discard(&abox, &task_id).await,
        Some(Commands::Divergence { task_id, base }) => cmd_divergence(&task_id, &base).await,
        Some(Commands::Doctor) => {
            let report = bakudo_daemon::doctor::run(&config, &abox, &registry).await;
            println!("{report}");
            Ok(())
        }
        Some(Commands::Sessions) => cmd_sessions(&config),
        Some(Commands::Resume { session_id }) => {
            let session = load_session(&config, &session_id)?;
            run_tui(config, abox, registry, ledger, session, true).await
        }
    }
}

async fn cmd_list(abox: &Arc<AboxAdapter>, _config: &Arc<BakudoConfig>) -> Result<()> {
    let entries = abox.list(std::env::current_dir().ok().as_deref()).await?;
    if entries.is_empty() {
        println!("No active sandboxes.");
    } else {
        println!("{:<24} {:<12} {:<10} BRANCH", "TASK ID", "STATE", "AHEAD");
        println!("{}", "-".repeat(70));
        for e in entries {
            println!(
                "{:<24} {:<12} {:<10} {}",
                e.id, e.vm_state, e.commits_ahead, e.branch
            );
        }
    }
    Ok(())
}

async fn cmd_apply(
    abox: &Arc<AboxAdapter>,
    config: &Arc<BakudoConfig>,
    task_id: &str,
) -> Result<()> {
    let conflicts = abox
        .merge(
            std::env::current_dir().ok().as_deref(),
            task_id,
            &config.base_branch,
        )
        .await?;
    if conflicts.is_empty() {
        println!("Merged {} into {}", task_id, config.base_branch);
    } else {
        eprintln!("Merge conflicts:");
        for c in conflicts {
            eprintln!("  {c}");
        }
        std::process::exit(1);
    }
    Ok(())
}

async fn cmd_discard(abox: &Arc<AboxAdapter>, task_id: &str) -> Result<()> {
    abox.stop(std::env::current_dir().ok().as_deref(), task_id, true)
        .await?;
    println!("Discarded {task_id}");
    Ok(())
}

async fn cmd_divergence(task_id: &str, base: &str) -> Result<()> {
    use bakudo_daemon::candidate::query_divergence;
    let summary = query_divergence(task_id, base, std::env::current_dir().ok().as_deref()).await?;
    if summary.has_changes {
        print!("{}", summary.raw_output);
    } else {
        println!("{task_id} is up to date with '{base}'");
    }
    Ok(())
}

fn cmd_sessions(config: &Arc<BakudoConfig>) -> Result<()> {
    let all_sessions = SessionRecord::list(&config.resolved_data_dir())?;
    if all_sessions.is_empty() {
        println!("No saved sessions.");
        return Ok(());
    }

    let current_repo = current_repo_root();
    let mut visible: Vec<_> = all_sessions
        .iter()
        .filter(|session| match current_repo.as_deref() {
            Some(repo) => session.repo_root.as_deref() == Some(repo),
            None => true,
        })
        .collect();

    if visible.is_empty() {
        if let Some(repo) = current_repo.as_deref() {
            println!("No saved sessions for current repo '{repo}'.");
            println!("Showing all saved sessions instead.\n");
        }
        visible = all_sessions.iter().collect();
    }

    println!(
        "{:<44} {:<20} {:<10} {:<16} REPO",
        "SESSION ID", "STARTED", "PROVIDER", "MODEL"
    );
    println!("{}", "-".repeat(118));
    for session in visible {
        println!(
            "{:<44} {:<20} {:<10} {:<16} {}",
            session.session_id.0,
            session.started_at.format("%Y-%m-%d %H:%M:%S"),
            session.provider_id,
            session.model.as_deref().unwrap_or("-"),
            session.repo_root.as_deref().unwrap_or("-"),
        );
    }

    Ok(())
}

fn current_repo_root() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let repo_root = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
                (!root.is_empty()).then_some(root)
            } else {
                None
            }
        });

    repo_root.or_else(|| Some(cwd.to_string_lossy().to_string()))
}

fn current_repo_root_path() -> Option<PathBuf> {
    current_repo_root().map(PathBuf::from)
}

fn create_session(config: &Arc<BakudoConfig>) -> Result<SessionRecord> {
    let session = SessionRecord::new(
        config.default_provider.clone(),
        config.default_model.clone(),
        current_repo_root(),
    );
    session.save(&config.resolved_data_dir())?;
    Ok(session)
}

fn load_session(config: &Arc<BakudoConfig>, session_id: &str) -> Result<SessionRecord> {
    let session = SessionRecord::load(&config.resolved_data_dir(), session_id)?;
    if let (Some(saved_repo), Some(current_repo)) =
        (session.repo_root.as_deref(), current_repo_root())
    {
        if saved_repo != current_repo {
            anyhow::bail!(
                "session '{}' belongs to repo '{}', current repo is '{}'",
                session_id,
                saved_repo,
                current_repo
            );
        }
    }
    Ok(session)
}

/// RAII guard that restores the terminal on drop — even if the TUI panics.
struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(
            stdout,
            EnterAlternateScreen,
            EnableBracketedPaste,
            EnableFocusChange
        )?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let mut stdout = io::stdout();
        let _ = execute!(
            stdout,
            DisableFocusChange,
            DisableBracketedPaste,
            LeaveAlternateScreen
        );
        let _ = disable_raw_mode();
    }
}

/// Launch the interactive ratatui TUI.
async fn run_tui(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
    session: SessionRecord,
    resumed: bool,
) -> Result<()> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(64);
    let (event_tx, event_rx) = mpsc::channel::<SessionEvent>(256);

    // Spawn the session controller.
    let ctrl = SessionController::with_session(
        config.clone(),
        abox.clone(),
        ledger.clone(),
        registry.clone(),
        SessionBootstrap {
            session: session.clone(),
            resume_only: resumed,
        },
        cmd_rx,
        event_tx,
    );
    tokio::spawn(ctrl.run());

    // Watch for SIGINT/SIGTERM and forward as a shutdown command so the
    // terminal is restored cleanly even on signal.
    let shutdown_tx = cmd_tx.clone();
    tokio::spawn(async move {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => return,
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
        let _ = shutdown_tx.send(SessionCommand::Shutdown).await;
    });

    let _guard = TerminalGuard::enter()?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;

    let transcript_store = TranscriptStore::new(
        config
            .resolved_repo_data_dir_from_str(session.repo_root.as_deref())
            .join("session-events")
            .join(format!("{}.jsonl", session.session_id.0)),
    );
    let mut app = App::new(
        config,
        registry,
        ledger,
        cmd_tx,
        event_rx,
        Some(transcript_store),
        !resumed,
    );
    app.session_id = session.session_id.0.clone();
    app.provider_id = session.provider_id.clone();
    app.model = session.model.clone();
    if resumed {
        app.load_transcript();
        if app.transcript.is_empty() {
            app.push_message(bakudo_tui::app::ChatMessage::system(
                "Welcome back to Bakudo v2.",
            ));
        }
        app.note_resume(session.session_id.0.clone());
    }

    let result = run_event_loop(&mut terminal, &mut app).await;

    // _guard Drops here — terminal restored regardless of panic/result.
    let _ = terminal.show_cursor();
    result
}

async fn run_event_loop<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
) -> Result<()> {
    loop {
        app.drain_session_events();
        terminal.draw(|f| render(f, app))?;
        if app.should_quit {
            break;
        }

        match poll_event(Duration::from_millis(50))? {
            Some(TermEvent::Key(key)) => {
                if !app.handle_global_key(key) {
                    match app.focus {
                        bakudo_tui::app::FocusedPanel::Chat => app.handle_input_key(key),
                        bakudo_tui::app::FocusedPanel::Shelf => app.handle_shelf_key(key),
                    }
                }
            }
            Some(TermEvent::Paste(text)) => app.handle_paste(text),
            Some(TermEvent::FocusGained) => app.on_focus_gained(),
            Some(TermEvent::FocusLost) => app.on_focus_lost(),
            Some(TermEvent::Resize(_, _)) => {}
            Some(TermEvent::Tick) | None => app.tick(),
        }
    }
    Ok(())
}

/// Run a single task headlessly (no TUI).
struct HeadlessRunRequest {
    prompt: String,
    provider_override: Option<String>,
    model_override: Option<String>,
    discard: bool,
    apply: bool,
    approve_execution: bool,
    output_mode: HeadlessOutputMode,
    output_schema: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeadlessOutputMode {
    Human,
    Json,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum HeadlessJsonEvent {
    TaskStarted {
        task_id: String,
        provider_id: String,
        model: Option<String>,
    },
    Progress {
        task_id: String,
        message: String,
    },
    RawLine {
        task_id: String,
        line: String,
    },
    Error {
        task_id: Option<String>,
        message: String,
    },
    Finished {
        summary: HeadlessRunSummary,
    },
}

#[derive(Debug, Clone, Serialize)]
struct HeadlessRunSummary {
    task_id: String,
    attempt_id: String,
    session_id: String,
    provider_id: String,
    model: Option<String>,
    repo_root: Option<String>,
    worker_status: bakudo_core::protocol::WorkerStatus,
    final_state: SandboxState,
    worktree_action: HookWorktreeAction,
    merge_conflicts: Vec<String>,
    candidate_policy: bakudo_core::protocol::CandidatePolicy,
    sandbox_lifecycle: bakudo_core::protocol::SandboxLifecycle,
    summary: String,
    exit_code: i32,
    duration_ms: u64,
    timed_out: bool,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

async fn run_headless(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
    request: HeadlessRunRequest,
) -> Result<()> {
    use bakudo_core::abox::sandbox_task_id;
    use bakudo_core::protocol::{CandidatePolicy, SandboxLifecycle};
    use bakudo_daemon::hooks::run_post_run_hook;
    use bakudo_daemon::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
    use bakudo_daemon::worktree::apply_candidate_policy;

    let provider_id = request
        .provider_override
        .unwrap_or_else(|| config.default_provider.clone());
    let model = request
        .model_override
        .or_else(|| config.default_model.clone());

    let provider = registry
        .get(&provider_id)
        .with_context(|| format!("Unknown provider '{provider_id}'"))?;

    let execution_decision = config.execution_policy.evaluate(&provider_id);
    match execution_decision.decision {
        PolicyDecision::Forbid => {
            anyhow::bail!("execution policy forbids provider '{provider_id}'");
        }
        PolicyDecision::Prompt if !request.approve_execution => {
            anyhow::bail!(
                "execution policy requires approval for '{provider_id}'; rerun with --approve-execution"
            );
        }
        PolicyDecision::Allow | PolicyDecision::Prompt => {}
    }

    let candidate_policy = if request.discard {
        CandidatePolicy::Discard
    } else if request.apply {
        CandidatePolicy::AutoApply
    } else {
        CandidatePolicy::Review
    };

    let spec = config.build_attempt_spec(
        &request.prompt,
        &provider_id,
        model.clone(),
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
        execution_decision.allow_all_tools,
        candidate_policy,
        SandboxLifecycle::Preserved,
    );

    let task_id = sandbox_task_id(&spec.attempt_id.0);

    let cfg = Arc::new(TaskRunnerConfig {
        abox: abox.clone(),
        ledger: ledger.clone(),
        data_dir: config
            .resolved_repo_data_dir_from_str(spec.repo_root.as_deref())
            .join("runs"),
        worker_command: provider
            .build_worker_command(model.as_deref(), execution_decision.allow_all_tools),
        memory_mib: provider.memory_mib,
        cpus: provider.cpus,
    });

    emit_headless_event(
        request.output_mode,
        &HeadlessJsonEvent::TaskStarted {
            task_id: task_id.clone(),
            provider_id: provider_id.clone(),
            model: model.clone(),
        },
    )?;
    if request.output_mode == HeadlessOutputMode::Human {
        println!("Dispatching task {task_id} to provider '{provider_id}'...");
    }

    let (mut rx, handle) = run_attempt(spec.clone(), cfg).await;

    while let Some(event) = rx.recv().await {
        match event {
            RunnerEvent::RawLine(line) => {
                emit_headless_event(
                    request.output_mode,
                    &HeadlessJsonEvent::RawLine {
                        task_id: task_id.clone(),
                        line: line.clone(),
                    },
                )?;
                if request.output_mode == HeadlessOutputMode::Human {
                    println!("{line}");
                }
            }
            RunnerEvent::Progress(progress) => {
                emit_headless_event(
                    request.output_mode,
                    &HeadlessJsonEvent::Progress {
                        task_id: task_id.clone(),
                        message: progress.message.clone(),
                    },
                )?;
                if request.output_mode == HeadlessOutputMode::Human {
                    println!("[event] {}", progress.message);
                }
            }
            RunnerEvent::InfraError(err) => {
                emit_headless_event(
                    request.output_mode,
                    &HeadlessJsonEvent::Error {
                        task_id: Some(task_id.clone()),
                        message: err.clone(),
                    },
                )?;
                if request.output_mode == HeadlessOutputMode::Human {
                    eprintln!("[error] {err}");
                }
            }
            RunnerEvent::Finished(result) => {
                if request.output_mode == HeadlessOutputMode::Human {
                    println!(
                        "\nTask finished: {:?} in {}ms",
                        result.status, result.duration_ms
                    );
                }
            }
        }
    }

    let result = match handle.await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => return Err(err.into()),
        Err(err) => return Err(err.into()),
    };

    let (final_state, worktree_action, merge_conflicts) =
        if result.status == bakudo_core::protocol::WorkerStatus::Succeeded {
            match apply_candidate_policy(
                &task_id,
                &spec.candidate_policy,
                &config.base_branch,
                std::env::current_dir().ok().as_deref(),
                &abox,
                &ledger,
            )
            .await?
            {
                bakudo_daemon::worktree::WorktreeAction::Merged => {
                    (SandboxState::Merged, HookWorktreeAction::Merged, Vec::new())
                }
                bakudo_daemon::worktree::WorktreeAction::MergeConflicts(conflicts) => (
                    SandboxState::MergeConflicts,
                    HookWorktreeAction::MergeConflicts,
                    conflicts,
                ),
                bakudo_daemon::worktree::WorktreeAction::Discarded => (
                    SandboxState::Discarded,
                    HookWorktreeAction::Discarded,
                    Vec::new(),
                ),
                bakudo_daemon::worktree::WorktreeAction::Preserved => (
                    SandboxState::Preserved,
                    HookWorktreeAction::Preserved,
                    Vec::new(),
                ),
            }
        } else {
            (
                match result.status {
                    bakudo_core::protocol::WorkerStatus::Succeeded => SandboxState::Preserved,
                    bakudo_core::protocol::WorkerStatus::TimedOut => SandboxState::TimedOut,
                    bakudo_core::protocol::WorkerStatus::Failed
                    | bakudo_core::protocol::WorkerStatus::Cancelled => SandboxState::Failed {
                        exit_code: result.exit_code,
                    },
                },
                HookWorktreeAction::NotApplied,
                Vec::new(),
            )
        };

    let summary = HeadlessRunSummary {
        task_id: task_id.clone(),
        attempt_id: spec.attempt_id.0.clone(),
        session_id: spec.session_id.0.clone(),
        provider_id: provider_id.clone(),
        model: model.clone(),
        repo_root: spec.repo_root.clone(),
        worker_status: result.status.clone(),
        final_state: final_state.clone(),
        worktree_action,
        merge_conflicts: merge_conflicts.clone(),
        candidate_policy: spec.candidate_policy,
        sandbox_lifecycle: spec.sandbox_lifecycle,
        summary: result.summary.clone(),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        stdout: result.stdout.clone(),
        stderr: result.stderr.clone(),
        stdout_truncated: result.stdout_truncated,
        stderr_truncated: result.stderr_truncated,
    };

    validate_output_schema(request.output_schema.as_deref(), &summary)?;

    let hook_payload = PostRunHookPayload {
        session_id: spec.session_id.clone(),
        attempt_id: spec.attempt_id.clone(),
        task_id: task_id.clone(),
        repo_root: spec.repo_root.clone(),
        provider_id: provider_id.clone(),
        model: model.clone(),
        candidate_policy: spec.candidate_policy,
        sandbox_lifecycle: spec.sandbox_lifecycle,
        worker_status: result.status.clone(),
        final_state: final_state.clone(),
        worktree_action,
        summary: result.summary.clone(),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        merge_conflicts: merge_conflicts.clone(),
    };
    if let Err(err) = run_post_run_hook(&config, &hook_payload).await {
        emit_headless_event(
            request.output_mode,
            &HeadlessJsonEvent::Error {
                task_id: Some(task_id.clone()),
                message: format!("post-run hook failed: {err}"),
            },
        )?;
        if request.output_mode == HeadlessOutputMode::Human {
            eprintln!("Post-run hook failed: {err}");
        }
    }

    emit_headless_event(
        request.output_mode,
        &HeadlessJsonEvent::Finished {
            summary: summary.clone(),
        },
    )?;

    if request.output_mode == HeadlessOutputMode::Human {
        match summary.worktree_action {
            HookWorktreeAction::Merged => println!("Worktree merged."),
            HookWorktreeAction::MergeConflicts => {
                eprintln!("Merge conflicts:");
                for conflict in &summary.merge_conflicts {
                    eprintln!("  {conflict}");
                }
            }
            HookWorktreeAction::Discarded => println!("Worktree discarded."),
            HookWorktreeAction::Preserved => {
                println!("Worktree preserved at task_id: {task_id}");
            }
            HookWorktreeAction::NotApplied => {}
        }
    }

    if summary.worker_status == bakudo_core::protocol::WorkerStatus::Succeeded {
        Ok(())
    } else {
        anyhow::bail!("task {task_id} finished with {:?}", summary.worker_status);
    }
}

fn emit_headless_event(mode: HeadlessOutputMode, event: &HeadlessJsonEvent) -> Result<()> {
    if mode == HeadlessOutputMode::Json {
        println!("{}", serde_json::to_string(event)?);
    }
    Ok(())
}

fn validate_output_schema(
    schema_path: Option<&std::path::Path>,
    summary: &HeadlessRunSummary,
) -> Result<()> {
    let Some(schema_path) = schema_path else {
        return Ok(());
    };
    let schema_value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(schema_path)?)?;
    let instance = serde_json::to_value(summary)?;
    let compiled = jsonschema::JSONSchema::compile(&schema_value)
        .map_err(|err| anyhow::anyhow!("invalid JSON Schema '{}': {err}", schema_path.display()))?;
    if let Err(errors) = compiled.validate(&instance) {
        let details = errors
            .map(|err| err.to_string())
            .collect::<Vec<_>>()
            .join("; ");
        anyhow::bail!(
            "final output failed schema validation against '{}': {details}",
            schema_path.display()
        );
    }
    Ok(())
}
