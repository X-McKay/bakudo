//! Application state for the Bakudo TUI.
//!
//! The `App` struct holds all mutable state for the TUI. It is updated by the
//! event loop in response to terminal input events and session controller
//! events.
//!
//! Key improvements over the initial implementation:
//!   - Bracketed-paste support: pasted text is inserted at the cursor.
//!   - Tab-completion for slash commands.
//!   - Ctrl+W (delete word) and Ctrl+K (kill to end of line) bindings.
//!   - Spinner tick counter for animated running-task indicators.
//!   - Terminal focus tracking for panel dimming.
//!   - `available_during_task` guard so config-changing commands are blocked
//!     while a task is in flight.

use std::cmp::Reverse;
use std::collections::VecDeque;
use std::sync::Arc;

use chrono::{DateTime, Local};
use tokio::sync::mpsc;

use bakudo_core::config::BakudoConfig;
use bakudo_core::protocol::{WorkerProgressKind, WorkerStatus};
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};
use bakudo_daemon::session_controller::{SessionCommand, SessionEvent};

use crate::commands::{completions_for, help_text, parse_slash, ParsedCommand, SlashCommand};

/// Maximum number of chat messages to keep in the transcript ring buffer.
const MAX_TRANSCRIPT_LINES: usize = 2000;

/// Maximum number of sandbox shelf entries to show.
const MAX_SHELF_ENTRIES: usize = 50;

// ─── Chat message ──────────────────────────────────────────────────────────

/// A single message in the chat transcript.
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
    pub timestamp: DateTime<Local>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MessageRole {
    User,
    System,
    AgentOutput,
    Error,
    Info,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            content: content.into(),
            timestamp: Local::now(),
        }
    }
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::System,
            content: content.into(),
            timestamp: Local::now(),
        }
    }
    pub fn agent(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::AgentOutput,
            content: content.into(),
            timestamp: Local::now(),
        }
    }
    pub fn error(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Error,
            content: content.into(),
            timestamp: Local::now(),
        }
    }
    pub fn info(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Info,
            content: content.into(),
            timestamp: Local::now(),
        }
    }
}

// ─── Shelf entry ───────────────────────────────────────────────────────────

/// A sandbox entry shown in the right-side shelf.
#[derive(Debug, Clone)]
pub struct ShelfEntry {
    pub task_id: String,
    pub provider: String,
    pub model: Option<String>,
    pub prompt_summary: String,
    pub last_note: String,
    pub state_label: String,
    pub state_color: ShelfColor,
    pub started_at: DateTime<Local>,
    pub updated_at: DateTime<Local>,
    /// If Some, a worktree action was just dispatched and we're waiting for
    /// the daemon's TaskFinished/Error response.
    pub pending_action: Option<PendingAction>,
}

/// A worktree action that was dispatched and is awaiting daemon completion.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PendingAction {
    Applying,
    Discarding,
}

