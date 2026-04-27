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

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use crossterm::{
    event::{DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    backend::{Backend, ClearType, CrosstermBackend, WindowSize},
    buffer::Cell,
    Terminal, TerminalOptions, Viewport,
};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use bakudo_core::{
    abox::AboxAdapter,
    config::BakudoConfig,
    control::{
        load_run_summary, read_swarm_artifact, save_run_summary, save_swarm_run_summary,
        swarm_artifact_root, update_run_summary_outcome, RunSummary, SwarmRunSummary,
        SwarmRunTotals, SwarmTaskStatus, SwarmTaskSummary,
    },
    hook::{HookWorktreeAction, PostRunHookPayload},
    mission::{SwarmPlan, SwarmTaskPlan},
    policy::PolicyDecision,
    protocol::{CandidatePolicy, SandboxLifecycle, WorkerStatus},
    provider::ProviderRegistry,
    session::SessionRecord,
    state::{SandboxLedger, SandboxRecord, SandboxState},
};
use bakudo_daemon::mission_store::MissionStore;
use bakudo_daemon::session_controller::{
    SessionBootstrap, SessionCommand, SessionController, SessionEvent,
};
use bakudo_tui::{
    app::App,
    events::{poll_event, TermEvent},
    insert_history,
    palette::{COMPOSER_MAX_HEIGHT, FOOTER_HEIGHT},
    transcript_store::TranscriptStore,
    ui::render,
};

const INLINE_VIEWPORT_PADDING: u16 = 0;
const INLINE_VIEWPORT_TOP_STRIP_HEIGHT: u16 = 1;
const INLINE_VIEWPORT_HEIGHT: u16 = INLINE_VIEWPORT_TOP_STRIP_HEIGHT
    + COMPOSER_MAX_HEIGHT
    + FOOTER_HEIGHT
    + INLINE_VIEWPORT_PADDING;

struct FallbackCursorBackend<B> {
    inner: B,
}

impl<B> FallbackCursorBackend<B> {
    fn new(inner: B) -> Self {
        Self { inner }
    }
}

impl<B> Backend for FallbackCursorBackend<B>
where
    B: Backend,
{
    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.inner.draw(content)
    }

    fn append_lines(&mut self, n: u16) -> io::Result<()> {
        self.inner.append_lines(n)
    }

    fn hide_cursor(&mut self) -> io::Result<()> {
        self.inner.hide_cursor()
    }

    fn show_cursor(&mut self) -> io::Result<()> {
        self.inner.show_cursor()
    }

    fn get_cursor(&mut self) -> io::Result<(u16, u16)> {
        self.inner.get_cursor().or_else(|err| {
            if err
                .to_string()
                .contains("The cursor position could not be read within a normal duration")
            {
                let size = self.inner.size()?;
                Ok((0, size.height.saturating_sub(1)))
            } else {
                Err(err)
            }
        })
    }

    fn set_cursor(&mut self, x: u16, y: u16) -> io::Result<()> {
        self.inner.set_cursor(x, y)
    }

    fn clear(&mut self) -> io::Result<()> {
        self.inner.clear()
    }

    fn clear_region(&mut self, clear_type: ClearType) -> io::Result<()> {
        self.inner.clear_region(clear_type)
    }

    fn size(&self) -> io::Result<ratatui::prelude::Rect> {
        self.inner.size()
    }

    fn window_size(&mut self) -> io::Result<WindowSize> {
        self.inner.window_size()
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

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
    /// Execute a dependency-aware swarm plan from JSON.
    Swarm {
        /// Path to a JSON plan file describing mission tasks and dependencies.
        #[arg(long)]
        plan: PathBuf,
        /// Approve execution when policy requires an explicit opt-in.
        #[arg(long)]
        approve_execution: bool,
        /// Override the plan's concurrency limit.
        #[arg(long)]
        concurrent_max: Option<usize>,
        /// Emit newline-delimited JSON events instead of human-readable output.
        #[arg(long)]
        json: bool,
        /// Validate the final swarm summary against a JSON Schema file.
        #[arg(long)]
        output_schema: Option<PathBuf>,
    },
    /// List preserved/merge-conflict candidates for the current repo.
    Candidates {
        /// Emit JSON instead of the table view.
        #[arg(long)]
        json: bool,
    },
    /// Read a persisted task result by task ID.
    Result {
        /// The bakudo task ID.
        task_id: String,
        /// Emit JSON instead of the human summary.
        #[arg(long)]
        json: bool,
    },
    /// Wait for a persisted task result to appear.
    Wait {
        /// The bakudo task ID.
        task_id: String,
        /// Maximum time to wait before failing.
        #[arg(long, default_value_t = 60)]
        timeout_secs: u64,
        /// Emit JSON instead of the human summary.
        #[arg(long)]
        json: bool,
    },
    /// Read a swarm artifact from Bakudo-owned storage.
    Artifact {
        /// Mission ID from the swarm plan.
        #[arg(long)]
        mission: String,
        /// Logical artifact path from the swarm plan.
        #[arg(long)]
        path: String,
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
    Doctor {
        /// Overwrite repo-local mission prompts/providers with the current shipped contract.
        #[arg(long)]
        sync_mission_contract: bool,
    },
    /// Run the Bakudo supervisor without the TUI.
    Daemon,
    /// Show mission status from the durable mission store.
    Status,
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

    // Materialize bakudo's own abox config + proxy policy under the
    // repo-scoped data dir, then point every abox invocation at it via
    // `--config`. The operator's `~/.abox/config.toml` is intentionally
    // not consulted for bakudo-driven sandboxes — bakudo's runtime
    // contract (e.g. pypi reachable for worker pip bootstrap, git push
    // allowed) lives in the bakudo source tree, not in the host install.
    let bakudo_data_dir = config.resolved_repo_data_dir(repo_root.as_deref());
    let abox_runtime =
        bakudo_daemon::abox_runtime::AboxRuntimeAssets::ensure_materialized(&bakudo_data_dir)
            .context("failed to materialize bakudo-managed abox runtime config")?;

    // Build shared components.
    let abox = Arc::new(AboxAdapter::with_config(
        &config.abox_bin,
        abox_runtime.config_path(),
    ));
    let registry = Arc::new(ProviderRegistry::with_defaults());
    let ledger_path = config
        .resolved_repo_data_dir(repo_root.as_deref())
        .join("ledger.jsonl");
    let ledger = Arc::new(SandboxLedger::with_persistence(&ledger_path));

    // `doctor` runs its own richer version check; skip the preflight warning
    // there to avoid duplicating output.
    if !matches!(cli.command, Some(Commands::Doctor { .. })) {
        warn_if_abox_outdated(&abox, &config.abox_bin).await;
    }

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
        Some(Commands::Swarm {
            plan,
            approve_execution,
            concurrent_max,
            json,
            output_schema,
        }) => {
            run_swarm_headless(
                config,
                abox,
                registry,
                ledger,
                SwarmRunRequest {
                    plan_path: plan,
                    approve_execution,
                    concurrent_max,
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
        Some(Commands::Candidates { json }) => cmd_candidates(&ledger, json).await,
        Some(Commands::Result { task_id, json }) => {
            cmd_result(&config, &ledger, &task_id, json).await
        }
        Some(Commands::Wait {
            task_id,
            timeout_secs,
            json,
        }) => cmd_wait(&config, &ledger, &task_id, timeout_secs, json).await,
        Some(Commands::Artifact { mission, path }) => cmd_artifact(&config, &mission, &path),
        Some(Commands::List) => cmd_list(&abox, &config).await,
        Some(Commands::Apply { task_id }) => cmd_apply(&abox, &config, &ledger, &task_id).await,
        Some(Commands::Discard { task_id }) => cmd_discard(&abox, &config, &task_id).await,
        Some(Commands::Divergence { task_id, base }) => cmd_divergence(&task_id, &base).await,
        Some(Commands::Doctor {
            sync_mission_contract,
        }) => {
            if sync_mission_contract {
                let repo_root = current_repo_root_path().or_else(|| std::env::current_dir().ok());
                let Some(repo_root) = repo_root else {
                    anyhow::bail!("mission contract sync requires a repository root");
                };
                let report = bakudo_daemon::provider_runtime::ProviderCatalog::new(repo_root)
                    .sync_mission_contract()?;
                if report.updated_files.is_empty() {
                    println!(
                        "Mission contract v{} already matches the shipped defaults.",
                        report.version
                    );
                } else {
                    println!(
                        "Synced mission contract v{} ({} file(s) updated).",
                        report.version,
                        report.updated_files.len()
                    );
                    for file in report.updated_files {
                        println!("  - {file}");
                    }
                }
                return Ok(());
            }
            let report = bakudo_daemon::doctor::run(&config, &abox, &registry).await;
            println!("{report}");
            Ok(())
        }
        Some(Commands::Daemon) => {
            let session = create_session(&config)?;
            run_daemon(config, abox, registry, ledger, session).await
        }
        Some(Commands::Status) => cmd_status(&config).await,
        Some(Commands::Sessions) => cmd_sessions(&config),
        Some(Commands::Resume { session_id }) => {
            let session = load_session(&config, &session_id)?;
            run_tui(config, abox, registry, ledger, session, true).await
        }
    }
}

/// Best-effort preflight: if `abox --version` reports a version older than
/// [`bakudo_core::abox::MIN_ABOX_VERSION`], warn to stderr. Silently skips when
/// abox is unreachable (a real failure will surface from whatever command the
/// user invoked).
async fn warn_if_abox_outdated(abox: &Arc<AboxAdapter>, abox_bin: &str) {
    use bakudo_core::abox::AboxVersionStatus;
    let Ok(status) = abox.check_version().await else {
        return;
    };
    match status {
        AboxVersionStatus::Ok { .. } => {}
        AboxVersionStatus::TooOld { current, min } => {
            eprintln!(
                "warning: abox {}.{}.{} is older than the minimum {}.{}.{} bakudo requires. \
                 Update by running `just install-abox` from the bakudo-abox workspace root \
                 (current: `{abox_bin}`).",
                current.0, current.1, current.2, min.0, min.1, min.2,
            );
        }
        AboxVersionStatus::Unparseable(raw) => {
            eprintln!(
                "warning: `{abox_bin} --version` returned unexpected output: {raw}  \
                 (expected `abox X.Y.Z`)"
            );
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
    ledger: &Arc<SandboxLedger>,
    task_id: &str,
) -> Result<()> {
    use bakudo_daemon::worktree::{manual_apply, WorktreeAction};

    let repo = std::env::current_dir().ok();
    match manual_apply(task_id, &config.base_branch, repo.as_deref(), abox, ledger).await? {
        WorktreeAction::Merged { .. } => {
            let repo_data_dir = config.resolved_repo_data_dir(repo.as_deref());
            let _ = update_run_summary_outcome(
                &repo_data_dir,
                task_id,
                SandboxState::Merged,
                HookWorktreeAction::Merged,
                Vec::new(),
            )?;
            println!("Merged {} into {}", task_id, config.base_branch);
        }
        WorktreeAction::MergeConflicts { conflicts, .. } => {
            let repo_data_dir = config.resolved_repo_data_dir(repo.as_deref());
            let _ = update_run_summary_outcome(
                &repo_data_dir,
                task_id,
                SandboxState::MergeConflicts,
                HookWorktreeAction::MergeConflicts,
                conflicts.clone(),
            )?;
            eprintln!("Merge conflicts:");
            for c in conflicts {
                eprintln!("  {c}");
            }
            std::process::exit(1);
        }
        WorktreeAction::Discarded
        | WorktreeAction::Preserved
        | WorktreeAction::VerificationFailed { .. } => unreachable!(),
    }
    Ok(())
}

async fn cmd_discard(
    abox: &Arc<AboxAdapter>,
    config: &Arc<BakudoConfig>,
    task_id: &str,
) -> Result<()> {
    abox.stop(std::env::current_dir().ok().as_deref(), task_id, true)
        .await?;
    let repo_data_dir = config.resolved_repo_data_dir(std::env::current_dir().ok().as_deref());
    let _ = update_run_summary_outcome(
        &repo_data_dir,
        task_id,
        SandboxState::Discarded,
        HookWorktreeAction::Discarded,
        Vec::new(),
    )?;
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

async fn cmd_candidates(ledger: &Arc<SandboxLedger>, json: bool) -> Result<()> {
    let mut candidates: Vec<SandboxRecord> = ledger
        .all()
        .await
        .into_iter()
        .filter(|record| {
            matches!(
                record.state,
                SandboxState::Preserved | SandboxState::MergeConflicts
            )
        })
        .collect();
    candidates.sort_by(|left, right| {
        right
            .finished_at
            .cmp(&left.finished_at)
            .then_with(|| right.started_at.cmp(&left.started_at))
            .then_with(|| left.task_id.cmp(&right.task_id))
    });

    if json {
        println!("{}", serde_json::to_string(&candidates)?);
        return Ok(());
    }

    if candidates.is_empty() {
        println!("No preserved candidates.");
        return Ok(());
    }

    println!(
        "{:<24} {:<16} {:<10} {:<12} SUMMARY",
        "TASK ID", "STATE", "PROVIDER", "MODEL"
    );
    println!("{}", "-".repeat(96));
    for record in candidates {
        println!(
            "{:<24} {:<16} {:<10} {:<12} {}",
            record.task_id,
            format!("{:?}", record.state),
            record.provider_id,
            record.model.as_deref().unwrap_or("-"),
            record.prompt_summary
        );
    }
    Ok(())
}

async fn cmd_result(
    config: &Arc<BakudoConfig>,
    ledger: &Arc<SandboxLedger>,
    task_id: &str,
    json: bool,
) -> Result<()> {
    let repo_data_dir = config.resolved_repo_data_dir(std::env::current_dir().ok().as_deref());
    if let Some(summary) = load_run_summary(&repo_data_dir, task_id)? {
        print_run_summary(&summary, json)?;
        return Ok(());
    }

    let state_hint = ledger
        .get(task_id)
        .await
        .map(|record| format!(" Current ledger state: {:?}.", record.state))
        .unwrap_or_default();
    anyhow::bail!("No persisted result found for task '{task_id}'.{state_hint}");
}

async fn cmd_wait(
    config: &Arc<BakudoConfig>,
    ledger: &Arc<SandboxLedger>,
    task_id: &str,
    timeout_secs: u64,
    json: bool,
) -> Result<()> {
    let repo_data_dir = config.resolved_repo_data_dir(std::env::current_dir().ok().as_deref());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

    loop {
        if let Some(summary) = load_run_summary(&repo_data_dir, task_id)? {
            print_run_summary(&summary, json)?;
            return Ok(());
        }

        if tokio::time::Instant::now() >= deadline {
            let state_hint = ledger
                .get(task_id)
                .await
                .map(|record| format!(" Last known ledger state: {:?}.", record.state))
                .unwrap_or_default();
            anyhow::bail!(
                "Timed out waiting for persisted result for task '{task_id}'.{state_hint}"
            );
        }

        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn cmd_artifact(config: &Arc<BakudoConfig>, mission_id: &str, artifact_path: &str) -> Result<()> {
    let repo_data_dir = config.resolved_repo_data_dir(std::env::current_dir().ok().as_deref());
    let artifact = read_swarm_artifact(&repo_data_dir, mission_id, artifact_path)?;
    print!("{artifact}");
    Ok(())
}

fn print_run_summary(summary: &RunSummary, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string(summary)?);
    } else {
        render_single_run_footer(summary);
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

async fn cmd_status(config: &Arc<BakudoConfig>) -> Result<()> {
    let repo_root = std::env::current_dir().ok();
    let repo_data_dir = config.resolved_repo_data_dir(repo_root.as_deref());
    let store = MissionStore::open(repo_data_dir.join("state.db"))?;
    let missions = store.list_missions().await?;
    if missions.is_empty() {
        println!("No missions recorded for this repo.");
        return Ok(());
    }

    println!(
        "{:<38} {:<9} {:<20} {:<12} {:<7} {:<10} GOAL",
        "MISSION ID", "POSTURE", "STATUS", "WORKERS", "INBOX", "QUESTIONS"
    );
    println!("{}", "-".repeat(120));
    for mission in missions {
        let pending_user_messages = store.undelivered_user_messages(mission.id).await?.len();
        let pending_questions = store.open_pending_questions(mission.id).await?.len();
        let latest_issue = store
            .latest_tool_call_error(mission.id)
            .await?
            .map(|summary| summary.trim_start_matches("tool_call_error: ").to_string());
        println!(
            "{:<38} {:<9} {:<20} {:<12} {:<7} {:<10} {}",
            mission.id,
            mission.posture,
            format!("{:?}", mission.status),
            format!(
                "{}/{}",
                mission.wallet.abox_workers_in_flight, mission.wallet.abox_workers_remaining
            ),
            pending_user_messages,
            pending_questions,
            mission.goal
        );
        if let Some(issue) = latest_issue {
            println!("{:>40} latest issue: {}", "", issue);
        }
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
        execute!(stdout, EnableBracketedPaste, EnableFocusChange)?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let mut stdout = io::stdout();
        let _ = execute!(stdout, DisableFocusChange, DisableBracketedPaste);
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
        cmd_tx.clone(),
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

    // Query the terminal's default fg/bg colors once at startup, BEFORE we enter
    // raw mode for event reading. The query writes an OSC 11/10 sequence and
    // reads the reply byte-for-byte; doing it here keeps the reply out of the
    // TUI's own key-event stream. Result is cached for the rest of the process.
    bakudo_tui::terminal_palette::initialize_default_colors();

    let backend = FallbackCursorBackend::new(CrosstermBackend::new(io::stdout()));
    let mut terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(INLINE_VIEWPORT_HEIGHT),
        },
    )?;
    let _guard = TerminalGuard::enter()?;

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

    // Clear the live viewport and leave the shell prompt below it on exit.
    let _ = restore_inline_terminal(&mut terminal);
    result
}

async fn run_daemon(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
    session: SessionRecord,
) -> Result<()> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(64);
    let (event_tx, mut event_rx) = mpsc::channel::<SessionEvent>(256);
    let ctrl = SessionController::with_session(
        config,
        abox,
        ledger,
        registry,
        SessionBootstrap {
            session,
            resume_only: false,
        },
        cmd_tx.clone(),
        cmd_rx,
        event_tx,
    );
    tokio::spawn(ctrl.run());

    println!("Bakudo daemon running. Press Ctrl+C to stop.");
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                let _ = cmd_tx.send(SessionCommand::Shutdown).await;
                break;
            }
            maybe_event = event_rx.recv() => {
                match maybe_event {
                    Some(SessionEvent::Info(msg)) => println!("{msg}"),
                    Some(SessionEvent::Error(msg)) => eprintln!("{msg}"),
                    Some(SessionEvent::Shutdown) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

async fn run_event_loop<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    app: &mut App,
) -> Result<()> {
    loop {
        app.drain_session_events();
        let pending_history = app.take_pending_history();
        insert_history::insert_messages(terminal, &pending_history)?;
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

fn restore_inline_terminal<B: Backend>(terminal: &mut Terminal<B>) -> io::Result<()> {
    terminal.clear()?;
    let blank_lines = INLINE_VIEWPORT_HEIGHT.saturating_sub(1);
    if blank_lines > 0 {
        terminal.backend_mut().append_lines(blank_lines)?;
    }
    terminal.show_cursor()
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

#[derive(Clone)]
struct AttemptExecutionRequest {
    prompt: String,
    provider_override: Option<String>,
    model_override: Option<String>,
    approve_execution: bool,
    candidate_policy: CandidatePolicy,
    sandbox_lifecycle: SandboxLifecycle,
}

struct SwarmRunRequest {
    plan_path: PathBuf,
    approve_execution: bool,
    concurrent_max: Option<usize>,
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
        summary: Box<HeadlessRunSummary>,
    },
}

type HeadlessRunSummary = RunSummary;

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum SwarmJsonEvent {
    TaskStarted {
        mission_id: String,
        plan_task_id: String,
        task_id: String,
        provider_id: String,
        model: Option<String>,
    },
    Progress {
        mission_id: String,
        plan_task_id: String,
        task_id: String,
        message: String,
    },
    RawLine {
        mission_id: String,
        plan_task_id: String,
        task_id: String,
        line: String,
    },
    Error {
        mission_id: String,
        plan_task_id: Option<String>,
        task_id: Option<String>,
        message: String,
    },
    TaskBlocked {
        mission_id: String,
        plan_task_id: String,
        blocked_by: Vec<String>,
    },
    TaskFinished {
        mission_id: String,
        plan_task_id: String,
        summary: Box<SwarmTaskSummary>,
    },
    Finished {
        summary: Box<SwarmRunSummary>,
    },
}

#[derive(Debug, Clone)]
enum AttemptStreamEvent {
    TaskStarted {
        plan_task_id: Option<String>,
        task_id: String,
        provider_id: String,
        model: Option<String>,
    },
    Progress {
        plan_task_id: Option<String>,
        task_id: String,
        message: String,
    },
    RawLine {
        plan_task_id: Option<String>,
        task_id: String,
        line: String,
    },
    Error {
        plan_task_id: Option<String>,
        task_id: Option<String>,
        message: String,
    },
}

async fn run_headless(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
    request: HeadlessRunRequest,
) -> Result<()> {
    let candidate_policy = resolve_candidate_policy(request.discard, request.apply);
    let execution_request = AttemptExecutionRequest {
        prompt: request.prompt,
        provider_override: request.provider_override,
        model_override: request.model_override,
        approve_execution: request.approve_execution,
        candidate_policy,
        sandbox_lifecycle: SandboxLifecycle::Preserved,
    };

    let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
    let config_for_task = config.clone();
    let abox_for_task = abox.clone();
    let registry_for_task = registry.clone();
    let ledger_for_task = ledger.clone();
    let exec_handle = tokio::spawn(async move {
        execute_headless_attempt(
            config_for_task,
            abox_for_task,
            registry_for_task,
            ledger_for_task,
            execution_request,
            Some(stream_tx),
            None,
        )
        .await
    });

    while let Some(event) = stream_rx.recv().await {
        emit_headless_stream_event(request.output_mode, event)?;
    }

    let summary = match exec_handle.await {
        Ok(Ok(summary)) => summary,
        Ok(Err(err)) => return Err(err),
        Err(err) => return Err(err.into()),
    };

    validate_output_schema(request.output_schema.as_deref(), &summary)?;
    emit_headless_event(
        request.output_mode,
        &HeadlessJsonEvent::Finished {
            summary: Box::new(summary.clone()),
        },
    )?;

    if request.output_mode == HeadlessOutputMode::Human {
        render_single_run_footer(&summary);
    }

    if summary.worker_status == WorkerStatus::Succeeded {
        Ok(())
    } else {
        anyhow::bail!(
            "task {} finished with {:?}",
            summary.task_id,
            summary.worker_status
        );
    }
}

async fn run_swarm_headless(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
    request: SwarmRunRequest,
) -> Result<()> {
    let plan_text = std::fs::read_to_string(&request.plan_path).with_context(|| {
        format!(
            "failed to read swarm plan '{}'",
            request.plan_path.display()
        )
    })?;
    let mut plan: SwarmPlan = serde_json::from_str(&plan_text).with_context(|| {
        format!(
            "failed to parse swarm plan '{}'",
            request.plan_path.display()
        )
    })?;
    plan.validate()
        .map_err(|err| anyhow::anyhow!("invalid swarm plan: {err}"))?;

    let concurrent_max = request.concurrent_max.unwrap_or(plan.concurrent_max);
    if concurrent_max == 0 {
        anyhow::bail!("swarm concurrency must be at least 1");
    }

    let mission_id = plan
        .mission_id
        .take()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("mission-{}", Uuid::new_v4()));
    let artifact_repo_root = current_repo_root_path().or_else(|| std::env::current_dir().ok());
    let repo_data_dir = config.resolved_repo_data_dir(artifact_repo_root.as_deref());
    let artifact_root = swarm_artifact_root(&repo_data_dir, &mission_id);

    let mut pending: HashSet<String> = plan.tasks.iter().map(|task| task.id.clone()).collect();
    let mut completed: HashMap<String, SwarmTaskSummary> = HashMap::new();
    let (stream_tx, mut stream_rx) = mpsc::unbounded_channel::<AttemptStreamEvent>();
    let mut running = JoinSet::<(String, SwarmTaskSummary)>::new();

    if request.output_mode == HeadlessOutputMode::Human {
        println!("Swarm artifacts root: {}", artifact_root.display());
    }

    while completed.len() < plan.tasks.len() {
        let mut progressed = false;

        while running.len() < concurrent_max {
            let mut next_task = None;

            for task in &plan.tasks {
                if !pending.contains(&task.id) {
                    continue;
                }

                let mut waiting_on = false;
                let mut blocked_by = Vec::new();
                for dep in &task.depends_on {
                    match completed.get(dep) {
                        Some(summary) if summary.status.is_success() => {}
                        Some(_) => blocked_by.push(dep.clone()),
                        None => {
                            waiting_on = true;
                            break;
                        }
                    }
                }

                if waiting_on {
                    continue;
                }

                if !blocked_by.is_empty() {
                    let task_id = task.id.clone();
                    pending.remove(&task_id);
                    let summary = build_blocked_task_summary(task, blocked_by.clone());
                    let summary =
                        finalize_swarm_task_summary(&repo_data_dir, &mission_id, summary)?;
                    completed.insert(task_id.clone(), summary);
                    emit_swarm_event(
                        request.output_mode,
                        &SwarmJsonEvent::TaskBlocked {
                            mission_id: mission_id.clone(),
                            plan_task_id: task_id.clone(),
                            blocked_by: blocked_by.clone(),
                        },
                    )?;
                    if request.output_mode == HeadlessOutputMode::Human {
                        println!(
                            "[{task_id}] blocked by failed dependencies: {}",
                            blocked_by.join(", ")
                        );
                    }
                    progressed = true;
                    continue;
                }

                next_task = Some(task.clone());
                break;
            }

            let Some(task) = next_task else {
                break;
            };

            pending.remove(&task.id);
            let config_for_task = config.clone();
            let abox_for_task = abox.clone();
            let registry_for_task = registry.clone();
            let ledger_for_task = ledger.clone();
            let stream_tx_for_task = stream_tx.clone();
            let plan_task_id = task.id.clone();
            let execution_request = AttemptExecutionRequest {
                prompt: task.prompt.clone(),
                provider_override: task.provider.clone(),
                model_override: task.model.clone(),
                approve_execution: request.approve_execution || task.approve_execution,
                candidate_policy: task.candidate_policy.unwrap_or(config.candidate_policy),
                sandbox_lifecycle: task.sandbox_lifecycle.unwrap_or(config.sandbox_lifecycle),
            };

            running.spawn(async move {
                let summary = match execute_headless_attempt(
                    config_for_task,
                    abox_for_task,
                    registry_for_task,
                    ledger_for_task,
                    execution_request,
                    Some(stream_tx_for_task),
                    Some(plan_task_id.clone()),
                )
                .await
                {
                    Ok(run) => build_completed_task_summary(&task, run),
                    Err(err) => build_infra_error_task_summary(&task, err.to_string()),
                };
                (plan_task_id, summary)
            });
            progressed = true;
        }

        if completed.len() == plan.tasks.len() {
            break;
        }

        if running.is_empty() {
            if progressed {
                continue;
            }
            anyhow::bail!("swarm scheduler stalled before all tasks completed");
        }

        tokio::select! {
            Some(event) = stream_rx.recv() => {
                emit_swarm_stream_event(request.output_mode, &mission_id, event)?;
            }
            maybe_joined = running.join_next() => {
                let Some(joined) = maybe_joined else {
                    continue;
                };
                let (task_id, summary) = joined?;
                let summary =
                    finalize_swarm_task_summary(&repo_data_dir, &mission_id, summary)?;
                emit_swarm_event(
                    request.output_mode,
                    &SwarmJsonEvent::TaskFinished {
                        mission_id: mission_id.clone(),
                        plan_task_id: task_id.clone(),
                        summary: Box::new(summary.clone()),
                    },
                )?;
                if request.output_mode == HeadlessOutputMode::Human {
                    println!("[{task_id}] finished: {:?}", summary.status);
                }
                completed.insert(task_id, summary);
            }
        }
    }

    while let Ok(event) = stream_rx.try_recv() {
        emit_swarm_stream_event(request.output_mode, &mission_id, event)?;
    }

    let mut tasks = Vec::with_capacity(plan.tasks.len());
    for task in &plan.tasks {
        if let Some(summary) = completed.remove(&task.id) {
            tasks.push(summary);
        }
    }
    let summary = SwarmRunSummary {
        mission_id,
        goal: plan.goal.clone(),
        concurrent_max,
        totals: SwarmRunTotals::from_tasks(&tasks),
        tasks,
    };
    save_swarm_run_summary(&repo_data_dir, &summary)?;

    validate_output_schema(request.output_schema.as_deref(), &summary)?;
    emit_swarm_event(
        request.output_mode,
        &SwarmJsonEvent::Finished {
            summary: Box::new(summary.clone()),
        },
    )?;

    if request.output_mode == HeadlessOutputMode::Human {
        println!(
            "Swarm finished: {} succeeded, {} failed, {} timed out, {} blocked, {} infra errors.",
            summary.totals.succeeded,
            summary.totals.failed,
            summary.totals.timed_out,
            summary.totals.blocked,
            summary.totals.infra_error
        );
    }

    if summary.tasks.iter().all(|task| task.status.is_success()) {
        Ok(())
    } else {
        anyhow::bail!(
            "swarm mission '{}' completed with non-success task outcomes",
            summary.mission_id
        );
    }
}

async fn execute_headless_attempt(
    config: Arc<BakudoConfig>,
    abox: Arc<AboxAdapter>,
    registry: Arc<ProviderRegistry>,
    ledger: Arc<SandboxLedger>,
    request: AttemptExecutionRequest,
    stream_tx: Option<mpsc::UnboundedSender<AttemptStreamEvent>>,
    plan_task_id: Option<String>,
) -> Result<HeadlessRunSummary> {
    use bakudo_core::abox::sandbox_task_id;
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

    let spec = config.build_attempt_spec(
        &request.prompt,
        &provider_id,
        model.clone(),
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
        execution_decision.allow_all_tools,
        request.candidate_policy,
        request.sandbox_lifecycle,
    );

    let task_id = sandbox_task_id(&spec.attempt_id.0);
    let repo_data_dir = config.resolved_repo_data_dir_from_str(spec.repo_root.as_deref());
    if let Some(tx) = &stream_tx {
        let _ = tx.send(AttemptStreamEvent::TaskStarted {
            plan_task_id: plan_task_id.clone(),
            task_id: task_id.clone(),
            provider_id: provider_id.clone(),
            model: model.clone(),
        });
    }

    let cfg = Arc::new(TaskRunnerConfig {
        abox: abox.clone(),
        ledger: ledger.clone(),
        data_dir: repo_data_dir.join("runs"),
        trace_recorder: bakudo_daemon::trace::TraceRecorder::new(repo_data_dir.clone()),
        worker_command: provider
            .build_worker_command(model.as_deref(), execution_decision.allow_all_tools),
        memory_mib: provider.memory_mib,
        cpus: provider.cpus,
    });

    let (mut rx, handle) = run_attempt(spec.clone(), cfg).await;
    while let Some(event) = rx.recv().await {
        if let Some(tx) = &stream_tx {
            match event {
                RunnerEvent::RawLine(line) => {
                    let _ = tx.send(AttemptStreamEvent::RawLine {
                        plan_task_id: plan_task_id.clone(),
                        task_id: task_id.clone(),
                        line,
                    });
                }
                RunnerEvent::Progress(progress) => {
                    let _ = tx.send(AttemptStreamEvent::Progress {
                        plan_task_id: plan_task_id.clone(),
                        task_id: task_id.clone(),
                        message: progress.message,
                    });
                }
                RunnerEvent::InfraError(message) => {
                    let _ = tx.send(AttemptStreamEvent::Error {
                        plan_task_id: plan_task_id.clone(),
                        task_id: Some(task_id.clone()),
                        message,
                    });
                }
                RunnerEvent::Finished(_) => {}
            }
        }
    }

    let result = match handle.await {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            let summary = HeadlessRunSummary::infra_error(
                task_id,
                spec.attempt_id.0.clone(),
                spec.session_id.0.clone(),
                provider_id,
                model,
                spec.repo_root.clone(),
                spec.candidate_policy,
                spec.sandbox_lifecycle,
                err.to_string(),
            );
            save_run_summary(&repo_data_dir, &summary)?;
            return Err(err.into());
        }
        Err(err) => {
            let summary = HeadlessRunSummary::infra_error(
                task_id,
                spec.attempt_id.0.clone(),
                spec.session_id.0.clone(),
                provider_id,
                model,
                spec.repo_root.clone(),
                spec.candidate_policy,
                spec.sandbox_lifecycle,
                err.to_string(),
            );
            save_run_summary(&repo_data_dir, &summary)?;
            return Err(err.into());
        }
    };

    let (final_state, worktree_action, merge_conflicts, verification) =
        if result.status == WorkerStatus::Succeeded {
            match apply_candidate_policy(
                &task_id,
                &spec.candidate_policy,
                &config.base_branch,
                std::env::current_dir().ok().as_deref(),
                &abox,
                &ledger,
                config.auto_apply_verify_command.as_deref().map(|command| {
                    bakudo_daemon::worktree::AutoApplyVerificationPolicy {
                        command,
                        timeout_secs: config.timeout_secs,
                    }
                }),
            )
            .await?
            {
                bakudo_daemon::worktree::WorktreeAction::Merged { verification } => (
                    SandboxState::Merged,
                    HookWorktreeAction::Merged,
                    Vec::new(),
                    verification,
                ),
                bakudo_daemon::worktree::WorktreeAction::MergeConflicts {
                    conflicts,
                    verification,
                } => (
                    SandboxState::MergeConflicts,
                    HookWorktreeAction::MergeConflicts,
                    conflicts,
                    verification,
                ),
                bakudo_daemon::worktree::WorktreeAction::Discarded => (
                    SandboxState::Discarded,
                    HookWorktreeAction::Discarded,
                    Vec::new(),
                    None,
                ),
                bakudo_daemon::worktree::WorktreeAction::Preserved => (
                    SandboxState::Preserved,
                    HookWorktreeAction::Preserved,
                    Vec::new(),
                    None,
                ),
                bakudo_daemon::worktree::WorktreeAction::VerificationFailed { verification } => (
                    SandboxState::Preserved,
                    HookWorktreeAction::VerificationFailed,
                    Vec::new(),
                    Some(verification),
                ),
            }
        } else {
            (
                match result.status {
                    WorkerStatus::Succeeded => SandboxState::Preserved,
                    WorkerStatus::TimedOut => SandboxState::TimedOut,
                    WorkerStatus::Failed | WorkerStatus::Cancelled => SandboxState::Failed {
                        exit_code: result.exit_code,
                    },
                },
                HookWorktreeAction::NotApplied,
                Vec::new(),
                None,
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
        verification: verification.clone(),
        error: None,
    };
    save_run_summary(&repo_data_dir, &summary)?;

    let hook_payload = PostRunHookPayload {
        session_id: spec.session_id.clone(),
        attempt_id: spec.attempt_id.clone(),
        task_id: task_id.clone(),
        repo_root: spec.repo_root.clone(),
        provider_id,
        model,
        candidate_policy: spec.candidate_policy,
        sandbox_lifecycle: spec.sandbox_lifecycle,
        worker_status: result.status.clone(),
        final_state,
        worktree_action,
        summary: result.summary.clone(),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        merge_conflicts,
        verification,
    };
    if let Err(err) = run_post_run_hook(&config, &hook_payload).await {
        if let Some(tx) = &stream_tx {
            let _ = tx.send(AttemptStreamEvent::Error {
                plan_task_id,
                task_id: Some(task_id),
                message: format!("post-run hook failed: {err}"),
            });
        }
    }

    Ok(summary)
}

fn resolve_candidate_policy(discard: bool, apply: bool) -> CandidatePolicy {
    if discard {
        CandidatePolicy::Discard
    } else if apply {
        CandidatePolicy::AutoApply
    } else {
        CandidatePolicy::Review
    }
}

fn build_completed_task_summary(task: &SwarmTaskPlan, run: HeadlessRunSummary) -> SwarmTaskSummary {
    SwarmTaskSummary {
        id: task.id.clone(),
        parent_task_id: task.parent_task_id.clone(),
        depends_on: task.depends_on.clone(),
        role: task.role.clone(),
        goal: task.goal.clone(),
        artifact_path: task.artifact_path.clone(),
        status: swarm_status_from_worker(&run.worker_status),
        blocked_by: Vec::new(),
        error: None,
        run: Some(run),
    }
}

fn build_infra_error_task_summary(task: &SwarmTaskPlan, error: String) -> SwarmTaskSummary {
    SwarmTaskSummary {
        id: task.id.clone(),
        parent_task_id: task.parent_task_id.clone(),
        depends_on: task.depends_on.clone(),
        role: task.role.clone(),
        goal: task.goal.clone(),
        artifact_path: task.artifact_path.clone(),
        status: SwarmTaskStatus::InfraError,
        blocked_by: Vec::new(),
        error: Some(error),
        run: None,
    }
}

fn build_blocked_task_summary(task: &SwarmTaskPlan, blocked_by: Vec<String>) -> SwarmTaskSummary {
    SwarmTaskSummary {
        id: task.id.clone(),
        parent_task_id: task.parent_task_id.clone(),
        depends_on: task.depends_on.clone(),
        role: task.role.clone(),
        goal: task.goal.clone(),
        artifact_path: task.artifact_path.clone(),
        status: SwarmTaskStatus::Blocked,
        blocked_by,
        error: None,
        run: None,
    }
}

fn swarm_status_from_worker(status: &WorkerStatus) -> SwarmTaskStatus {
    match status {
        WorkerStatus::Succeeded => SwarmTaskStatus::Succeeded,
        WorkerStatus::Failed => SwarmTaskStatus::Failed,
        WorkerStatus::TimedOut => SwarmTaskStatus::TimedOut,
        WorkerStatus::Cancelled => SwarmTaskStatus::Cancelled,
    }
}

fn finalize_swarm_task_summary(
    repo_data_dir: &Path,
    mission_id: &str,
    summary: SwarmTaskSummary,
) -> Result<SwarmTaskSummary> {
    if let Some(path) = &summary.artifact_path {
        bakudo_core::control::write_swarm_artifact(repo_data_dir, mission_id, path, &summary)?;
    }
    Ok(summary)
}

fn emit_headless_event(mode: HeadlessOutputMode, event: &HeadlessJsonEvent) -> Result<()> {
    if mode == HeadlessOutputMode::Json {
        println!("{}", serde_json::to_string(event)?);
    }
    Ok(())
}

fn emit_headless_stream_event(mode: HeadlessOutputMode, event: AttemptStreamEvent) -> Result<()> {
    match event {
        AttemptStreamEvent::TaskStarted {
            task_id,
            provider_id,
            model,
            ..
        } => {
            emit_headless_event(
                mode,
                &HeadlessJsonEvent::TaskStarted {
                    task_id: task_id.clone(),
                    provider_id: provider_id.clone(),
                    model: model.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                println!("Dispatching task {task_id} to provider '{provider_id}'...");
            }
        }
        AttemptStreamEvent::Progress {
            task_id, message, ..
        } => {
            emit_headless_event(
                mode,
                &HeadlessJsonEvent::Progress {
                    task_id,
                    message: message.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                println!("[event] {message}");
            }
        }
        AttemptStreamEvent::RawLine { task_id, line, .. } => {
            emit_headless_event(
                mode,
                &HeadlessJsonEvent::RawLine {
                    task_id,
                    line: line.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                println!("{line}");
            }
        }
        AttemptStreamEvent::Error {
            task_id, message, ..
        } => {
            emit_headless_event(
                mode,
                &HeadlessJsonEvent::Error {
                    task_id,
                    message: message.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                eprintln!("[error] {message}");
            }
        }
    }
    Ok(())
}

fn emit_swarm_event(mode: HeadlessOutputMode, event: &SwarmJsonEvent) -> Result<()> {
    if mode == HeadlessOutputMode::Json {
        println!("{}", serde_json::to_string(event)?);
    }
    Ok(())
}

fn emit_swarm_stream_event(
    mode: HeadlessOutputMode,
    mission_id: &str,
    event: AttemptStreamEvent,
) -> Result<()> {
    match event {
        AttemptStreamEvent::TaskStarted {
            plan_task_id,
            task_id,
            provider_id,
            model,
        } => {
            let plan_task_id = plan_task_id.unwrap_or_else(|| task_id.clone());
            emit_swarm_event(
                mode,
                &SwarmJsonEvent::TaskStarted {
                    mission_id: mission_id.to_string(),
                    plan_task_id: plan_task_id.clone(),
                    task_id,
                    provider_id: provider_id.clone(),
                    model: model.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                println!("[{plan_task_id}] dispatching to provider '{provider_id}'...");
            }
        }
        AttemptStreamEvent::Progress {
            plan_task_id,
            task_id,
            message,
        } => {
            let plan_task_id = plan_task_id.unwrap_or_else(|| task_id.clone());
            emit_swarm_event(
                mode,
                &SwarmJsonEvent::Progress {
                    mission_id: mission_id.to_string(),
                    plan_task_id: plan_task_id.clone(),
                    task_id,
                    message: message.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                println!("[{plan_task_id}] {message}");
            }
        }
        AttemptStreamEvent::RawLine {
            plan_task_id,
            task_id,
            line,
        } => {
            let plan_task_id = plan_task_id.unwrap_or_else(|| task_id.clone());
            emit_swarm_event(
                mode,
                &SwarmJsonEvent::RawLine {
                    mission_id: mission_id.to_string(),
                    plan_task_id: plan_task_id.clone(),
                    task_id,
                    line: line.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                println!("[{plan_task_id}] {line}");
            }
        }
        AttemptStreamEvent::Error {
            plan_task_id,
            task_id,
            message,
        } => {
            emit_swarm_event(
                mode,
                &SwarmJsonEvent::Error {
                    mission_id: mission_id.to_string(),
                    plan_task_id: plan_task_id.clone(),
                    task_id,
                    message: message.clone(),
                },
            )?;
            if mode == HeadlessOutputMode::Human {
                match plan_task_id {
                    Some(id) => eprintln!("[{id}] error: {message}"),
                    None => eprintln!("[swarm] error: {message}"),
                }
            }
        }
    }
    Ok(())
}

fn render_single_run_footer(summary: &HeadlessRunSummary) {
    println!(
        "\nTask finished: {:?} in {}ms",
        summary.worker_status, summary.duration_ms
    );
    if let Some(error) = &summary.error {
        eprintln!("Error: {error}");
    }
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
            println!("Worktree preserved at task_id: {}", summary.task_id);
        }
        HookWorktreeAction::VerificationFailed => {
            println!("Worktree preserved after failed auto-apply verification.");
        }
        HookWorktreeAction::NotApplied => {}
    }
}

fn validate_output_schema<T: Serialize>(schema_path: Option<&Path>, summary: &T) -> Result<()> {
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
