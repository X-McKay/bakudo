//! Terminal-palette-aware color system.
//!
//! Inspired by the Codex TUI color system: we detect whether the terminal
//! background is light or dark and blend accent colours accordingly so that
//! Bakudo looks good on both dark (most developer terminals) and light themes.
//!
//! When the background colour cannot be detected we fall back to a curated
//! dark-theme palette that works well on the most common terminal defaults.

use ratatui::style::{Color, Style, Stylize};

// ─── Gutter / spacing constants ────────────────────────────────────────────

/// Width (columns) of the left gutter used by the transcript and composer.
/// Matches Codex's `LIVE_PREFIX_COLS` for visual parity.
pub const GUTTER: u16 = 2;

/// Width of the right sandbox shelf panel.
pub const SHELF_WIDTH: u16 = 34;

/// Minimum terminal width before the shelf is hidden.
pub const SHELF_MIN_TERM_WIDTH: u16 = 90;

/// Height of the header bar (1 row).
pub const HEADER_HEIGHT: u16 = 1;

/// Height of the composer block (border + 1 input line + border = 3).
pub const COMPOSER_HEIGHT: u16 = 3;

/// Height of the footer hint bar.
pub const FOOTER_HEIGHT: u16 = 1;

// ─── Palette ───────────────────────────────────────────────────────────────

/// Perceptual luminance of an sRGB colour (0–255 range).
pub fn luminance(r: u8, g: u8, b: u8) -> f32 {
    0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32
}

/// Returns true when the terminal background is light-coloured.
pub fn is_light_bg(bg: Option<(u8, u8, u8)>) -> bool {
    bg.map(|(r, g, b)| luminance(r, g, b) > 128.0)
        .unwrap_or(false)
}

/// Alpha-blend `fg` over `bg`.
pub fn blend(fg: (u8, u8, u8), bg: (u8, u8, u8), alpha: f32) -> Color {
    let r = (fg.0 as f32 * alpha + bg.0 as f32 * (1.0 - alpha)) as u8;
    let g = (fg.1 as f32 * alpha + bg.1 as f32 * (1.0 - alpha)) as u8;
    let b = (fg.2 as f32 * alpha + bg.2 as f32 * (1.0 - alpha)) as u8;
    Color::Rgb(r, g, b)
}

// ─── Semantic colour accessors ─────────────────────────────────────────────

/// Subtle background tint for user messages (matches Codex's `user_message_bg`).
pub fn user_msg_bg(light: bool) -> Color {
    if light {
        blend((0, 0, 0), (255, 255, 255), 0.06)
    } else {
        blend((255, 255, 255), (30, 30, 30), 0.10)
    }
}

/// Accent colour for the active border / focus ring.
pub fn focus_border() -> Color {
    Color::Rgb(99, 179, 237) // cool blue — readable on both dark and light
}

/// Dim border colour for unfocused panels.
pub fn dim_border() -> Color {
    Color::Rgb(75, 85, 99) // slate-600
}

/// Header background.
pub fn header_bg() -> Color {
    Color::Rgb(17, 24, 39) // gray-900
}

/// Header foreground.
pub fn header_fg() -> Color {
    Color::Rgb(229, 231, 235) // gray-200
}

/// Accent colour for the provider badge in the header.
pub fn provider_accent() -> Color {
    Color::Rgb(139, 92, 246) // violet-500
}

/// Model badge colour.
pub fn model_accent() -> Color {
    Color::Rgb(52, 211, 153) // emerald-400
}

/// Footer text colour.
pub fn footer_fg() -> Color {
    Color::Rgb(107, 114, 128) // gray-500
}

/// Footer key-hint highlight colour.
pub fn hint_key_fg() -> Color {
    Color::Rgb(156, 163, 175) // gray-400
}

// ─── Role colours ──────────────────────────────────────────────────────────

pub fn role_user_fg() -> Color {
    Color::Rgb(52, 211, 153) // emerald-400
}

pub fn role_system_fg() -> Color {
    Color::Rgb(251, 191, 36) // amber-400
}

pub fn role_agent_fg() -> Color {
    Color::Rgb(229, 231, 235) // gray-200
}

pub fn role_error_fg() -> Color {
    Color::Rgb(248, 113, 113) // red-400
}

pub fn role_info_fg() -> Color {
    Color::Rgb(96, 165, 250) // blue-400
}

// ─── Shelf state colours ───────────────────────────────────────────────────

pub fn shelf_running() -> Color {
    Color::Rgb(52, 211, 153) // emerald-400
}

pub fn shelf_preserved() -> Color {
    Color::Rgb(251, 191, 36) // amber-400
}

pub fn shelf_merged() -> Color {
    Color::Rgb(96, 165, 250) // blue-400
}

pub fn shelf_discarded() -> Color {
    Color::Rgb(107, 114, 128) // gray-500
}

pub fn shelf_failed() -> Color {
    Color::Rgb(248, 113, 113) // red-400
}

pub fn shelf_conflicts() -> Color {
    Color::Rgb(217, 70, 239) // fuchsia-500
}

pub fn shelf_selected_bg() -> Color {
    Color::Rgb(31, 41, 55) // gray-800
}

// ─── Spinner frames ────────────────────────────────────────────────────────

/// Braille spinner frames — same sequence Codex uses.
pub const SPINNER_FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Return the spinner frame for the given tick counter.
pub fn spinner_frame(tick: u64) -> &'static str {
    SPINNER_FRAMES[(tick as usize) % SPINNER_FRAMES.len()]
}

// ─── Style helpers ─────────────────────────────────────────────────────────

/// Style for a focused panel border.
pub fn focused_border_style() -> Style {
    Style::default().fg(focus_border())
}

/// Style for an unfocused panel border.
pub fn unfocused_border_style() -> Style {
    Style::default().fg(dim_border())
}

/// Dim style for timestamps and secondary metadata.
pub fn dim_style() -> Style {
    Style::default().fg(Color::Rgb(75, 85, 99)).dim()
}

/// Bold style for role prefixes.
pub fn bold_style(fg: Color) -> Style {
    Style::default().fg(fg).bold()
}
