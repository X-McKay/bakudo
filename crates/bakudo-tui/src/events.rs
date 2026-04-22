//! Terminal event polling.
//!
//! Wraps crossterm's event stream with:
//!   - Bracketed paste support (multi-char paste arrives as a single event).
//!   - Focus-change events so we can dim unfocused panels.
//!   - Key-repeat handling: `Press` and `Repeat` kinds are both treated as
//!     key events (matching Codex's `is_press()` helper).
//!   - A `Tick` event emitted when the poll timeout expires, used to advance
//!     spinner animations and scheduled redraws.

use crossterm::event::{self, Event, KeyEvent, KeyEventKind};
use std::time::Duration;

/// Normalised terminal events produced by [`poll_event`].
#[derive(Debug, Clone)]
pub enum TermEvent {
    /// A key press (or held-key repeat).
    Key(KeyEvent),
    /// A bracketed-paste payload.
    Paste(String),
    /// Terminal gained focus.
    FocusGained,
    /// Terminal lost focus.
    FocusLost,
    /// Terminal was resized.
    Resize(u16, u16),
    /// Poll timeout elapsed — used to drive spinner animation ticks.
    Tick,
}

/// Poll for the next terminal event, waiting up to `timeout`.
///
/// Returns `Ok(None)` when an event type we deliberately ignore is received
/// (e.g. mouse events when mouse capture is disabled, or key-release events).
pub fn poll_event(timeout: Duration) -> anyhow::Result<Option<TermEvent>> {
    if !event::poll(timeout)? {
        return Ok(Some(TermEvent::Tick));
    }

    match event::read()? {
        Event::Key(k) => {
            // Accept both Press and Repeat (held key); ignore Release.
            if is_press(&k) {
                Ok(Some(TermEvent::Key(k)))
            } else {
                Ok(None)
            }
        }
        Event::Paste(text) => Ok(Some(TermEvent::Paste(text))),
        Event::FocusGained => Ok(Some(TermEvent::FocusGained)),
        Event::FocusLost => Ok(Some(TermEvent::FocusLost)),
        Event::Resize(w, h) => Ok(Some(TermEvent::Resize(w, h))),
        Event::Mouse(_) => Ok(None), // mouse capture not enabled
    }
}

/// Returns true if the key event represents an actionable press (Press or Repeat).
///
/// Mirrors Codex's `KeyBinding::is_press()` helper.
#[inline]
pub fn is_press(k: &KeyEvent) -> bool {
    matches!(k.kind, KeyEventKind::Press | KeyEventKind::Repeat)
}