impl PendingAction {
    pub fn label(&self) -> &'static str {
        match self {
            PendingAction::Applying => "applying",
            PendingAction::Discarding => "discarding",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ShelfColor {
    Running,
    Preserved,
    Merged,
    Discarded,
    Failed,
    Conflicts,
    TimedOut,
}

// ─── Focus ─────────────────────────────────────────────────────────────────

/// Which panel has keyboard focus.
#[derive(Debug, Clone, PartialEq)]
pub enum FocusedPanel {
    Chat,
    Shelf,
}

// ─── App state ─────────────────────────────────────────────────────────────

/// The top-level application state.
pub struct App {
    pub config: Arc<BakudoConfig>,
    pub registry: Arc<ProviderRegistry>,
    pub ledger: Arc<SandboxLedger>,
    pub workspace_label: String,
    pub session_id: String,

    /// Chat transcript (newest at the end).
    pub transcript: VecDeque<ChatMessage>,

    /// Current text in the composer input.
    pub input: String,
    /// Cursor position within `input` (byte offset).
    pub cursor: usize,

    /// Scroll offset for the transcript (lines from the bottom).
    pub scroll_offset: usize,

    /// Sandbox shelf entries.
    pub shelf: VecDeque<ShelfEntry>,
    /// Selected shelf index (for keyboard navigation).
    pub shelf_selected: usize,

    /// Which panel has focus.
    pub focus: FocusedPanel,

    /// Whether the terminal window currently has focus (for panel dimming).
    pub terminal_focused: bool,

    /// Current provider ID.
    pub provider_id: String,
    /// Current model (None = provider default).
    pub model: Option<String>,

    /// Number of tasks currently in-flight (used to gate commands).
    pub active_task_count: usize,

    /// Spinner tick counter, incremented every Tick event.
    pub tick: u64,

    /// Tab-completion candidates for the current input prefix.
    pub completions: Vec<&'static str>,
    /// Index into `completions` for cycling with Tab.
    pub completion_idx: usize,

    /// Whether the app should exit.
    pub should_quit: bool,

    /// Channel to send commands to the session controller.
    cmd_tx: mpsc::Sender<SessionCommand>,
    /// Channel to receive events from the session controller.
    event_rx: mpsc::Receiver<SessionEvent>,
}

impl App {
    pub fn new(
        config: Arc<BakudoConfig>,
        registry: Arc<ProviderRegistry>,
        ledger: Arc<SandboxLedger>,
        cmd_tx: mpsc::Sender<SessionCommand>,
        event_rx: mpsc::Receiver<SessionEvent>,
    ) -> Self {
        let provider_id = config.default_provider.clone();
        let model = config.default_model.clone();
        let workspace_label = std::env::current_dir()
            .ok()
            .and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
            })
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| "workspace".to_string());
        let mut app = Self {
            config,
            registry,
            ledger,
            workspace_label,
            session_id: String::new(),
            transcript: VecDeque::new(),
            input: String::new(),
            cursor: 0,
            scroll_offset: 0,
            shelf: VecDeque::new(),
            shelf_selected: 0,
            focus: FocusedPanel::Chat,
            terminal_focused: true,
            provider_id,
            model,
            active_task_count: 0,
            tick: 0,
            completions: Vec::new(),
            completion_idx: 0,
            should_quit: false,
            cmd_tx,
            event_rx,
        };
        app.push_message(ChatMessage::system(
            "Welcome to Bakudo v2.\n\
             Type a prompt and press Enter to dispatch a task to a sandbox.\n\
             Type /help for available commands, or /status to see the current session id.",
        ));
        app
    }

    // ── Transcript ─────────────────────────────────────────────────────────

    /// Push a message to the transcript, trimming if over limit.
    ///
    /// If the user is scrolled up, we keep their absolute position anchored
    /// by incrementing `scroll_offset` by the number of newly-added lines.
    pub fn push_message(&mut self, msg: ChatMessage) {
        let added_lines = msg.content.lines().count().max(1);
        self.transcript.push_back(msg);
        while self.transcript.len() > MAX_TRANSCRIPT_LINES {
            self.transcript.pop_front();
        }
        if self.scroll_offset > 0 {
            self.scroll_offset = self.scroll_offset.saturating_add(added_lines);
        }
    }

    pub fn running_shelf_count(&self) -> usize {
        self.shelf
            .iter()
            .filter(|entry| entry.state_color == ShelfColor::Running)
            .count()
    }

    pub fn preserved_shelf_count(&self) -> usize {
        self.shelf
            .iter()
            .filter(|entry| entry.state_color == ShelfColor::Preserved)
            .count()
    }

    pub fn conflict_shelf_count(&self) -> usize {
        self.shelf
            .iter()
            .filter(|entry| entry.state_color == ShelfColor::Conflicts)
            .count()
    }

    pub fn selected_shelf_entry(&self) -> Option<&ShelfEntry> {
        self.shelf.get(self.shelf_selected)
    }

    /// Whether the shelf currently contains an entry with the given task id.
    pub fn shelf_has_task(&self, task_id: &str) -> bool {
        self.shelf.iter().any(|entry| entry.task_id == task_id)
    }

    /// Show a note in the transcript that we are resuming a named session.
    pub fn note_resume(&mut self, session_id: String) {
        self.push_message(ChatMessage::system(format!(
            "Resuming session {session_id}. Prior sandboxes will be rehydrated from the on-disk ledger."
        )));
    }

    /// Human label for the active model (or "default" when unset).
    pub fn model_label(&self) -> String {
        match self.model.as_deref() {
            Some(m) if !m.is_empty() => m.to_string(),
            _ => "default".to_string(),
        }
    }

    /// Sanity-check before sending Dispatch. Currently catches a stale or
    /// mistyped provider in config before it reaches the daemon.
    fn preflight_dispatch(&self) -> Result<(), String> {
        if self.registry.get(&self.provider_id).is_none() {
            return Err(format!(
                "Provider '{}' is not registered. Use /providers to list available providers, \
                 then /provider <id> to switch.",
                self.provider_id
            ));
        }
        Ok(())
    }

    // ── Tick ───────────────────────────────────────────────────────────────

    /// Advance the spinner tick counter.
    pub fn tick(&mut self) {
        self.tick = self.tick.wrapping_add(1);
    }

    // ── Focus tracking ─────────────────────────────────────────────────────

    pub fn on_focus_gained(&mut self) {
        self.terminal_focused = true;
    }

    pub fn on_focus_lost(&mut self) {
        self.terminal_focused = false;
    }

    // ── Global key handler ─────────────────────────────────────────────────

    /// Handle a key press that should be checked before panel-specific routing.
    /// Returns `true` if the event was consumed.
    pub fn handle_global_key(&mut self, key: crossterm::event::KeyEvent) -> bool {
        use crossterm::event::{KeyCode, KeyModifiers};
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            // Ctrl+C / Ctrl+Q — quit.
            KeyCode::Char('c') | KeyCode::Char('q') if ctrl => {
                self.should_quit = true;
                let _ = self.cmd_tx.try_send(SessionCommand::Shutdown);
                true
            }
            // PageUp / PageDown — scroll transcript.
            KeyCode::PageUp => {
                self.scroll_offset = self.scroll_offset.saturating_add(10);
                true
            }
            KeyCode::PageDown => {
                self.scroll_offset = self.scroll_offset.saturating_sub(10);
                true
            }
            _ => false,
        }
    }

    // ── Composer key handler ───────────────────────────────────────────────

    /// Handle a key press when the composer (chat input) has focus.
    pub fn handle_input_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        match key.code {
            // ── Submit ────────────────────────────────────────────────────
            KeyCode::Enter => {
                self.clear_completions();
                self.submit_input();
            }

            // ── Tab — slash-command autocomplete ─────────────────────────
            KeyCode::Tab => {
                if self.input.starts_with('/') {
                    self.cycle_completion();
                } else {
                    // Tab with no slash prefix: switch focus to shelf.
                    self.focus = FocusedPanel::Shelf;
                }
            }

            // ── Escape — clear input or dismiss completions ───────────────
            KeyCode::Esc => {
                if !self.completions.is_empty() {
                    self.clear_completions();
                } else {
                    self.input.clear();
                    self.cursor = 0;
                }
            }

            // ── Ctrl+A / Home — move to start ─────────────────────────────
            KeyCode::Home | KeyCode::Char('a') if ctrl => {
                self.cursor = 0;
            }

            // ── Ctrl+E / End — move to end ────────────────────────────────
            KeyCode::End | KeyCode::Char('e') if ctrl => {
                self.cursor = self.input.len();
            }

            // ── Ctrl+U — clear from cursor to start ───────────────────────
            KeyCode::Char('u') if ctrl => {
                self.input.drain(..self.cursor);
                self.cursor = 0;
                self.update_completions();
            }

            // ── Ctrl+K — kill to end of line ──────────────────────────────
            KeyCode::Char('k') if ctrl => {
                self.input.truncate(self.cursor);
                self.update_completions();
            }

            // ── Ctrl+W — delete previous word ─────────────────────────────
            KeyCode::Char('w') if ctrl => {
                let end = self.cursor;
                // Skip trailing spaces.
                let mut start = end;
                while start > 0 && self.input.as_bytes()[start - 1] == b' ' {
                    start -= 1;
                }
                // Skip word chars.
                while start > 0 && self.input.as_bytes()[start - 1] != b' ' {
                    start -= 1;
                }
                self.input.drain(start..end);
                self.cursor = start;
                self.update_completions();
            }

            // ── Ctrl+Left / Alt+Left — move word left ─────────────────────
            KeyCode::Left if ctrl => {
                self.cursor = self.prev_word_boundary();
            }

            // ── Ctrl+Right / Alt+Right — move word right ──────────────────
            KeyCode::Right if ctrl => {
                self.cursor = self.next_word_boundary();
            }

            // ── Regular character insertion ───────────────────────────────
            // MUST come after all Ctrl+Char guards.
            KeyCode::Char(c) => {
                self.input.insert(self.cursor, c);
                self.cursor += c.len_utf8();
                self.update_completions();
            }

            KeyCode::Backspace if self.cursor > 0 => {
                let prev = self.prev_char_boundary();
                self.input.drain(prev..self.cursor);
                self.cursor = prev;
                self.update_completions();
            }

            KeyCode::Delete if self.cursor < self.input.len() => {
                let next = self.next_char_boundary();
                self.input.drain(self.cursor..next);
                self.update_completions();
            }

            KeyCode::Left if self.cursor > 0 => {
                self.cursor = self.prev_char_boundary();
            }

            KeyCode::Right if self.cursor < self.input.len() => {
                self.cursor = self.next_char_boundary();
            }

            _ => {}
        }
    }

    /// Insert a pasted string at the cursor position.
    pub fn handle_paste(&mut self, text: String) {
        // Strip control characters except newlines; collapse newlines to spaces
        // so a multi-line paste doesn't accidentally submit.
        let sanitised: String = text
            .chars()
            .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
            .filter(|c| !c.is_control())
            .collect();
        self.input.insert_str(self.cursor, &sanitised);
        self.cursor += sanitised.len();
        self.update_completions();
    }

    // ── Shelf key handler ──────────────────────────────────────────────────

    /// Handle a key press when the shelf panel has focus.
    pub fn handle_shelf_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Tab | KeyCode::Esc => {
                self.focus = FocusedPanel::Chat;
            }
            KeyCode::Up | KeyCode::Char('k') if self.shelf_selected > 0 => {
                self.shelf_selected -= 1;
            }
            KeyCode::Down | KeyCode::Char('j') if self.shelf_selected + 1 < self.shelf.len() => {
                self.shelf_selected += 1;
            }
            KeyCode::Char('a') => {
                if let Some(entry) = self.shelf.get(self.shelf_selected) {
                    let task_id = entry.task_id.clone();
                    let _ = self.cmd_tx.try_send(SessionCommand::Apply {
                        task_id: task_id.clone(),
                    });
                    self.set_pending(&task_id, PendingAction::Applying);
                    self.push_message(ChatMessage::info(format!(
                        "Applying worktree for {task_id}…"
                    )));
                }
            }
            KeyCode::Char('d') => {
                if let Some(entry) = self.shelf.get(self.shelf_selected) {
                    let task_id = entry.task_id.clone();
                    let _ = self.cmd_tx.try_send(SessionCommand::Discard {
                        task_id: task_id.clone(),
                    });
                    self.set_pending(&task_id, PendingAction::Discarding);
                    self.push_message(ChatMessage::info(format!(
                        "Discarding worktree for {task_id}…"
                    )));
                }
            }
            _ => {}
        }
    }

    // ── Session event drain ────────────────────────────────────────────────

    /// Process all pending session events (non-blocking).
    pub fn drain_session_events(&mut self) {
        while let Ok(event) = self.event_rx.try_recv() {
            self.handle_session_event(event);
        }
    }

    fn handle_session_event(&mut self, event: SessionEvent) {
        match event {
            SessionEvent::LedgerSnapshot { entries } => {
                self.rebuild_shelf(entries);
                if !self.shelf.is_empty() {
                    self.push_message(ChatMessage::info(format!(
                        "Recovered {} sandbox(es) from the previous session state.",
                        self.shelf.len()
                    )));
                }
            }
            SessionEvent::TaskStarted {
                task_id,
                provider_id,
                model,
                prompt_summary,
            } => {
                self.active_task_count += 1;
                let short = short_task_id(&task_id);
                self.push_message(ChatMessage::info(format!(
                    "⟳  [{short}] {provider_id} dispatched: {prompt_summary}"
                )));
                self.upsert_shelf_entry(ShelfEntry {
                    task_id,
                    provider: provider_id,
                    model,
                    prompt_summary,
                    last_note: "Booting sandbox".to_string(),
                    state_label: "running".to_string(),
                    state_color: ShelfColor::Running,
                    started_at: Local::now(),
                    updated_at: Local::now(),
                    pending_action: None,
                });
            }
            SessionEvent::TaskProgress { task_id, event } => {
                use bakudo_daemon::task_runner::RunnerEvent;
                let short = short_task_id(&task_id);
                match event {
                    RunnerEvent::RawLine(line) => {
                        let line = line.trim();
                        if !line.is_empty() && !is_abox_lifecycle_noise(line) {
                            self.record_shelf_activity(&task_id, line);
                            self.push_message(ChatMessage::agent(format!("[{short}] {line}")));
                        }
                    }
                    RunnerEvent::Progress(p) => {
                        self.record_shelf_activity(&task_id, &p.message);
                        match p.kind {
                            WorkerProgressKind::AssistantMessage => {
                                self.push_message(ChatMessage::agent(format!(
                                    "[{short}] {}",
                                    p.message
                                )));
                            }
                            WorkerProgressKind::ToolCall => {
                                self.push_message(ChatMessage::info(format!(
                                    "[{short}] tool → {}",
                                    p.message
                                )));
                            }
                            WorkerProgressKind::ToolResult => {
                                self.push_message(ChatMessage::info(format!(
                                    "[{short}] tool ✓ {}",
                                    p.message
                                )));
                            }
                            WorkerProgressKind::StatusUpdate => {
                                self.push_message(ChatMessage::info(format!(
                                    "[{short}] {}",
                                    p.message
                                )));
                            }
                            WorkerProgressKind::Heartbeat => {}
                        }
                    }
                    RunnerEvent::InfraError(e) => {
                        self.update_shelf_state(&task_id, "failed", ShelfColor::Failed);
                        self.record_shelf_activity(&task_id, format!("Infrastructure error: {e}"));
                        self.push_message(ChatMessage::error(format!(
                            "[{short}] Infrastructure error: {e}"
                        )));
                    }
                    RunnerEvent::Finished(result) => {
                        self.record_shelf_activity(&task_id, &result.summary);
                        let body = format!(
                            "[{short}] {} ({}, {}ms)",
                            result.summary,
                            render_worker_status(&result.status),
                            result.duration_ms,
                        );
                        let msg = match result.status {
                            WorkerStatus::Succeeded => ChatMessage::info(format!("✓  {body}")),
                            WorkerStatus::Failed
                            | WorkerStatus::TimedOut
                            | WorkerStatus::Cancelled => {
                                ChatMessage::error(failure_chat_body(body, &result))
                            }
                        };
                        self.push_message(msg);
                    }
                }
            }
            SessionEvent::TaskFinished { task_id, state } => {
                if self.active_task_count > 0 {
                    self.active_task_count -= 1;
                }
                let (label, color) = shelf_state_view(&state);
                self.update_shelf_state(&task_id, label, color);
                self.clear_pending(&task_id);
                self.record_shelf_activity(&task_id, shelf_state_note(&state));
                let short = short_task_id(&task_id);
                self.push_message(ChatMessage::info(format!(
                    "[{short}] {}",
                    shelf_state_note(&state)
                )));
            }
            SessionEvent::ProviderChanged { provider_id, model } => {
                self.provider_id = provider_id.clone();
                self.model = model.clone();
                let model_label = match model.as_deref() {
                    Some(m) if !m.is_empty() => m.to_string(),
                    _ => "default".to_string(),
                };
                self.push_message(ChatMessage::info(format!(
                    "Provider → {provider_id}  model → {model_label}"
                )));
            }
            SessionEvent::Info(message) => {
                self.push_message(ChatMessage::info(message));
            }
            SessionEvent::Error(e) => {
                self.clear_all_pending();
                self.push_message(ChatMessage::error(e));
            }
            SessionEvent::Shutdown => {
                self.should_quit = true;
            }
        }
    }

    fn update_shelf_state(&mut self, task_id: &str, label: &str, color: ShelfColor) {
        for entry in &mut self.shelf {
            if entry.task_id == task_id {
                entry.state_label = label.to_string();
                entry.state_color = color.clone();
                entry.updated_at = Local::now();
                break;
            }
        }
    }

    /// Mark a shelf entry as having a worktree action in flight.
    fn set_pending(&mut self, task_id: &str, action: PendingAction) {
        for entry in &mut self.shelf {
            if entry.task_id == task_id {
                entry.pending_action = Some(action);
                entry.updated_at = Local::now();
                break;
            }
        }
    }

    /// Clear pending_action on a single entry.
    fn clear_pending(&mut self, task_id: &str) {
        for entry in &mut self.shelf {
            if entry.task_id == task_id {
                entry.pending_action = None;
                break;
            }
        }
    }

    /// Clear pending_action on every entry when the daemon reports an error.
    fn clear_all_pending(&mut self) {
        for entry in &mut self.shelf {
            entry.pending_action = None;
        }
    }

    fn record_shelf_activity(&mut self, task_id: &str, note: impl Into<String>) {
        let note = truncate_line(note.into(), 120);
        for entry in &mut self.shelf {
            if entry.task_id == task_id {
                entry.last_note = note.clone();
                entry.updated_at = Local::now();
                break;
            }
        }
    }

    fn rebuild_shelf(&mut self, entries: Vec<SandboxRecord>) {
        let mut shelf_entries: Vec<ShelfEntry> =
            entries.into_iter().map(shelf_entry_from_record).collect();
        shelf_entries.sort_by_key(|entry| Reverse(entry.started_at));
        self.active_task_count = shelf_entries
            .iter()
            .filter(|entry| entry.state_color == ShelfColor::Running)
            .count();
        self.shelf = shelf_entries.into_iter().take(MAX_SHELF_ENTRIES).collect();
        if self.shelf.is_empty() {
            self.shelf_selected = 0;
            self.focus = FocusedPanel::Chat;
        } else {
            self.shelf_selected = self.shelf_selected.min(self.shelf.len() - 1);
        }
    }

    fn upsert_shelf_entry(&mut self, entry: ShelfEntry) {
        if let Some(existing) = self
            .shelf
            .iter_mut()
            .find(|item| item.task_id == entry.task_id)
        {
            *existing = entry;
            return;
        }

        self.shelf.push_front(entry);
        while self.shelf.len() > MAX_SHELF_ENTRIES {
            self.shelf.pop_back();
        }
        self.shelf_selected = self.shelf_selected.min(self.shelf.len().saturating_sub(1));
    }

    // ── Input submission ───────────────────────────────────────────────────

    fn submit_input(&mut self) {
        let input = self.input.trim().to_string();
        if input.is_empty() {
            return;
        }
        self.input.clear();
        self.cursor = 0;

        match parse_slash(&input) {
            Some(Ok(parsed)) => {
                self.push_message(ChatMessage::user(input));
                self.handle_parsed_command(parsed);
            }
            Some(Err(msg)) => {
                self.push_message(ChatMessage::user(input));
                self.push_message(ChatMessage::error(msg));
            }
            None => {
                self.push_message(ChatMessage::user(input.clone()));
                if let Err(reason) = self.preflight_dispatch() {
                    self.push_message(ChatMessage::error(reason));
                } else {
                    let _ = self
                        .cmd_tx
                        .try_send(SessionCommand::Dispatch { prompt: input });
                }
            }
        }
    }

    fn handle_parsed_command(&mut self, parsed: ParsedCommand) {
        let ParsedCommand { command, arg } = parsed;

        // Guard commands that should not run during an active task.
        if self.active_task_count > 0 && !command.available_during_task() {
            self.push_message(ChatMessage::error(format!(
                "/{} cannot be used while a task is in progress.",
                command.command()
            )));
            return;
        }

        match command {
            SlashCommand::Provider => self.cmd_provider(arg),
            SlashCommand::Model => self.cmd_model(arg),
            SlashCommand::Providers => self.cmd_providers(),
            SlashCommand::Apply => self.cmd_apply(arg),
            SlashCommand::Discard => self.cmd_discard(arg),
            SlashCommand::Sandboxes => self.cmd_sandboxes(),
            SlashCommand::Diverge => self.cmd_diverge(arg),
            SlashCommand::Diff => self.cmd_diff(arg),
            SlashCommand::New => self.cmd_new(),
            SlashCommand::Clear => self.cmd_clear(),
            SlashCommand::Config => self.cmd_config(),
            SlashCommand::Status => self.cmd_status(),
            SlashCommand::Doctor => self.cmd_doctor(),
            SlashCommand::Help => {
                self.push_message(ChatMessage::info(help_text()));
            }
            SlashCommand::Quit => self.cmd_quit(),
        }
    }

    fn cmd_provider(&mut self, arg: String) {
        if self.registry.get(&arg).is_none() {
            self.push_message(ChatMessage::error(format!(
                "Unknown provider '{arg}'. Use /providers to list available providers."
            )));
        } else {
            let _ = self
                .cmd_tx
                .try_send(SessionCommand::SetProvider { provider_id: arg });
        }
    }

    fn cmd_model(&mut self, arg: String) {
        let model = if arg.is_empty() { None } else { Some(arg) };
        let _ = self.cmd_tx.try_send(SessionCommand::SetModel { model });
    }

    fn cmd_providers(&mut self) {
        let ids = self.registry.list_ids();
        let mut lines = vec!["Registered providers:".to_string()];
        for id in ids {
            if let Some(spec) = self.registry.get(id) {
                let active = if *id == self.provider_id {
                    "  ← active"
                } else {
                    ""
                };
                lines.push(format!("  {:<12} {}{}", id, spec.display_name, active));
            }
        }
        self.push_message(ChatMessage::info(lines.join("\n")));
    }

    fn cmd_apply(&mut self, arg: String) {
        if !self.shelf_has_task(&arg) {
            self.push_message(ChatMessage::error(format!(
                "No sandbox with task id '{arg}' in this session."
            )));
        } else {
            let _ = self.cmd_tx.try_send(SessionCommand::Apply {
                task_id: arg.clone(),
            });
            self.set_pending(&arg, PendingAction::Applying);
            self.push_message(ChatMessage::info(format!("Applying worktree for {arg}…")));
        }
    }

    fn cmd_discard(&mut self, arg: String) {
        if !self.shelf_has_task(&arg) {
            self.push_message(ChatMessage::error(format!(
                "No sandbox with task id '{arg}' in this session."
            )));
        } else {
            let _ = self.cmd_tx.try_send(SessionCommand::Discard {
                task_id: arg.clone(),
            });
            self.set_pending(&arg, PendingAction::Discarding);
            self.push_message(ChatMessage::info(format!("Discarding worktree for {arg}…")));
        }
    }

    fn cmd_sandboxes(&mut self) {
        if self.shelf.is_empty() {
            self.push_message(ChatMessage::info("No sandboxes in this session."));
            return;
        }
        let mut lines = vec![format!("Sandboxes ({}):", self.shelf.len())];
        for entry in &self.shelf {
            let model_suffix = entry
                .model
                .as_deref()
                .filter(|m| !m.is_empty())
                .map(|m| format!("/{m}"))
                .unwrap_or_default();
            lines.push(format!(
                "  [{:<10}] {}  {}{}  {}",
                entry.state_label, entry.task_id, entry.provider, model_suffix, entry.last_note
            ));
        }
        self.push_message(ChatMessage::info(lines.join("\n")));
    }

    fn cmd_diverge(&mut self, arg: String) {
        if !self.shelf_has_task(&arg) {
            self.push_message(ChatMessage::error(format!(
                "No sandbox with task id '{arg}' in this session."
            )));
        } else {
            let _ = self.cmd_tx.try_send(SessionCommand::Diverge {
                task_id: arg.clone(),
            });
            self.push_message(ChatMessage::info(format!("Fetching divergence for {arg}…")));
        }
    }

    fn cmd_diff(&mut self, arg: String) {
        if !self.shelf_has_task(&arg) {
            self.push_message(ChatMessage::error(format!(
                "No sandbox with task id '{arg}' in this session."
            )));
        } else {
            let _ = self.cmd_tx.try_send(SessionCommand::Diff {
                task_id: arg.clone(),
            });
            self.push_message(ChatMessage::info(format!("Fetching diff for {arg}…")));
        }
    }

    fn cmd_new(&mut self) {
        self.transcript.clear();
        self.shelf.clear();
        self.shelf_selected = 0;
        self.push_message(ChatMessage::system(
            "Transcript and shelf view cleared. Running tasks continue in the background and will \
             reappear on the next event.",
        ));
    }

    fn cmd_clear(&mut self) {
        self.transcript.clear();
        self.push_message(ChatMessage::system("Transcript cleared."));
    }

    fn cmd_config(&mut self) {
        let cfg = &self.config;
        let info = format!(
            "Configuration:\n  provider:          {}\n  model:             {}\n  base_branch:       {}\n  timeout:           {}s\n  candidate_policy:  {}\n  sandbox_lifecycle: {}",
            self.provider_id,
            self.model_label(),
            cfg.base_branch,
            cfg.timeout_secs,
            cfg.candidate_policy,
            cfg.sandbox_lifecycle,
        );
        self.push_message(ChatMessage::info(info));
    }

    fn cmd_status(&mut self) {
        let info = format!(
            "Status:\n  session:        {}\n  workspace:      {}\n  provider:       {}\n  model:          {}\n  active tasks:   {}\n  preserved:      {}\n  conflicts:      {}\n  shelf entries:  {}",
            if self.session_id.is_empty() {
                "<uninitialised>"
            } else {
                &self.session_id
            },
            self.workspace_label,
            self.provider_id,
            self.model_label(),
            self.active_task_count,
            self.preserved_shelf_count(),
            self.conflict_shelf_count(),
            self.shelf.len(),
        );
        self.push_message(ChatMessage::info(info));
    }

    fn cmd_doctor(&mut self) {
        let _ = self.cmd_tx.try_send(SessionCommand::Doctor);
        self.push_message(ChatMessage::info("Running health checks…"));
    }

    fn cmd_quit(&mut self) {
        self.should_quit = true;
        let _ = self.cmd_tx.try_send(SessionCommand::Shutdown);
    }

    // ── Tab completion ─────────────────────────────────────────────────────

    fn update_completions(&mut self) {
        if self.input.starts_with('/') {
            let prefix = &self.input[1..];
            // Only show completions if there's no space yet (still typing the command).
            if !prefix.contains(' ') {
                self.completions = completions_for(prefix);
                self.completion_idx = 0;
                return;
            }
        }
        self.completions.clear();
        self.completion_idx = 0;
    }

    fn cycle_completion(&mut self) {
        if self.completions.is_empty() {
            // Trigger completions for current input.
            self.update_completions();
        }
        if self.completions.is_empty() {
            return;
        }
        let candidate = self.completions[self.completion_idx];
        self.input = format!("/{candidate} ");
        self.cursor = self.input.len();
        self.completion_idx = (self.completion_idx + 1) % self.completions.len();
    }

    fn clear_completions(&mut self) {
        self.completions.clear();
        self.completion_idx = 0;
    }

    // ── Cursor helpers ─────────────────────────────────────────────────────

    fn prev_char_boundary(&self) -> usize {
        let mut i = self.cursor.saturating_sub(1);
        while i > 0 && !self.input.is_char_boundary(i) {
            i -= 1;
        }
        i
    }

    fn next_char_boundary(&self) -> usize {
        let mut i = self.cursor + 1;
        while i <= self.input.len() && !self.input.is_char_boundary(i) {
            i += 1;
        }
        i
    }

    fn prev_word_boundary(&self) -> usize {
        let bytes = self.input.as_bytes();
        let mut i = self.cursor;
        // Skip spaces.
        while i > 0 && bytes[i - 1] == b' ' {
            i -= 1;
        }
        // Skip word chars.
        while i > 0 && bytes[i - 1] != b' ' {
            i -= 1;
        }
        i
    }

    fn next_word_boundary(&self) -> usize {
        let bytes = self.input.as_bytes();
        let mut i = self.cursor;
        // Skip word chars.
        while i < bytes.len() && bytes[i] != b' ' {
            i += 1;
        }
        // Skip spaces.
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        i
    }
}

