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
use std::time::Instant;

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use bakudo_core::config::BakudoConfig;
use bakudo_core::mission::Posture;
use bakudo_core::protocol::{WorkerProgressKind, WorkerStatus};
use bakudo_core::provider::ProviderRegistry;
use bakudo_core::state::{SandboxLedger, SandboxRecord, SandboxState};
use bakudo_daemon::session_controller::{MissionBanner, SessionCommand, SessionEvent};

use crate::commands::{ParsedCommand, SlashCommand, completions_for, parse_slash};
use crate::transcript_store::TranscriptStore;

/// Maximum number of chat messages to keep in the transcript ring buffer.
const MAX_TRANSCRIPT_LINES: usize = 2000;

/// Maximum number of sandbox shelf entries to show.
const MAX_SHELF_ENTRIES: usize = 50;

// ─── Chat message ──────────────────────────────────────────────────────────

/// A single message in the chat transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
    pub timestamp: DateTime<Local>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MessageRole {
    User,
    System,
    Mission,
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
    pub fn mission(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Mission,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalAction {
    Edit,
    Approve,
    Deny,
}

impl ApprovalAction {
    pub const ALL: [Self; 3] = [Self::Edit, Self::Approve, Self::Deny];

    pub fn label(&self) -> &'static str {
        match self {
            Self::Edit => "Edit command",
            Self::Approve => "Approve",
            Self::Deny => "Deny",
        }
    }

    pub fn detail(&self) -> &'static str {
        match self {
            Self::Edit => "review or amend before approving",
            Self::Approve => "run the command as shown",
            Self::Deny => "deny this host action",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApprovalPrompt {
    pub request_id: String,
    pub command: String,
    pub reason: String,
    pub selected_action: ApprovalAction,
    pub selection_touched: bool,
    pub editing: bool,
    pub edited_command: String,
    pub cursor: usize,
}

#[derive(Debug, Clone)]
pub struct UserQuestionPrompt {
    pub request_id: String,
    pub question: String,
    pub choices: Vec<String>,
    pub selected: usize,
    pub selection_touched: bool,
}

#[derive(Debug, Clone)]
pub struct SlashCommandPopup {
    pub items: Vec<&'static str>,
    pub selected: usize,
}

#[derive(Debug, Clone)]
pub enum PopupState {
    SlashCommands(SlashCommandPopup),
    Approval(ApprovalPrompt),
    UserQuestion(UserQuestionPrompt),
}

#[derive(Debug, Clone)]
pub enum PendingRuntimeWorkKind {
    RoutingInput,
    StartingMission,
    UpdatingBudget,
    ForcingWake,
}

#[derive(Debug, Clone)]
pub struct PendingRuntimeWork {
    pub kind: PendingRuntimeWorkKind,
    pub summary: String,
    pub started_at: Instant,
}

impl PendingRuntimeWork {
    pub fn new(kind: PendingRuntimeWorkKind, summary: impl Into<String>) -> Self {
        Self {
            kind,
            summary: summary.into(),
            started_at: Instant::now(),
        }
    }

    pub fn label(&self) -> &'static str {
        "Working"
    }

    pub fn detail(&self) -> &'static str {
        match self.kind {
            PendingRuntimeWorkKind::RoutingInput => "routing request",
            PendingRuntimeWorkKind::StartingMission => "starting mission",
            PendingRuntimeWorkKind::UpdatingBudget => "updating budget",
            PendingRuntimeWorkKind::ForcingWake => "queueing wake",
        }
    }

    pub fn elapsed_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }
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
    /// Transcript messages not yet emitted into terminal scrollback.
    pub pending_history: VecDeque<ChatMessage>,

    /// Current text in the composer input.
    pub input: String,
    /// Cursor position within `input` (byte offset).
    pub cursor: usize,

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
    /// Active durable mission banner, when one exists.
    pub mission_banner: Option<MissionBanner>,
    /// Local optimistic state for runtime work that has been queued but not yet
    /// acknowledged by the daemon/session runtime.
    pub pending_runtime_work: Option<PendingRuntimeWork>,

    /// Number of tasks currently in-flight (used to gate commands).
    pub active_task_count: usize,
    /// Spinner tick counter, incremented every Tick event.
    pub tick: u64,

    /// Active popup surface for slash completion or blocking runtime prompts.
    pub popup: Option<PopupState>,

    /// Whether the `/help` overlay is currently showing.
    pub help_visible: bool,
    /// Line scroll offset inside the help overlay.
    pub help_scroll: usize,

    /// Whether the app should exit.
    pub should_quit: bool,

    /// Channel to send commands to the session controller.
    cmd_tx: mpsc::Sender<SessionCommand>,
    /// Channel to receive events from the session controller.
    event_rx: mpsc::Receiver<SessionEvent>,
    /// Optional on-disk transcript event log for session resume.
    transcript_store: Option<TranscriptStore>,
}

