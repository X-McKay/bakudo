//! Key hint formatter ported from `codex-rs/tui/src/key_hint.rs` (Apache-2.0).
//! Bakudo retains the original small API surface for shared inline key labels.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    style::{Style, Stylize},
    text::Span,
};

#[cfg(test)]
const ALT_PREFIX: &str = "⌥ + ";
#[cfg(all(not(test), target_os = "macos"))]
const ALT_PREFIX: &str = "⌥ + ";
#[cfg(all(not(test), not(target_os = "macos")))]
const ALT_PREFIX: &str = "alt + ";
const CTRL_PREFIX: &str = "ctrl + ";
const SHIFT_PREFIX: &str = "shift + ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct KeyBinding {
    key: KeyCode,
    modifiers: KeyModifiers,
}

impl KeyBinding {
    pub(crate) const fn new(key: KeyCode, modifiers: KeyModifiers) -> Self {
        Self { key, modifiers }
    }

    #[allow(dead_code)]
    pub fn is_press(&self, event: KeyEvent) -> bool {
        self.key == event.code
            && self.modifiers == event.modifiers
            && (event.kind == KeyEventKind::Press || event.kind == KeyEventKind::Repeat)
    }
}

pub(crate) const fn plain(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::NONE)
}

#[allow(dead_code)]
pub(crate) const fn alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::ALT)
}

#[allow(dead_code)]
pub(crate) const fn shift(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::SHIFT)
}

#[allow(dead_code)]
pub(crate) const fn ctrl(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL)
}

#[allow(dead_code)]
pub(crate) const fn ctrl_alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL.union(KeyModifiers::ALT))
}

fn modifiers_to_string(modifiers: KeyModifiers) -> String {
    let mut result = String::new();
    if modifiers.contains(KeyModifiers::CONTROL) {
        result.push_str(CTRL_PREFIX);
    }
    if modifiers.contains(KeyModifiers::SHIFT) {
        result.push_str(SHIFT_PREFIX);
    }
    if modifiers.contains(KeyModifiers::ALT) {
        result.push_str(ALT_PREFIX);
    }
    result
}

impl From<KeyBinding> for Span<'static> {
    fn from(binding: KeyBinding) -> Self {
        (&binding).into()
    }
}

impl From<&KeyBinding> for Span<'static> {
    fn from(binding: &KeyBinding) -> Self {
        let KeyBinding { key, modifiers } = binding;
        let modifiers = modifiers_to_string(*modifiers);
        let key = match key {
            KeyCode::Backspace => "backspace".to_string(),
            KeyCode::BackTab => "backtab".to_string(),
            KeyCode::Delete => "delete".to_string(),
            KeyCode::End => "end".to_string(),
            KeyCode::Enter => "enter".to_string(),
            KeyCode::Esc => "esc".to_string(),
            KeyCode::Home => "home".to_string(),
            KeyCode::Insert => "insert".to_string(),
            KeyCode::Tab => "tab".to_string(),
            KeyCode::Char(' ') => "space".to_string(),
            KeyCode::Char(ch) => ch.to_string().to_ascii_lowercase(),
            KeyCode::F(num) => format!("f{num}"),
            KeyCode::Up => "↑".to_string(),
            KeyCode::Down => "↓".to_string(),
            KeyCode::Left => "←".to_string(),
            KeyCode::Right => "→".to_string(),
            KeyCode::PageUp => "pgup".to_string(),
            KeyCode::PageDown => "pgdn".to_string(),
            _ => format!("{key:?}").to_ascii_lowercase(),
        };
        Span::styled(format!("{modifiers}{key}"), key_hint_style())
    }
}

fn key_hint_style() -> Style {
    Style::default().dim()
}

#[allow(dead_code)]
pub(crate) fn has_ctrl_or_alt(mods: KeyModifiers) -> bool {
    (mods.contains(KeyModifiers::CONTROL) || mods.contains(KeyModifiers::ALT)) && !is_altgr(mods)
}

#[cfg(windows)]
#[inline]
pub(crate) fn is_altgr(mods: KeyModifiers) -> bool {
    mods.contains(KeyModifiers::ALT) && mods.contains(KeyModifiers::CONTROL)
}

#[cfg(not(windows))]
#[inline]
#[allow(dead_code)]
pub(crate) fn is_altgr(_mods: KeyModifiers) -> bool {
    false
}