/// Lines emitted by the abox runtime itself that duplicate lifecycle info we
/// already surface via structured events.
fn is_abox_lifecycle_noise(line: &str) -> bool {
    line.starts_with("Sandbox '")
        && (line.ends_with("' starting...") || line.ends_with("' exited cleanly."))
}

/// Build the multi-line chat body for a failed Finished event.
fn failure_chat_body(headline: String, result: &bakudo_core::protocol::WorkerResult) -> String {
    let mut out = headline;
    let stderr_tail = result
        .stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::to_string);
    if let Some(line) = stderr_tail {
        out.push('\n');
        out.push_str("→ stderr: ");
        out.push_str(&truncate_line(line.trim(), 200));
    }
    out.push('\n');
    out.push_str("→ full logs at ~/.local/share/bakudo/bakudo.log");
    out
}

/// Compact a `bakudo-attempt-<uuid>` id down to the first 8 chars of the UUID
/// for inline chat display.
fn short_task_id(task_id: &str) -> &str {
    let tail = task_id.strip_prefix("bakudo-attempt-").unwrap_or(task_id);
    let end = tail
        .char_indices()
        .nth(8)
        .map(|(i, _)| i)
        .unwrap_or(tail.len());
    &tail[..end]
}

fn truncate_line(text: impl Into<String>, max_chars: usize) -> String {
    let text = text.into();
    let mut truncated: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars && max_chars > 1 {
        truncated.pop();
        truncated.push('…');
    }
    truncated
}

