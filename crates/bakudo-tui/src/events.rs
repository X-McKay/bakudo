//! Terminal input event handling.

use crossterm::event::{self, Event, KeyEvent};
use std::time::Duration;

/// Polled terminal events, abstracted over crossterm.
#[derive(Debug, Clone)]
pub enum TermEvent {
    Key(KeyEvent),
    Resize(u16, u16),
    Tick,
}

/// Poll for the next terminal event with a timeout.
pub fn poll_event(timeout: Duration) -> anyhow::Result<Option<TermEvent>> {
    if event::poll(timeout)? {
        match event::read()? {
            Event::Key(k) => Ok(Some(TermEvent::Key(k))),
            Event::Resize(w, h) => Ok(Some(TermEvent::Resize(w, h))),
            _ => Ok(None),
        }
    } else {
        Ok(Some(TermEvent::Tick))
    }
}
