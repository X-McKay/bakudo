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
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

use bakudo_core::{
    abox::AboxAdapter, config::BakudoConfig, provider::ProviderRegistry, state::SandboxLedger,
};
use bakudo_daemon::session_controller::{SessionCommand, SessionController, SessionEvent};
use bakudo_tui::{
    app::App,
    events::{poll_event, TermEvent},
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

    let repo_root = std::env::current_dir().ok();
    let config = Arc::new(
        BakudoConfig::load_layered(cli.config.as_deref(), repo_root.as_deref())
            .context("failed to load config")?,
    );

    // Build shared components.
    let abox = Arc::new(AboxAdapter::new(&config.abox_bin));
    let registry = Arc::new(ProviderRegistry::with_defaults());
    let ledger_path = config.resolved_data_dir().join("ledger.jsonl");
    let ledger = Arc::new(SandboxLedger::with_persistence(&ledger_path));

    match cli.command {
        None => run_tui(config, abox, registry, ledger, None).await,
        Some(Commands::Run {
            prompt,
            provider,
            model,
            discard,
            apply,
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
                },
            )
            .await
        }
        Some(Commands::List) => cmd_list(&abox, &config).await,
        Some(Commands::Apply { task_id }) => cmd_apply(&abox, &config, &task_id).await,
        Some(Commands::Discard { task_id }) => cmd_discard(&abox, &task_id).await,
        Some(Commands::Divergence { task_id, base }) => {
            cmd_divergence(&abox, &task_id, &base).await
        }
        Some(Commands::Doctor) => {
            let report = bakudo_daemon::doctor::run(&config, &abox, &registry).await;
            println!("{report}");
            Ok(())
        }
        Some(Commands::Resume { session_id }) => {
            run_tui(config, abox, registry, ledger, Some(session_id)).await
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

async fn cmd_divergence(abox: &Arc<AboxAdapter>, task_id: &str, base: &str) -> Result<()> {
    use bakudo_daemon::candidate::query_divergence;
    let summary =
        query_divergence(task_id, base, std::env::current_dir().ok().as_deref(), abox).await?;
    if summary.has_changes {
        print!("{}", summary.raw_output);
    } else {
        println!("{task_id} is up to date with '{base}'");
    }
    Ok(())
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
    resume_session_id: Option<String>,
) -> Result<()> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(64);
    let (event_tx, event_rx) = mpsc::channel::<SessionEvent>(256);

    // Spawn the session controller.
    let ctrl = SessionController::new(
        config.clone(),
        abox.clone(),
        ledger.clone(),
        registry.clone(),
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

    let mut app = App::new(config, registry, ledger, cmd_tx, event_rx);
    if let Some(session_id) = resume_session_id {
        app.note_resume(session_id);
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
        candidate_policy,
        SandboxLifecycle::Preserved,
    );

    let task_id = sandbox_task_id(&spec.attempt_id.0);

    let worker_cmd = provider.build_stdin_command(model.as_deref(), true);

    let cfg = Arc::new(TaskRunnerConfig {
        abox: abox.clone(),
        ledger: ledger.clone(),
        data_dir: config.resolved_data_dir().join("runs"),
        worker_command: worker_cmd,
        memory_mib: provider.memory_mib,
        cpus: provider.cpus,
    });

    println!("Dispatching task {task_id} to provider '{provider_id}'...");

    let (mut rx, _handle) = run_attempt(spec.clone(), cfg).await;

    while let Some(event) = rx.recv().await {
        match &event {
            RunnerEvent::RawLine(line) => println!("{line}"),
            RunnerEvent::Progress(p) => println!("[event] {}", p.message),
            RunnerEvent::InfraError(e) => eprintln!("[error] {e}"),
            RunnerEvent::Finished(r) => {
                println!("\nTask finished: {:?} in {}ms", r.status, r.duration_ms);
            }
        }
    }

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
        bakudo_daemon::worktree::WorktreeAction::Merged => println!("Worktree merged."),
        bakudo_daemon::worktree::WorktreeAction::MergeConflicts(c) => {
            eprintln!("Merge conflicts:");
            for conflict in c {
                eprintln!("  {conflict}");
            }
        }
        bakudo_daemon::worktree::WorktreeAction::Discarded => println!("Worktree discarded."),
        bakudo_daemon::worktree::WorktreeAction::Preserved => {
            println!("Worktree preserved at task_id: {task_id}")
        }
    }

    Ok(())
}
