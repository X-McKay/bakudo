//! Bakudo v2 — main entry point.
//!
//! Usage:
//!   bakudo [OPTIONS]
//!   bakudo run <prompt>
//!   bakudo list
//!   bakudo apply <task_id>
//!   bakudo discard <task_id>
//!
//! With no subcommand, bakudo launches the interactive ratatui TUI.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use crossterm::{
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

use bakudo_core::{
    abox::AboxAdapter,
    config::BakudoConfig,
    provider::ProviderRegistry,
    state::SandboxLedger,
};
use bakudo_daemon::session_controller::{SessionCommand, SessionController, SessionEvent};
use bakudo_tui::{app::App, events::{poll_event, TermEvent}, ui::render};

#[derive(Parser)]
#[command(
    name = "bakudo",
    version = env!("CARGO_PKG_VERSION"),
    about = "Bakudo v2 — agentic coding assistant with abox VM sandboxing",
    long_about = None
)]
struct Cli {
    /// Path to the config file. Defaults to ~/.config/bakudo/config.toml.
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
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(&cli.log_level)),
        )
        .with_writer(file)
        .with_ansi(false)
        .init();

    // Load config.
    let config_path = cli.config.unwrap_or_else(|| {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("bakudo")
            .join("config.toml")
    });
    let config = Arc::new(BakudoConfig::load(&config_path)?);

    // Build shared components.
    // Respect config.abox_bin so users can override the binary path.
    let abox = Arc::new(AboxAdapter::new(&config.abox_bin));
    let registry = Arc::new(ProviderRegistry::with_defaults());
    let ledger = Arc::new(SandboxLedger::new());

    match cli.command {
        None => {
            // Launch the interactive TUI.
            run_tui(config, abox, registry, ledger).await
        }
        Some(Commands::Run { prompt, provider, model, discard, apply }) => {
            run_headless(config, abox, registry, ledger, prompt, provider, model, discard, apply).await
        }
        Some(Commands::List) => {
            let entries = abox.list(std::env::current_dir().ok().as_deref()).await?;
            if entries.is_empty() {
                println!("No active sandboxes.");
            } else {
                println!("{:<24} {:<12} {:<10} {}", "TASK ID", "STATE", "AHEAD", "BRANCH");
                println!("{}", "-".repeat(70));
                for e in entries {
                    println!("{:<24} {:<12} {:<10} {}", e.id, e.vm_state, e.commits_ahead, e.branch);
                }
            }
            Ok(())
        }
        Some(Commands::Apply { task_id }) => {
            let conflicts = abox.merge(std::env::current_dir().ok().as_deref(), &task_id, &config.base_branch).await?;
            if conflicts.is_empty() {
                println!("Merged {} into {}", task_id, config.base_branch);
            } else {
                eprintln!("Merge conflicts:");
                for c in conflicts { eprintln!("  {c}"); }
                std::process::exit(1);
            }
            Ok(())
        }
        Some(Commands::Discard { task_id }) => {
            abox.stop(std::env::current_dir().ok().as_deref(), &task_id, true).await?;
            println!("Discarded {task_id}");
            Ok(())
        }
        Some(Commands::Divergence { task_id, base }) => {
            use bakudo_daemon::candidate::query_divergence;
            let summary = query_divergence(
                &task_id,
                &base,
                std::env::current_dir().ok().as_deref(),
                &abox,
            ).await?;
            if summary.has_changes {
                print!("{}", summary.raw_output);
            } else {
                println!("{task_id} is up to date with '{base}'");
            }
            Ok(())
        }
    }
}

/// Launch the interactive ratatui TUI.
async fn run_tui(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
) -> Result<()> {
    // Set up channels.
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

    // Set up the terminal.
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(config, registry, ledger, cmd_tx, event_rx);

    let result = run_event_loop(&mut terminal, &mut app).await;

    // Restore terminal.
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

async fn run_event_loop<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
) -> Result<()> {
    loop {
        // Drain session events first.
        app.drain_session_events();

        // Draw.
        terminal.draw(|f| render(f, app))?;

        if app.should_quit {
            break;
        }

        // Poll for input with a short timeout so we keep draining events.
        match poll_event(Duration::from_millis(50))? {
            Some(TermEvent::Key(key)) => {
                if !app.handle_global_key(key) {
                    match app.focus {
                        bakudo_tui::app::FocusedPanel::Chat => app.handle_input_key(key),
                        bakudo_tui::app::FocusedPanel::Shelf => app.handle_shelf_key(key),
                    }
                }
            }
            Some(TermEvent::Resize(_, _)) => {
                // Terminal will redraw on next iteration.
            }
            Some(TermEvent::Tick) | None => {}
        }
    }
    Ok(())
}

/// Run a single task headlessly (no TUI).
async fn run_headless(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
    prompt: String,
    provider_override: Option<String>,
    model_override: Option<String>,
    discard: bool,
    apply: bool,
) -> Result<()> {
    use bakudo_core::protocol::{AttemptSpec, CandidatePolicy, SandboxLifecycle, AttemptBudget, AttemptPermissions};
    use bakudo_core::abox::sandbox_task_id;
    use bakudo_daemon::task_runner::{run_attempt, RunnerEvent, TaskRunnerConfig};
    use bakudo_daemon::worktree::apply_candidate_policy;

    let provider_id = provider_override.unwrap_or_else(|| config.default_provider.clone());
    let model = model_override.unwrap_or_else(|| config.default_model.clone());

    let provider = registry.get(&provider_id)
        .with_context(|| format!("Unknown provider '{provider_id}'"))?;

    let candidate_policy = if discard {
        CandidatePolicy::Discard
    } else if apply {
        CandidatePolicy::AutoApply
    } else {
        CandidatePolicy::Review
    };

    let mut spec = AttemptSpec::new(&prompt, &provider_id);
    spec.model = model.clone();
    spec.budget = AttemptBudget { timeout_secs: config.timeout_secs, ..Default::default() };
    spec.permissions = AttemptPermissions { allow_all_tools: true };
    spec.sandbox_lifecycle = SandboxLifecycle::Preserved;
    spec.candidate_policy = candidate_policy.clone();
    spec.repo_root = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());

    let task_id = sandbox_task_id(&spec.attempt_id.0);

    let worker_cmd: Vec<String> = std::iter::once(provider.binary.clone())
        .chain(provider.build_args(&model, true))
        .collect();

    let cfg = Arc::new(TaskRunnerConfig {
        abox: abox.clone(),
        ledger: ledger.clone(),
        data_dir: config.resolved_data_dir().join("runs"),
        worker_command: worker_cmd,
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

    // Apply candidate policy.
    match apply_candidate_policy(
        &task_id,
        &candidate_policy,
        &config.base_branch,
        std::env::current_dir().ok().as_deref(),
        &abox,
        &ledger,
    ).await? {
        bakudo_daemon::worktree::WorktreeAction::Merged => println!("Worktree merged."),
        bakudo_daemon::worktree::WorktreeAction::MergeConflicts(c) => {
            eprintln!("Merge conflicts:");
            for conflict in c { eprintln!("  {conflict}"); }
        }
        bakudo_daemon::worktree::WorktreeAction::Discarded => println!("Worktree discarded."),
        bakudo_daemon::worktree::WorktreeAction::Preserved => println!("Worktree preserved at task_id: {task_id}"),
    }

    Ok(())
}