fn render_worker_status(status: &WorkerStatus) -> &'static str {
    match status {
        WorkerStatus::Succeeded => "succeeded",
        WorkerStatus::Failed => "failed",
        WorkerStatus::TimedOut => "timed out",
        WorkerStatus::Cancelled => "cancelled",
    }
}

fn shelf_state_view(state: &SandboxState) -> (&'static str, ShelfColor) {
    match state {
        SandboxState::Starting | SandboxState::Running => ("running", ShelfColor::Running),
        SandboxState::Preserved => ("preserved", ShelfColor::Preserved),
        SandboxState::Merged => ("merged", ShelfColor::Merged),
        SandboxState::Discarded => ("discarded", ShelfColor::Discarded),
        SandboxState::Failed { .. } => ("failed", ShelfColor::Failed),
        SandboxState::TimedOut => ("timed out", ShelfColor::TimedOut),
        SandboxState::MergeConflicts => ("conflicts", ShelfColor::Conflicts),
    }
}

fn shelf_state_note(state: &SandboxState) -> String {
    match state {
        SandboxState::Starting | SandboxState::Running => {
            "Task is still running in the sandbox.".to_string()
        }
        SandboxState::Preserved => "Worktree preserved for review.".to_string(),
        SandboxState::Merged => "Worktree merged into the base branch.".to_string(),
        SandboxState::Discarded => "Sandbox discarded and cleaned up.".to_string(),
        SandboxState::Failed { exit_code } => {
            format!("Task failed before producing a clean candidate (exit code {exit_code}).")
        }
        SandboxState::TimedOut => "Task timed out before completion.".to_string(),
        SandboxState::MergeConflicts => {
            "Merge conflicts detected; manual resolution is required.".to_string()
        }
    }
}

fn shelf_entry_from_record(record: SandboxRecord) -> ShelfEntry {
    let (state_label, state_color) = shelf_state_view(&record.state);
    let updated_at = record
        .finished_at
        .unwrap_or(record.started_at)
        .with_timezone(&Local);

    ShelfEntry {
        task_id: record.task_id,
        provider: record.provider_id,
        model: record.model.filter(|m| !m.is_empty()),
        prompt_summary: truncate_line(record.prompt_summary, 100),
        last_note: truncate_line(shelf_state_note(&record.state), 120),
        state_label: state_label.to_string(),
        state_color,
        started_at: record.started_at.with_timezone(&Local),
        updated_at,
        pending_action: None,
    }
}