impl App {
    pub fn new(
        config: Arc<BakudoConfig>,
        registry: Arc<ProviderRegistry>,
        ledger: Arc<SandboxLedger>,
        cmd_tx: mpsc::Sender<SessionCommand>,
        event_rx: mpsc::Receiver<SessionEvent>,
        transcript_store: Option<TranscriptStore>,
        show_welcome: bool,
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
            pending_history: VecDeque::new(),
            input: String::new(),
            cursor: 0,
            shelf: VecDeque::new(),
            shelf_selected: 0,
            focus: FocusedPanel::Chat,
            terminal_focused: true,
            provider_id,
            model,
            mission_banner: None,
            pending_runtime_work: None,
            active_task_count: 0,
            tick: 0,
            popup: None,
            help_visible: false,
            help_scroll: 0,
            should_quit: false,
            cmd_tx,
            event_rx,
            transcript_store,
        };
        if show_welcome {
            app.push_message(ChatMessage::system(
                "Welcome to Bakudo v2.\n\
                 Describe an objective, ask for progress, or steer the current mission in plain language.\n\
                 Bakudo routes clear objectives directly into the mission runtime and shows plan and worker activity as it happens.\n\
                 Type /help for available commands, or /status to see the local session summary.",
            ));
        }
        app
    }

    // ── Transcript ─────────────────────────────────────────────────────────

    /// Push a message to the transcript, trimming if over limit, and queue it
    /// for inline scrollback emission.
    pub fn push_message(&mut self, msg: ChatMessage) {
        if let Some(store) = &self.transcript_store {
            let _ = store.append(&msg);
        }
        self.pending_history.push_back(msg.clone());
        self.transcript.push_back(msg);
        while self.transcript.len() > MAX_TRANSCRIPT_LINES {
            self.transcript.pop_front();
        }
    }

    pub fn load_transcript(&mut self) {
        let Some(store) = &self.transcript_store else {
            return;
        };
        let Ok(messages) = store.load() else {
            return;
        };
        if messages.is_empty() {
            return;
        }
        self.pending_history = messages.clone();
        self.transcript = messages.into_iter().collect();
    }

    pub fn take_pending_history(&mut self) -> Vec<ChatMessage> {
        self.pending_history.drain(..).collect()
    }

    pub fn begin_pending_runtime_work(
        &mut self,
        kind: PendingRuntimeWorkKind,
        summary: impl Into<String>,
    ) {
        self.pending_runtime_work = Some(PendingRuntimeWork::new(kind, summary));
    }

    pub fn clear_pending_runtime_work(&mut self) {
        self.pending_runtime_work = None;
    }

    fn clear_transcript_buffer(&mut self) {
        self.transcript.clear();
        self.pending_history.clear();
        if let Some(store) = &self.transcript_store {
            let _ = store.clear();
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
        // Ctrl+C / Ctrl+Q always quits, even with the help modal open.
        if ctrl && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('q')) {
            self.should_quit = true;
            let _ = self.cmd_tx.try_send(SessionCommand::Shutdown);
            return true;
        }
        if self.handle_modal_popup_key(key) {
            return true;
        }
        // The help overlay consumes all other keys while it's visible.
        if self.help_visible {
            self.handle_help_key(key);
            return true;
        }
        false
    }

    fn handle_modal_popup_key(&mut self, key: crossterm::event::KeyEvent) -> bool {
        match self.popup.as_ref() {
            Some(PopupState::Approval(_)) => {
                self.handle_approval_key(key);
                true
            }
            Some(PopupState::UserQuestion(_)) => {
                self.handle_question_key(key);
                true
            }
            _ => false,
        }
    }

    /// Dispatch a key press while the `/help` overlay is visible.
    fn handle_help_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') | KeyCode::Char('?') => {
                self.help_visible = false;
                self.help_scroll = 0;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.help_scroll = self.help_scroll.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.help_scroll = self.help_scroll.saturating_add(1);
            }
            KeyCode::PageUp => {
                self.help_scroll = self.help_scroll.saturating_sub(5);
            }
            KeyCode::PageDown => {
                self.help_scroll = self.help_scroll.saturating_add(5);
            }
            KeyCode::Home => {
                self.help_scroll = 0;
            }
            _ => {}
        }
    }

    fn handle_approval_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        #[derive(Debug)]
        enum Outcome {
            None,
            Approve {
                request_id: String,
                edited_command: Option<String>,
                message_command: String,
            },
            Deny {
                request_id: String,
                message_command: String,
            },
        }

        let Some(PopupState::Approval(prompt)) = self.popup.as_mut() else {
            return;
        };
        let outcome = if prompt.editing {
            match key.code {
                KeyCode::Esc => {
                    prompt.editing = false;
                    prompt.edited_command = prompt.command.clone();
                    prompt.cursor = prompt.edited_command.len();
                    Outcome::None
                }
                KeyCode::Enter => Outcome::Approve {
                    request_id: prompt.request_id.clone(),
                    edited_command: Some(prompt.edited_command.clone()),
                    message_command: prompt.edited_command.clone(),
                },
                KeyCode::Backspace if prompt.cursor > 0 => {
                    let prev = prompt.cursor - 1;
                    prompt.edited_command.drain(prev..prompt.cursor);
                    prompt.cursor = prev;
                    Outcome::None
                }
                KeyCode::Left if prompt.cursor > 0 => {
                    prompt.cursor -= 1;
                    Outcome::None
                }
                KeyCode::Right if prompt.cursor < prompt.edited_command.len() => {
                    prompt.cursor += 1;
                    Outcome::None
                }
                KeyCode::Char(ch) => {
                    prompt.edited_command.insert(prompt.cursor, ch);
                    prompt.cursor += 1;
                    Outcome::None
                }
                _ => Outcome::None,
            }
        } else {
            match key.code {
                KeyCode::Up | KeyCode::Left => {
                    prompt.selected_action = step_approval_action(prompt.selected_action, -1);
                    prompt.selection_touched = true;
                    Outcome::None
                }
                KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                    prompt.selected_action = step_approval_action(prompt.selected_action, 1);
                    prompt.selection_touched = true;
                    Outcome::None
                }
                KeyCode::Enter if prompt.selection_touched => match prompt.selected_action {
                    ApprovalAction::Edit => {
                        prompt.editing = true;
                        prompt.edited_command = prompt.command.clone();
                        prompt.cursor = prompt.edited_command.len();
                        Outcome::None
                    }
                    ApprovalAction::Approve => Outcome::Approve {
                        request_id: prompt.request_id.clone(),
                        edited_command: None,
                        message_command: prompt.command.clone(),
                    },
                    ApprovalAction::Deny => Outcome::Deny {
                        request_id: prompt.request_id.clone(),
                        message_command: prompt.command.clone(),
                    },
                },
                KeyCode::Char('a') => Outcome::Approve {
                    request_id: prompt.request_id.clone(),
                    edited_command: None,
                    message_command: prompt.command.clone(),
                },
                KeyCode::Char('d') | KeyCode::Esc => Outcome::Deny {
                    request_id: prompt.request_id.clone(),
                    message_command: prompt.command.clone(),
                },
                KeyCode::Char('e') => {
                    prompt.editing = true;
                    prompt.edited_command = prompt.command.clone();
                    prompt.cursor = prompt.edited_command.len();
                    Outcome::None
                }
                _ => Outcome::None,
            }
        };

        match outcome {
            Outcome::None => {}
            Outcome::Approve {
                request_id,
                edited_command,
                message_command,
            } => {
                let _ = self.cmd_tx.try_send(SessionCommand::ResolveHostApproval {
                    request_id,
                    approved: true,
                    edited_command,
                });
                self.popup = None;
                self.push_message(ChatMessage::info(format!(
                    "Approved host command: {}",
                    message_command
                )));
            }
            Outcome::Deny {
                request_id,
                message_command,
            } => {
                let _ = self.cmd_tx.try_send(SessionCommand::ResolveHostApproval {
                    request_id,
                    approved: false,
                    edited_command: None,
                });
                self.popup = None;
                self.push_message(ChatMessage::info(format!(
                    "Denied host command: {}",
                    message_command
                )));
            }
        }
    }

    fn handle_question_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::KeyCode;

        #[derive(Debug)]
        enum Outcome {
            None,
            Answer { request_id: String, answer: String },
        }

        let Some(PopupState::UserQuestion(prompt)) = self.popup.as_mut() else {
            return;
        };
        let outcome = match key.code {
            KeyCode::Up | KeyCode::Left => {
                prompt.selected = step_selection(prompt.selected, prompt.choices.len(), -1);
                prompt.selection_touched = true;
                Outcome::None
            }
            KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                prompt.selected = step_selection(prompt.selected, prompt.choices.len(), 1);
                prompt.selection_touched = true;
                Outcome::None
            }
            KeyCode::Char(ch) if ch.is_ascii_digit() => {
                let idx = ch.to_digit(10).unwrap_or(0) as usize;
                if idx > 0 && idx <= prompt.choices.len() {
                    prompt.selected = idx - 1;
                    prompt.selection_touched = true;
                }
                Outcome::None
            }
            KeyCode::Enter if prompt.selection_touched => {
                let answer = prompt
                    .choices
                    .get(prompt.selected)
                    .cloned()
                    .unwrap_or_default();
                Outcome::Answer {
                    request_id: prompt.request_id.clone(),
                    answer,
                }
            }
            KeyCode::Esc => Outcome::None,
            _ => Outcome::None,
        };

        if let Outcome::Answer { request_id, answer } = outcome {
            let _ = self.cmd_tx.try_send(SessionCommand::AnswerUserQuestion {
                request_id,
                answer: answer.clone(),
            });
            self.push_message(ChatMessage::info(format!("Submitted answer: {}", answer)));
            self.popup = None;
        }
    }

    // ── Composer key handler ───────────────────────────────────────────────

    /// Handle a key press when the composer (chat input) has focus.
    pub fn handle_input_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        if self.handle_slash_popup_key(key) {
            return;
        }

        match key.code {
            // ── Submit / insert newline ──────────────────────────────────
            // Shift+Enter or Alt+Enter inserts a '\n' so multi-line prompts
            // can be composed without submitting. Plain Enter submits.
            KeyCode::Enter => {
                if key.modifiers.contains(KeyModifiers::SHIFT)
                    || key.modifiers.contains(KeyModifiers::ALT)
                {
                    self.input.insert(self.cursor, '\n');
                    self.cursor += 1;
                    self.clear_completions();
                } else {
                    self.clear_completions();
                    self.submit_input();
                }
            }

            // ── Tab — slash-command autocomplete ─────────────────────────
            KeyCode::Tab => {
                if self.input.starts_with('/') {
                    self.cycle_completion(1);
                } else {
                    // Tab with no slash prefix: switch focus to shelf.
                    self.focus = FocusedPanel::Shelf;
                }
            }

            // ── Escape — clear input or dismiss completions ───────────────
            KeyCode::Esc => {
                if self.has_slash_popup() {
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

            // ── Up / Down — move between rows of multi-line input ─────────
            KeyCode::Up => {
                self.move_cursor_line(-1);
            }
            KeyCode::Down => {
                self.move_cursor_line(1);
            }

            _ => {}
        }
    }

    fn handle_slash_popup_key(&mut self, key: crossterm::event::KeyEvent) -> bool {
        use crossterm::event::KeyCode;

        if !self.input.starts_with('/') && !self.has_slash_popup() {
            return false;
        }

        match key.code {
            KeyCode::Tab if self.input.starts_with('/') => {
                self.cycle_completion(1);
                true
            }
            KeyCode::Down if self.has_slash_popup() => {
                self.cycle_completion(1);
                true
            }
            KeyCode::Up if self.has_slash_popup() => {
                self.cycle_completion(-1);
                true
            }
            KeyCode::Enter
                if self.has_slash_popup()
                    && self.input.starts_with('/')
                    && !self.input[1..].contains(' ') =>
            {
                self.apply_selected_completion();
                true
            }
            KeyCode::Esc if self.has_slash_popup() => {
                self.clear_completions();
                true
            }
            _ => false,
        }
    }

    /// Move the cursor up (`delta = -1`) or down (`delta = 1`) one row in the
    /// composer, preserving the byte column when possible. No-op when already
    /// at the top/bottom row.
    fn move_cursor_line(&mut self, delta: i32) {
        if !self.input.contains('\n') {
            return;
        }
        let (row, row_start) = locate_cursor_row(&self.input, self.cursor);
        let col = self.cursor - row_start;
        let lines: Vec<&str> = self.input.split('\n').collect();
        let new_row_i = row as i32 + delta;
        if new_row_i < 0 || new_row_i as usize >= lines.len() {
            return;
        }
        let new_row = new_row_i as usize;
        let mut start = 0usize;
        for (i, line) in lines.iter().enumerate() {
            if i == new_row {
                break;
            }
            start += line.len() + 1;
        }
        self.cursor = start + col.min(lines[new_row].len());
    }

    /// Insert a pasted string at the cursor position.
    ///
    /// Newlines are preserved so multi-paragraph prompts paste in cleanly
    /// (Enter still submits; Shift+Enter inserts a newline interactively).
    /// Carriage returns and other control characters are stripped.
    pub fn handle_paste(&mut self, text: String) {
        let sanitised: String = text
            .chars()
            .filter(|c| *c == '\n' || !c.is_control())
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
                self.clear_pending_runtime_work();
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
                self.clear_pending_runtime_work();
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
                self.clear_pending_runtime_work();
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
                self.clear_pending_runtime_work();
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
            SessionEvent::MissionUpdated { banner } => {
                self.clear_pending_runtime_work();
                self.mission_banner = banner;
            }
            SessionEvent::ApprovalRequested {
                request_id,
                command,
                reason,
            } => {
                self.clear_pending_runtime_work();
                self.popup = Some(PopupState::Approval(ApprovalPrompt {
                    request_id,
                    cursor: command.len(),
                    edited_command: command.clone(),
                    command,
                    reason,
                    selected_action: ApprovalAction::Edit,
                    selection_touched: false,
                    editing: false,
                }));
            }
            SessionEvent::UserQuestionRequested {
                request_id,
                question,
                choices,
            } => {
                self.clear_pending_runtime_work();
                self.popup = Some(PopupState::UserQuestion(UserQuestionPrompt {
                    request_id,
                    question,
                    selected: 0,
                    selection_touched: false,
                    choices,
                }));
            }
            SessionEvent::MissionActivity { activity } => {
                self.clear_pending_runtime_work();
                self.push_message(ChatMessage::mission(activity.render_text()));
            }
            SessionEvent::Info(message) => {
                self.clear_pending_runtime_work();
                self.push_message(ChatMessage::info(message));
            }
            SessionEvent::Error(e) => {
                self.clear_pending_runtime_work();
                self.clear_all_pending();
                self.push_message(ChatMessage::error(e));
            }
            SessionEvent::Shutdown => {
                self.clear_pending_runtime_work();
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
                    let summary = truncate_line(input.clone(), 80);
                    if self
                        .cmd_tx
                        .try_send(SessionCommand::HostInput { text: input })
                        .is_ok()
                    {
                        self.begin_pending_runtime_work(
                            PendingRuntimeWorkKind::RoutingInput,
                            summary,
                        );
                    }
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
            SlashCommand::Mission => self.cmd_start_mission(Posture::Mission, arg),
            SlashCommand::Explore => self.cmd_start_mission(Posture::Explore, arg),
            SlashCommand::Missions => self.cmd_missions(),
            SlashCommand::Focus => self.cmd_focus(arg),
            SlashCommand::Budget => self.cmd_budget(arg),
            SlashCommand::Wake => self.cmd_wake(),
            SlashCommand::Lessons => self.cmd_lessons(),
            SlashCommand::Provider => self.cmd_provider(arg),
            SlashCommand::Approve => self.cmd_approve(),
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
                self.help_visible = true;
                self.help_scroll = 0;
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

    fn cmd_approve(&mut self) {
        let _ = self.cmd_tx.try_send(SessionCommand::ApproveExecution);
        self.push_message(ChatMessage::info(
            "The next provider execution is approved under the current execution policy.",
        ));
    }

    fn cmd_start_mission(&mut self, posture: Posture, goal: String) {
        let trimmed = goal.trim();
        if trimmed.is_empty() {
            self.push_message(ChatMessage::error("Mission goal must not be empty."));
            return;
        }
        let _ = self.cmd_tx.try_send(SessionCommand::StartMission {
            posture,
            goal: trimmed.to_string(),
            done_contract: None,
            constraints: None,
        });
        self.begin_pending_runtime_work(
            PendingRuntimeWorkKind::StartingMission,
            truncate_line(trimmed.to_string(), 80),
        );
        self.push_message(ChatMessage::info(format!(
            "Starting {} mission: {}",
            posture, trimmed
        )));
    }

    fn cmd_budget(&mut self, arg: String) {
        let mut wall_clock_minutes = None;
        let mut workers = None;
        for token in arg.split_whitespace() {
            if let Some(value) = token.strip_prefix("time=") {
                wall_clock_minutes = parse_budget_minutes(value);
            } else if let Some(value) = token.strip_prefix("workers=") {
                workers = value.parse::<u32>().ok();
            }
        }
        if wall_clock_minutes.is_none() && workers.is_none() {
            self.push_message(ChatMessage::error(
                "Usage: /budget time=<minutes>m workers=<count>",
            ));
            return;
        }
        if self
            .cmd_tx
            .try_send(SessionCommand::SetMissionBudget {
                wall_clock_minutes,
                workers,
            })
            .is_ok()
        {
            self.begin_pending_runtime_work(PendingRuntimeWorkKind::UpdatingBudget, arg);
        }
        self.push_message(ChatMessage::info("Updating mission wallet…"));
    }

    fn cmd_missions(&mut self) {
        let _ = self.cmd_tx.try_send(SessionCommand::ShowMissions);
    }

    fn cmd_focus(&mut self, arg: String) {
        let selector = arg.trim();
        if selector.is_empty() {
            self.push_message(ChatMessage::error("Usage: /focus <number-or-id-prefix>"));
            return;
        }
        let _ = self.cmd_tx.try_send(SessionCommand::FocusMission {
            selector: selector.to_string(),
        });
    }

    fn cmd_wake(&mut self) {
        if self.cmd_tx.try_send(SessionCommand::ForceWake).is_ok() {
            self.begin_pending_runtime_work(PendingRuntimeWorkKind::ForcingWake, "manual wake");
        }
        self.push_message(ChatMessage::info("Forcing a manual wake…"));
    }

    fn cmd_lessons(&mut self) {
        let path = std::env::current_dir()
            .ok()
            .unwrap_or_default()
            .join(".bakudo")
            .join("lessons");
        self.push_message(ChatMessage::info(format!(
            "Lessons directory: {}",
            path.display()
        )));
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
        self.clear_transcript_buffer();
        self.shelf.clear();
        self.shelf_selected = 0;
        self.push_message(ChatMessage::system(
            "Local history and shelf view cleared. Existing terminal scrollback remains, and \
             running tasks continue in the background.",
        ));
    }

    fn cmd_clear(&mut self) {
        self.clear_transcript_buffer();
        self.push_message(ChatMessage::system(
            "Local history cleared. Existing terminal scrollback remains above the prompt.",
        ));
    }

    fn cmd_config(&mut self) {
        let cfg = &self.config;
        let info = format!(
            "Configuration:\n  provider:          {}\n  model:             {}\n  base_branch:       {}\n  timeout:           {}s\n  candidate_policy:  {}\n  sandbox_lifecycle: {}\n  exec_policy:       {:?}\n  post_run_hook:     {}",
            self.provider_id,
            self.model_label(),
            cfg.base_branch,
            cfg.timeout_secs,
            cfg.candidate_policy,
            cfg.sandbox_lifecycle,
            cfg.execution_policy.default_decision,
            if cfg.post_run_hook.is_some() {
                "configured"
            } else {
                "none"
            },
        );
        self.push_message(ChatMessage::info(info));
    }

    fn cmd_status(&mut self) {
        let mut lines = vec![format!(
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
        )];
        if let Some(banner) = &self.mission_banner {
            let wake_summary = crate::status_indicator::mission_wake_summary(banner)
                .unwrap_or_else(|| "no wake queued".to_string());
            let blockers = crate::status_indicator::mission_blocked_reason(banner)
                .unwrap_or_else(|| "none".to_string());
            lines.push(format!(
                "  mission:        {} [{} / {:?} / {:?}]\n  wallet:         {}s left, {} workers remaining, {} in flight, max {}\n  mission inbox:  {} pending message(s), {} pending question(s)",
                banner.goal,
                banner.mission_id,
                banner.posture,
                banner.status,
                banner.wall_clock_remaining_secs,
                banner.abox_workers_remaining,
                banner.abox_workers_in_flight,
                banner.concurrent_max,
                banner.pending_user_messages,
                banner.pending_questions,
            ));
            lines.push(format!(
                "  wake:           {wake_summary}\n  blockers:       {blockers}\n  next action:    {}",
                crate::status_indicator::mission_next_action(banner)
            ));
            if let Some(wave_summary) = crate::status_indicator::mission_wave_summary(banner) {
                lines.push(format!("  active wave:    {wave_summary}"));
            }
            if let Some(issue) = banner.latest_issue.as_deref() {
                lines.push(format!("  latest issue:   {issue}"));
            }
            if let Some(change) = banner.latest_change.as_deref() {
                lines.push(format!("  latest change:  {change}"));
            }
        }
        let info = lines.join("\n");
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
        if matches!(
            self.popup,
            Some(PopupState::Approval(_) | PopupState::UserQuestion(_))
        ) {
            return;
        }
        if self.input.starts_with('/') {
            let prefix = &self.input[1..];
            // Only show completions if there's no space yet (still typing the command).
            if !prefix.contains(' ') {
                let items = completions_for(prefix);
                if items.is_empty() {
                    self.clear_completions();
                    return;
                }
                let selected = match self.popup.as_ref() {
                    Some(PopupState::SlashCommands(popup)) => popup
                        .items
                        .get(popup.selected)
                        .and_then(|current| items.iter().position(|item| item == current))
                        .unwrap_or(0),
                    _ => 0,
                };
                self.popup = Some(PopupState::SlashCommands(SlashCommandPopup {
                    items,
                    selected,
                }));
                return;
            }
        }
        self.clear_completions();
    }

    fn cycle_completion(&mut self, step: isize) {
        if !self.has_slash_popup() {
            // Trigger completions for current input.
            self.update_completions();
        }
        if !self.has_slash_popup() {
            return;
        }
        let advance_first = self.input.starts_with('/') && self.input[1..].contains(' ');
        let Some(PopupState::SlashCommands(popup)) = self.popup.as_mut() else {
            return;
        };
        let len = popup.items.len();
        if len == 0 {
            return;
        }
        if advance_first || step.is_negative() {
            popup.selected = step_selection(popup.selected, len, step);
        }
        let candidate = popup.items[popup.selected];
        self.input = format!("/{candidate} ");
        self.cursor = self.input.len();
    }

    fn clear_completions(&mut self) {
        if self.has_slash_popup() {
            self.popup = None;
        }
    }

    fn has_slash_popup(&self) -> bool {
        matches!(self.popup, Some(PopupState::SlashCommands(_)))
    }

    fn apply_selected_completion(&mut self) {
        let Some(PopupState::SlashCommands(popup)) = self.popup.as_ref() else {
            return;
        };
        let Some(candidate) = popup.items.get(popup.selected) else {
            return;
        };
        self.input = format!("/{candidate} ");
        self.cursor = self.input.len();
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

    // Prefer a human-readable explanation when the stderr matches a known
    // infrastructure-error pattern; otherwise fall back to the raw tail.
    if let Some(explanation) = humanize_infra_error(&result.stderr) {
        out.push('\n');
        out.push_str("→ ");
        out.push_str(&explanation);
    } else {
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
    }

    out.push('\n');
    out.push_str("→ full logs at ~/.local/share/bakudo/bakudo.log");
    out
}

/// Recognise common abox/libgit2 failure fingerprints in `stderr` and return a
/// friendlier, actionable explanation. Returns `None` when nothing matches —
/// callers should fall back to showing the raw stderr tail.
fn humanize_infra_error(stderr: &str) -> Option<String> {
    // libgit2: `revspec 'main' not found; class=Reference (4); code=NotFound (-3)`
    if let Some(idx) = stderr.find("revspec '") {
        let rest = &stderr[idx + "revspec '".len()..];
        if let Some(end) = rest.find("' not found") {
            let branch = &rest[..end];
            return Some(format!(
                "Base branch '{branch}' not found in this repo. Create or check out '{branch}', \
                 or change `base_branch` in ~/.config/bakudo/config.toml."
            ));
        }
    }
    None
}

/// Locate the row (0-based) containing the byte offset `cursor` and the byte
/// offset where that row begins. Used by the multi-line composer for cursor
/// navigation.
fn locate_cursor_row(input: &str, cursor: usize) -> (usize, usize) {
    let mut row = 0usize;
    let mut start = 0usize;
    for (i, byte) in input.as_bytes().iter().enumerate() {
        if i >= cursor {
            break;
        }
        if *byte == b'\n' {
            row += 1;
            start = i + 1;
        }
    }
    (row, start)
}

fn step_selection(current: usize, len: usize, step: isize) -> usize {
    if len == 0 {
        return 0;
    }

    if step.is_negative() {
        current.checked_sub(1).unwrap_or(len - 1)
    } else {
        (current + 1) % len
    }
}

fn step_approval_action(current: ApprovalAction, step: isize) -> ApprovalAction {
    let idx = ApprovalAction::ALL
        .iter()
        .position(|action| *action == current)
        .unwrap_or(0);
    ApprovalAction::ALL[step_selection(idx, ApprovalAction::ALL.len(), step)]
}

/// Compact a `bakudo-attempt-<uuid>` id down to the first 8 chars of the UUID
/// for inline chat display.
pub fn short_task_id(task_id: &str) -> &str {
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

fn parse_budget_minutes(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if let Some(minutes) = trimmed.strip_suffix('m') {
        minutes.parse().ok()
    } else if let Some(hours) = trimmed.strip_suffix('h') {
        hours.parse::<u64>().ok().map(|hours| hours * 60)
    } else {
        trimmed.parse().ok()
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::mpsc;

    use bakudo_core::{config::BakudoConfig, provider::ProviderRegistry, state::SandboxLedger};

    use super::*;

    fn fresh_app() -> (App, mpsc::Receiver<SessionCommand>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        let (_event_tx, event_rx) = mpsc::channel(4);
        (
            App::new(
                Arc::new(BakudoConfig::default()),
                Arc::new(ProviderRegistry::with_defaults()),
                Arc::new(SandboxLedger::new()),
                cmd_tx,
                event_rx,
                None,
                true,
            ),
            cmd_rx,
        )
    }

    fn key(code: crossterm::event::KeyCode) -> crossterm::event::KeyEvent {
        crossterm::event::KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
    }

    #[test]
    fn humanize_revspec_not_found() {
        let stderr = "stderr: 1: revspec 'main' not found; class=Reference (4); code=NotFound (-3)";
        let got = humanize_infra_error(stderr).expect("should match");
        assert!(got.contains("Base branch 'main' not found"));
        assert!(got.contains("check out 'main'"));
        assert!(got.contains("base_branch"));
    }

    #[test]
    fn humanize_infra_error_returns_none_for_unknown() {
        assert!(humanize_infra_error("some unrelated error").is_none());
        assert!(humanize_infra_error("").is_none());
    }

    #[test]
    fn short_task_id_strips_prefix() {
        assert_eq!(
            short_task_id("bakudo-attempt-02bf30c1-40c8-4ac5"),
            "02bf30c1"
        );
        assert_eq!(short_task_id("plain"), "plain");
    }

    #[test]
    fn locate_cursor_row_finds_correct_row() {
        let input = "aaa\nbbb\nccc";
        assert_eq!(locate_cursor_row(input, 0), (0, 0));
        assert_eq!(locate_cursor_row(input, 2), (0, 0));
        // Cursor at the newline after "aaa" should still be on row 0.
        assert_eq!(locate_cursor_row(input, 3), (0, 0));
        // Cursor at start of "bbb".
        assert_eq!(locate_cursor_row(input, 4), (1, 4));
        assert_eq!(locate_cursor_row(input, 8), (2, 8));
    }

    #[test]
    fn question_popup_requires_explicit_selection_before_enter() {
        let (mut app, mut cmd_rx) = fresh_app();
        app.popup = Some(PopupState::UserQuestion(UserQuestionPrompt {
            request_id: "q-1".to_string(),
            question: "Pick one".to_string(),
            choices: vec!["first".to_string(), "second".to_string()],
            selected: 0,
            selection_touched: false,
        }));

        app.handle_global_key(key(crossterm::event::KeyCode::Enter));
        assert!(cmd_rx.try_recv().is_err());

        app.handle_global_key(key(crossterm::event::KeyCode::Down));
        app.handle_global_key(key(crossterm::event::KeyCode::Enter));

        match cmd_rx.try_recv() {
            Ok(SessionCommand::AnswerUserQuestion { request_id, answer }) => {
                assert_eq!(request_id, "q-1");
                assert_eq!(answer, "second");
            }
            other => panic!("expected AnswerUserQuestion, got {other:?}"),
        }
        assert!(app.popup.is_none());
    }

    #[test]
    fn approval_popup_uses_navigation_before_enter() {
        let (mut app, mut cmd_rx) = fresh_app();
        app.popup = Some(PopupState::Approval(ApprovalPrompt {
            request_id: "a-1".to_string(),
            command: "git status".to_string(),
            reason: "check repo state".to_string(),
            selected_action: ApprovalAction::Edit,
            selection_touched: false,
            editing: false,
            edited_command: "git status".to_string(),
            cursor: "git status".len(),
        }));

        app.handle_global_key(key(crossterm::event::KeyCode::Enter));
        assert!(cmd_rx.try_recv().is_err());

        app.handle_global_key(key(crossterm::event::KeyCode::Down));
        app.handle_global_key(key(crossterm::event::KeyCode::Enter));

        match cmd_rx.try_recv() {
            Ok(SessionCommand::ResolveHostApproval {
                request_id,
                approved,
                edited_command,
            }) => {
                assert_eq!(request_id, "a-1");
                assert!(approved);
                assert!(edited_command.is_none());
            }
            other => panic!("expected ResolveHostApproval, got {other:?}"),
        }
        assert!(app.popup.is_none());
    }
}
