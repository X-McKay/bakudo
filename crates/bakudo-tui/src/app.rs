//! Application state for the ratatui TUI.
//!
//! The `App` struct holds all mutable state for the TUI. It is updated by the
//! event loop in response to terminal input events and session controller
//! events.

use std::collections::VecDeque;
use std::sync::Arc;

use chrono::{DateTime, Local};
use tokio::sync::mpsc;

use bakudo_core::config::BakudoConfig;
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::state::SandboxLedger;
use bakudo_daemon::session_controller::{SessionCommand, SessionEvent};

use crate::commands::{parse_slash, help_text, SlashCommand};

/// Maximum number of chat messages to keep in the transcript.
const MAX_TRANSCRIPT_LINES: usize = 2000;
/// Maximum number of sandbox shelf entries to show.
const MAX_SHELF_ENTRIES: usize = 50;

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
        Self { role: MessageRole::User, content: content.into(), timestamp: Local::now() }
    }
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: MessageRole::System, content: content.into(), timestamp: Local::now() }
    }
    pub fn agent(content: impl Into<String>) -> Self {
        Self { role: MessageRole::AgentOutput, content: content.into(), timestamp: Local::now() }
    }
    pub fn error(content: impl Into<String>) -> Self {
        Self { role: MessageRole::Error, content: content.into(), timestamp: Local::now() }
    }
    pub fn info(content: impl Into<String>) -> Self {
        Self { role: MessageRole::Info, content: content.into(), timestamp: Local::now() }
    }
}

/// A sandbox entry shown in the right-side shelf.
#[derive(Debug, Clone)]
pub struct ShelfEntry {
    pub task_id: String,
    pub provider: String,
    pub prompt_summary: String,
    pub state_label: String,
    pub state_color: ShelfColor,
    pub started_at: DateTime<Local>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ShelfColor {
    Running,
    Preserved,
    Merged,
    Discarded,
    Failed,
    Conflicts,
}

/// Which panel has keyboard focus.
#[derive(Debug, Clone, PartialEq)]
pub enum FocusedPanel {
    Chat,
    Shelf,
}

/// The top-level application state.
pub struct App {
    pub config: Arc<BakudoConfig>,
    pub registry: Arc<ProviderRegistry>,
    pub ledger: Arc<SandboxLedger>,

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

    /// Current provider ID.
    pub provider_id: String,
    /// Current model.
    pub model: String,

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
        let mut app = Self {
            config,
            registry,
            ledger,
            transcript: VecDeque::new(),
            input: String::new(),
            cursor: 0,
            scroll_offset: 0,
            shelf: VecDeque::new(),
            shelf_selected: 0,
            focus: FocusedPanel::Chat,
            provider_id,
            model,
            should_quit: false,
            cmd_tx,
            event_rx,
        };
        app.push_message(ChatMessage::system(
            "Welcome to Bakudo v2. Type a prompt and press Enter to dispatch a task.
Type /help for available commands."
        ));
        app
    }

    /// Push a message to the transcript, trimming if over limit.
    pub fn push_message(&mut self, msg: ChatMessage) {
        self.transcript.push_back(msg);
        while self.transcript.len() > MAX_TRANSCRIPT_LINES {
            self.transcript.pop_front();
        }
        // Auto-scroll to bottom.
        self.scroll_offset = 0;
    }

