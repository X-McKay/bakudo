//! TUI color palette and layout constants.
//!
//! All semantic color/style choices live here so the theme stays consistent.
//! Helpers expose semantic roles (e.g. `shelf_running`) rather than raw colors
//! so rendering code does not depend on specific hues. Colors are ANSI-named
//! per `codex-rs/tui/styles.md` so the user's terminal theme defines the
//! actual hue. Where a soft background tint is needed (the user-row in the
//! transcript), `crate::style::user_message_style()` blends a small percent
//! of black/white over the terminal's actual background via OSC 11.

use ratatui::style::{Color, Modifier, Style, Stylize};

// ─── Gutter / spacing constants ────────────────────────────────────────────

/// Width (columns) of the left gutter used by the transcript and composer.
pub const GUTTER: u16 = 2;

/// Width of the right sandbox shelf panel.
pub const SHELF_WIDTH: u16 = 34;

/// Minimum terminal width before the shelf is hidden.
pub const SHELF_MIN_TERM_WIDTH: u16 = 90;

/// Height of the header bar (2 rows).
pub const HEADER_HEIGHT: u16 = 2;

/// Minimum height of the composer block (2 borders + 1 input row).
pub const COMPOSER_MIN_HEIGHT: u16 = 3;

/// Maximum height the composer may grow to when rendering multi-line input.
pub const COMPOSER_MAX_HEIGHT: u16 = 12;

/// Compute the composer's rendered height for an input buffer containing
/// `line_count` lines (split on `\n`), clamped to the min/max constants.
pub fn composer_height_for(line_count: usize) -> u16 {
    let rows = line_count.max(1) as u16;
    (rows + 2).clamp(COMPOSER_MIN_HEIGHT, COMPOSER_MAX_HEIGHT)
}

/// Height of the footer hint bar.
pub const FOOTER_HEIGHT: u16 = 1;

// ─── Structural colours ────────────────────────────────────────────────────

pub fn focus_border() -> Color {
    Color::Cyan
}

pub fn dim_border() -> Color {
    // Color cannot carry a modifier on its own; for the "dim" semantic prefer
    // `dim_style()` (or wrap as `Style::default().fg(dim_border()).dim()`).
    Color::Reset
}

pub fn header_fg() -> Color {
    Color::Reset
}

pub fn footer_fg() -> Color {
    // Callers add `.dim()` via the existing `hint_key` helper or wrap manually.
    Color::Reset
}

pub fn hint_key_fg() -> Color {
    // Callers add `.bold()` or wrap manually.
    Color::Reset
}

// ─── Role colours ──────────────────────────────────────────────────────────

pub fn role_user_fg() -> Color {
    Color::Cyan
}

pub fn role_system_fg() -> Color {
    Color::Magenta
}

pub fn role_mission_fg() -> Color {
    Color::Magenta
}

pub fn role_agent_fg() -> Color {
    Color::Reset
}

pub fn role_error_fg() -> Color {
    Color::Red
}

pub fn role_info_fg() -> Color {
    Color::Blue
}

pub fn provider_accent() -> Color {
    Color::Magenta
}

pub fn model_accent() -> Color {
    Color::Green
}

// ─── Shelf state colours ───────────────────────────────────────────────────

pub fn shelf_running() -> Color {
    Color::Cyan
}

pub fn shelf_preserved() -> Color {
    Color::Green
}

pub fn shelf_merged() -> Color {
    Color::Blue
}

pub fn shelf_discarded() -> Color {
    // Callers should add `.dim()` for the intended visual.
    Color::Reset
}

pub fn shelf_failed() -> Color {
    Color::Red
}

pub fn shelf_conflicts() -> Color {
    Color::Magenta
}

pub fn shelf_timed_out() -> Color {
    // Callers add `.dim()` for the intended visual.
    Color::Red
}

/// Background fill for the selected shelf row. Returns the terminal-bg-aware
/// soft tint when the bg is known, else `Color::Reset` (no fill).
pub fn shelf_selected_bg() -> Color {
    use crate::style::user_message_bg;
    use crate::terminal_palette::default_bg;
    match default_bg() {
        Some(bg) => user_message_bg(bg),
        None => Color::Reset,
    }
}

// ─── Diff colours ──────────────────────────────────────────────────────────

pub fn diff_added() -> Color {
    Color::Green
}

pub fn diff_removed() -> Color {
    Color::Red
}

pub fn diff_hunk() -> Color {
    Color::Cyan
}

// ─── Spinner frames ────────────────────────────────────────────────────────

pub const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn spinner_frame(tick: u64) -> &'static str {
    SPINNER_FRAMES[(tick as usize) % SPINNER_FRAMES.len()]
}

// ─── Style helpers ─────────────────────────────────────────────────────────

pub fn focused_border_style() -> Style {
    Style::default().fg(focus_border())
}

pub fn unfocused_border_style() -> Style {
    // Carries the dim modifier; previously relied on a hardcoded gray fg.
    Style::default().add_modifier(Modifier::DIM)
}

pub fn dim_style() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

pub fn bold_style(fg: Color) -> Style {
    Style::default().fg(fg).bold()
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test: every public color/style fn returns without panicking.
    /// Catches accidental signature breaks in future refactors.
    #[test]
    fn every_public_palette_fn_returns() {
        // Colors
        let _ = focus_border();
        let _ = dim_border();
        let _ = header_fg();
        let _ = footer_fg();
        let _ = hint_key_fg();
        let _ = role_user_fg();
        let _ = role_system_fg();
        let _ = role_mission_fg();
        let _ = role_agent_fg();
        let _ = role_error_fg();
        let _ = role_info_fg();
        let _ = provider_accent();
        let _ = model_accent();
        let _ = shelf_running();
        let _ = shelf_preserved();
        let _ = shelf_merged();
        let _ = shelf_discarded();
        let _ = shelf_failed();
        let _ = shelf_conflicts();
        let _ = shelf_timed_out();
        let _ = shelf_selected_bg();
        let _ = diff_added();
        let _ = diff_removed();
        let _ = diff_hunk();

        // Styles
        let _ = focused_border_style();
        let _ = unfocused_border_style();
        let _ = dim_style();
        let _ = bold_style(Color::Cyan);

        // Spinner
        let _ = spinner_frame(0);
        let _ = spinner_frame(u64::MAX);

        // Layout helpers
        assert_eq!(composer_height_for(1), COMPOSER_MIN_HEIGHT);
        assert!(composer_height_for(100) <= COMPOSER_MAX_HEIGHT);
    }

    #[test]
    fn dim_helpers_carry_dim_modifier() {
        assert!(dim_style().add_modifier.contains(Modifier::DIM));
        assert!(
            unfocused_border_style()
                .add_modifier
                .contains(Modifier::DIM)
        );
    }
}
