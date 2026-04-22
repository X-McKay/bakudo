//! TUI color palette and layout constants.
//!
//! All hex/RGB tuples live here so the theme can be tuned in one place.
//! Helpers expose _semantic_ roles (e.g. `shelf_running`) rather than raw
//! colors so rendering code does not depend on specific hues.

use ratatui::style::{Color, Style, Stylize};

// ─── Gutter / spacing constants ────────────────────────────────────────────

/// Width (columns) of the left gutter used by the transcript and composer.
pub const GUTTER: u16 = 2;

/// Width of the right sandbox shelf panel.
pub const SHELF_WIDTH: u16 = 34;

/// Minimum terminal width before the shelf is hidden.
pub const SHELF_MIN_TERM_WIDTH: u16 = 90;

/// Height of the header bar (2 rows).
pub const HEADER_HEIGHT: u16 = 2;

/// Height of the composer block (border + 1 input line + border = 3).
pub const COMPOSER_HEIGHT: u16 = 3;

/// Height of the footer hint bar.
pub const FOOTER_HEIGHT: u16 = 1;

// ─── Base hues (Tailwind-inspired) ─────────────────────────────────────────

const EMERALD_400: Color = Color::Rgb(52, 211, 153);
const AMBER_400: Color = Color::Rgb(251, 191, 36);
const BLUE_400: Color = Color::Rgb(96, 165, 250);
const RED_400: Color = Color::Rgb(248, 113, 113);
const VIOLET_500: Color = Color::Rgb(139, 92, 246);
const FUCHSIA_500: Color = Color::Rgb(217, 70, 239);
const ORANGE_500: Color = Color::Rgb(249, 115, 22);
const SKY_400: Color = Color::Rgb(99, 179, 237);
const GRAY_200: Color = Color::Rgb(229, 231, 235);
const GRAY_400: Color = Color::Rgb(156, 163, 175);
const GRAY_500: Color = Color::Rgb(107, 114, 128);
const GRAY_600: Color = Color::Rgb(75, 85, 99);
const GRAY_800: Color = Color::Rgb(31, 41, 55);
const GRAY_900: Color = Color::Rgb(17, 24, 39);

// ─── Structural colours ────────────────────────────────────────────────────

pub fn focus_border() -> Color {
    SKY_400
}
pub fn dim_border() -> Color {
    GRAY_600
}
pub fn header_bg() -> Color {
    GRAY_900
}
pub fn header_fg() -> Color {
    GRAY_200
}
pub fn footer_fg() -> Color {
    GRAY_500
}
pub fn hint_key_fg() -> Color {
    GRAY_400
}

// ─── Role colours ──────────────────────────────────────────────────────────

pub fn role_user_fg() -> Color {
    EMERALD_400
}
pub fn role_system_fg() -> Color {
    AMBER_400
}
pub fn role_agent_fg() -> Color {
    GRAY_200
}
pub fn role_error_fg() -> Color {
    RED_400
}
pub fn role_info_fg() -> Color {
    BLUE_400
}
pub fn provider_accent() -> Color {
    VIOLET_500
}
pub fn model_accent() -> Color {
    EMERALD_400
}

// ─── Shelf state colours ───────────────────────────────────────────────────

pub fn shelf_running() -> Color {
    EMERALD_400
}
pub fn shelf_preserved() -> Color {
    AMBER_400
}
pub fn shelf_merged() -> Color {
    BLUE_400
}
pub fn shelf_discarded() -> Color {
    GRAY_500
}
pub fn shelf_failed() -> Color {
    RED_400
}
pub fn shelf_conflicts() -> Color {
    FUCHSIA_500
}
pub fn shelf_timed_out() -> Color {
    ORANGE_500
}
pub fn shelf_selected_bg() -> Color {
    GRAY_800
}

// ─── Diff colours ──────────────────────────────────────────────────────────

pub fn diff_added() -> Color {
    EMERALD_400
}
pub fn diff_removed() -> Color {
    RED_400
}
pub fn diff_hunk() -> Color {
    BLUE_400
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
    Style::default().fg(dim_border())
}

pub fn dim_style() -> Style {
    Style::default().fg(GRAY_600).dim()
}

pub fn bold_style(fg: Color) -> Style {
    Style::default().fg(fg).bold()
}