    /// Handle a key press in the composer input.
    pub fn handle_input_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Enter => self.submit_input(),
            // Ctrl+A / Home — move to start of line.
            KeyCode::Home | KeyCode::Char('a') if ctrl => {
                self.cursor = 0;
            }
            // Ctrl+E / End — move to end of line.
            KeyCode::End | KeyCode::Char('e') if ctrl => {
                self.cursor = self.input.len();
            }
            // Ctrl+U — clear from cursor to start.
            KeyCode::Char('u') if ctrl => {
                self.input.drain(..self.cursor);
                self.cursor = 0;
            }
            // Regular character insertion (must come AFTER all Ctrl+Char guards).
            KeyCode::Char(c) => {
                self.input.insert(self.cursor, c);
                self.cursor += c.len_utf8();
            }
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    let prev = self.prev_char_boundary();
                    self.input.drain(prev..self.cursor);
                    self.cursor = prev;
                }
            }
            KeyCode::Delete => {
                if self.cursor < self.input.len() {
                    let next = self.next_char_boundary();
                    self.input.drain(self.cursor..next);
                }
            }
            KeyCode::Left => {
                if self.cursor > 0 {
                    self.cursor = self.prev_char_boundary();
                }
            }
            KeyCode::Right => {
                if self.cursor < self.input.len() {
                    self.cursor = self.next_char_boundary();
                }
            }
            KeyCode::Tab => {
                // Switch focus to shelf.
                self.focus = FocusedPanel::Shelf;
            }
            KeyCode::Esc => {
                self.input.clear();
                self.cursor = 0;
            }
            _ => {}
        }
    }

    /// Handle a key press when the shelf panel has focus.
    pub fn handle_shelf_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Tab | KeyCode::Esc => {
                self.focus = FocusedPanel::Chat;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.shelf_selected > 0 {
                    self.shelf_selected -= 1;
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.shelf_selected + 1 < self.shelf.len() {
                    self.shelf_selected += 1;
                }
            }
            KeyCode::Char('a') => {
                // Apply selected shelf entry.
                if let Some(entry) = self.shelf.get(self.shelf_selected) {
                    let task_id = entry.task_id.clone();
                    let _ = self.cmd_tx.try_send(SessionCommand::Apply { task_id: task_id.clone() });
                    self.push_message(ChatMessage::info(format!("Applying worktree for {task_id}...")));
                }
            }
            KeyCode::Char('d') => {
                // Discard selected shelf entry.
                if let Some(entry) = self.shelf.get(self.shelf_selected) {
                    let task_id = entry.task_id.clone();
                    let _ = self.cmd_tx.try_send(SessionCommand::Discard { task_id: task_id.clone() });
                    self.push_message(ChatMessage::info(format!("Discarding worktree for {task_id}...")));
                }
            }
            _ => {}
        }
    }

    /// Handle a global key press (regardless of focus).
    pub fn handle_global_key(&mut self, key: crossterm::event::KeyEvent) -> bool {
        use crossterm::event::{KeyCode, KeyModifiers};
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.should_quit = true;
                true
            }
            KeyCode::Char('q') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.should_quit = true;
                true
            }
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

    /// Process all pending session events (non-blocking).
    pub fn drain_session_events(&mut self) {
        while let Ok(event) = self.event_rx.try_recv() {
            self.handle_session_event(event);
        }
    }

    fn handle_session_event(&mut self, event: SessionEvent) {
        match event {
            SessionEvent::TaskStarted { task_id, prompt_summary } => {
                self.push_message(ChatMessage::info(format!(
                    "[{}] Task started: {}", task_id, prompt_summary
                )));
                self.shelf.push_front(ShelfEntry {
                    task_id: task_id.clone(),
                    provider: self.provider_id.clone(),
                    prompt_summary,
                    state_label: "running".to_string(),
                    state_color: ShelfColor::Running,
                    started_at: Local::now(),
                });
                while self.shelf.len() > MAX_SHELF_ENTRIES {
                    self.shelf.pop_back();
                }
            }
            SessionEvent::TaskProgress { task_id, event } => {
                use bakudo_daemon::task_runner::RunnerEvent;
                match event {
                    RunnerEvent::RawLine(line) => {
                        if !line.trim().is_empty() {
                            self.push_message(ChatMessage::agent(line));
                        }
                    }
                    RunnerEvent::Progress(p) => {
                        self.push_message(ChatMessage::agent(format!(
                            "[{}] {}", task_id, p.message
                        )));
                    }
                    RunnerEvent::InfraError(e) => {
                        self.push_message(ChatMessage::error(format!(
                            "[{}] Infrastructure error: {}", task_id, e
                        )));
                    }
                    RunnerEvent::Finished(result) => {
                        self.push_message(ChatMessage::agent(format!(
                            "[{}] Finished ({:?}) in {}ms",
                            task_id, result.status, result.duration_ms
                        )));
                        self.update_shelf_state(&task_id, "preserved", ShelfColor::Preserved);
                    }
                }
            }
            SessionEvent::TaskFinished { task_id, action } => {
                let color = if action == "merged" {
                    ShelfColor::Merged
                } else if action == "discarded" {
                    ShelfColor::Discarded
                } else if action.starts_with("conflicts:") {
                    ShelfColor::Conflicts
                } else {
                    ShelfColor::Preserved
                };
                self.update_shelf_state(&task_id, &action, color);
                self.push_message(ChatMessage::info(format!(
                    "[{}] Worktree {}", task_id, action
                )));
            }
            SessionEvent::ProviderChanged { provider_id, model } => {
                self.provider_id = provider_id.clone();
                self.model = model.clone();
                self.push_message(ChatMessage::info(format!(
                    "Provider set to '{}' (model: {})",
                    provider_id,
                    if model.is_empty() { "default".to_string() } else { model }
                )));
            }
            SessionEvent::Error(e) => {
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
                break;
            }
        }
    }

    fn submit_input(&mut self) {
        let input = self.input.trim().to_string();
        if input.is_empty() {
            return;
        }
        self.input.clear();
        self.cursor = 0;

        if let Some(cmd) = parse_slash(&input) {
            self.push_message(ChatMessage::user(input.clone()));
            self.handle_slash_command(cmd);
        } else {
            self.push_message(ChatMessage::user(input.clone()));
            let _ = self.cmd_tx.try_send(SessionCommand::Dispatch { prompt: input });
        }
    }

    fn handle_slash_command(&mut self, cmd: SlashCommand) {
        match cmd {
            SlashCommand::SetProvider(id) => {
                if self.registry.get(&id).is_none() {
                    self.push_message(ChatMessage::error(format!("Unknown provider '{id}'")));
                } else {
                    let _ = self.cmd_tx.try_send(SessionCommand::SetProvider { provider_id: id });
                }
            }
            SlashCommand::SetModel(model) => {
                let _ = self.cmd_tx.try_send(SessionCommand::SetModel { model });
            }
            SlashCommand::ListProviders => {
                let ids = self.registry.list_ids();
                let mut lines = vec!["Registered providers:".to_string()];
                for id in ids {
                    let spec = self.registry.get(id).unwrap();
                    let marker = if id == self.provider_id { " (active)" } else { "" };
                    lines.push(format!("  {} — {}{}", id, spec.display_name, marker));
                }
                self.push_message(ChatMessage::info(lines.join("\n")));
            }
            SlashCommand::Apply(task_id) => {
                let _ = self.cmd_tx.try_send(SessionCommand::Apply { task_id: task_id.clone() });
                self.push_message(ChatMessage::info(format!("Applying worktree for {task_id}...")));
            }
            SlashCommand::Discard(task_id) => {
                let _ = self.cmd_tx.try_send(SessionCommand::Discard { task_id: task_id.clone() });
                self.push_message(ChatMessage::info(format!("Discarding worktree for {task_id}...")));
            }
            SlashCommand::ListSandboxes => {
                if self.shelf.is_empty() {
                    self.push_message(ChatMessage::info("No sandboxes in this session."));
                } else {
                    let mut lines = vec!["Active sandboxes:".to_string()];
                    for entry in &self.shelf {
                        lines.push(format!(
                            "  {} [{}] {} — {}",
                            entry.task_id, entry.state_label, entry.provider, entry.prompt_summary
                        ));
                    }
                    self.push_message(ChatMessage::info(lines.join("\n")));
                }
            }
            SlashCommand::ShowConfig => {
                let cfg = &self.config;
                let info = format!(
                    "Config:\n  provider: {}\n  model: {}\n  base_branch: {}\n  timeout: {}s\n  candidate_policy: {}\n  sandbox_lifecycle: {}",
                    self.provider_id,
                    if self.model.is_empty() { "default" } else { &self.model },
                    cfg.base_branch,
                    cfg.timeout_secs,
                    cfg.candidate_policy,
                    cfg.sandbox_lifecycle,
                );
                self.push_message(ChatMessage::info(info));
            }
            SlashCommand::Help => {
                self.push_message(ChatMessage::info(help_text().to_string()));
            }
            SlashCommand::Quit => {
                self.should_quit = true;
                let _ = self.cmd_tx.try_send(SessionCommand::Shutdown);
            }
            SlashCommand::Unknown(msg) => {
                self.push_message(ChatMessage::error(msg));
            }
        }
    }

    fn prev_char_boundary(&self) -> usize {
        let mut i = self.cursor - 1;
        while !self.input.is_char_boundary(i) { i -= 1; }
        i
    }

    fn next_char_boundary(&self) -> usize {
        let mut i = self.cursor + 1;
        while i <= self.input.len() && !self.input.is_char_boundary(i) { i += 1; }
        i
    }
}
