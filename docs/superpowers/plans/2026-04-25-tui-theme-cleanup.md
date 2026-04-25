# TUI Theme Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bakudo's hardcoded Tailwind RGB palette with codex's ANSI-named-color scheme + terminal-bg-aware tinting, so the TUI looks correct on any terminal theme.

**Architecture:** Three new modules ported from codex's `tui/src/{color,terminal_palette,style}.rs` (Apache-2.0). The OSC 11/10 query — which codex gets from a forked crossterm — is hand-rolled here on stable crossterm 0.27 (~80 LOC platform code). `palette.rs` keeps every public function signature; only the bodies change. `app.rs` and `ui.rs` are touched minimally: drop the header bg fill, replace direct `dim_border()` callers with `dim_style()`, and add a soft user-row background tint in `render_transcript`.

**Tech Stack:** Rust 2021 (edition.workspace), crossterm 0.27, ratatui 0.26, new dep `supports-color = "3"`. Hand-rolled OSC 11 uses `crossterm::terminal::{enable_raw_mode, disable_raw_mode}` (already in tree) plus `std::sync::mpsc::channel` and `std::thread::spawn` for the bounded-timeout read.

**Spec:** `docs/superpowers/specs/2026-04-25-tui-theme-cleanup-design.md` (committed in the same branch at commit `4d2b298`).

**Scope:** Theme/style only. **Out of scope:** layout, widget vocabulary, footer collapse, alt-screen — those are Phases 2-5.

---

## File map

| File | Status | Purpose |
|---|---|---|
| `Cargo.toml` (workspace) | MODIFY | add `supports-color = "3"` to `[workspace.dependencies]` |
| `crates/bakudo-tui/Cargo.toml` | MODIFY | add `supports-color.workspace = true` to deps |
| `crates/bakudo-tui/src/color.rs` | CREATE | ports from `codex-rs/tui/src/color.rs` (verbatim, ~75 LOC) — RGB blend / Lab perceptual distance helpers |
| `crates/bakudo-tui/src/style.rs` | CREATE | ports from `codex-rs/tui/src/style.rs` (verbatim, ~44 LOC) — `user_message_style()` etc. |
| `crates/bakudo-tui/src/terminal_palette.rs` | CREATE | ports from `codex-rs/tui/src/terminal_palette.rs` (~500 LOC); the `imp` module is rewritten to hand-roll OSC 11/10 on crossterm 0.27 |
| `crates/bakudo-tui/src/lib.rs` | MODIFY | add `pub mod color; pub mod style; pub mod terminal_palette;` |
| `crates/bakudo-tui/src/palette.rs` | REWRITE BODY | keep every public signature; rewrite bodies per the spec mapping table; add 28th regression test |
| `crates/bakudo-tui/src/ui.rs` | MODIFY | (a) replace 17 direct `palette::dim_border()` callers with `palette::dim_style()`; (b) drop bg fills at 2 sites; (c) apply `style::user_message_style()` to user-row Lines in `render_transcript` |
| `src/main.rs` | MODIFY | call `bakudo_tui::terminal_palette::initialize_default_colors()` once at TUI startup, **before** `TerminalGuard::enter()` |

---

## Task 1: Add `supports-color` dependency

**Files:**
- Modify: `Cargo.toml` (workspace, top of repo)
- Modify: `crates/bakudo-tui/Cargo.toml`

- [ ] **Step 1.1: Add to workspace dependencies**

Edit `Cargo.toml` at the workspace root. Find the `[workspace.dependencies]` block (currently ends with the `chrono = { version = "0.4", features = ["serde"] }` line). Add:

```toml
supports-color = "3"
```

- [ ] **Step 1.2: Add to bakudo-tui crate dependencies**

Edit `crates/bakudo-tui/Cargo.toml`. In the `[dependencies]` block, add:

```toml
supports-color = { workspace = true }
```

- [ ] **Step 1.3: Verify it builds**

Run: `cargo build -p bakudo-tui 2>&1 | tail -5`
Expected: `Finished` — `supports-color` will be downloaded but unused. No errors.

- [ ] **Step 1.4: Commit**

```bash
git add Cargo.toml Cargo.lock crates/bakudo-tui/Cargo.toml
git commit -m "chore(tui): add supports-color dependency for upcoming terminal palette"
```

---

## Task 2: Port `color.rs` verbatim

**Files:**
- Create: `crates/bakudo-tui/src/color.rs`
- Source: `/tmp/codex-research/codex/codex-rs/tui/src/color.rs`

- [ ] **Step 2.1: Copy the file**

```bash
cp /tmp/codex-research/codex/codex-rs/tui/src/color.rs crates/bakudo-tui/src/color.rs
```

- [ ] **Step 2.2: Add provenance header**

Open `crates/bakudo-tui/src/color.rs` and prepend (preserving the existing content below):

```rust
//! Color blending + perceptual distance helpers.
//!
//! Ported verbatim from `codex-rs/tui/src/color.rs` (Apache-2.0).
//! Inherited license matches bakudo's own Apache-2.0.
```

- [ ] **Step 2.3: Verify it builds standalone**

The file is not yet wired into `lib.rs` so cargo won't include it; that's fine. Just confirm syntactic validity:

```bash
rustc --edition 2021 --crate-type lib --emit=metadata -o /tmp/_check.rmeta crates/bakudo-tui/src/color.rs 2>&1 | tail -5
```
Expected: warnings only (unused functions). No errors.

- [ ] **Step 2.4: Commit**

```bash
git add crates/bakudo-tui/src/color.rs
git commit -m "feat(tui): port codex color.rs (RGB blend + Lab perceptual distance)"
```

---

## Task 3: Port `style.rs` verbatim

**Files:**
- Create: `crates/bakudo-tui/src/style.rs`
- Source: `/tmp/codex-research/codex/codex-rs/tui/src/style.rs`

- [ ] **Step 3.1: Copy the file**

```bash
cp /tmp/codex-research/codex/codex-rs/tui/src/style.rs crates/bakudo-tui/src/style.rs
```

- [ ] **Step 3.2: Add provenance header**

Prepend:

```rust
//! Style helpers for terminal-bg-aware row tinting.
//!
//! Ported verbatim from `codex-rs/tui/src/style.rs` (Apache-2.0).
```

- [ ] **Step 3.3: Verify file syntax**

```bash
rustc --edition 2021 --crate-type lib --emit=metadata -o /tmp/_check.rmeta crates/bakudo-tui/src/style.rs 2>&1 | tail -5
```
Expected: errors about missing `crate::color` / `crate::terminal_palette` imports. **That's expected** — we'll wire them up in Task 6 when `lib.rs` declares the modules. The point of this step is to confirm there are no other syntax issues.

- [ ] **Step 3.4: Commit**

```bash
git add crates/bakudo-tui/src/style.rs
git commit -m "feat(tui): port codex style.rs (user_message_style + soft tint)"
```

---

## Task 4: Port `terminal_palette.rs` with hand-rolled OSC 11/10

**Files:**
- Create: `crates/bakudo-tui/src/terminal_palette.rs`
- Source: `/tmp/codex-research/codex/codex-rs/tui/src/terminal_palette.rs` (lines 1-70 + 145-422)
- Replace: codex's `imp` module (lines 71-143) with bakudo's hand-rolled equivalent

This is the largest task. It copies the bulk of codex's file but replaces the `mod imp { ... }` block (which depends on the nornagon crossterm fork) with a hand-rolled OSC 11/10 implementation on stable crossterm.

- [ ] **Step 4.1: Copy the codex file as starting point**

```bash
cp /tmp/codex-research/codex/codex-rs/tui/src/terminal_palette.rs crates/bakudo-tui/src/terminal_palette.rs
```

- [ ] **Step 4.2: Add provenance header**

Prepend:

```rust
//! Terminal palette — color level detection + OSC 11/10 default-color queries.
//!
//! Ported from `codex-rs/tui/src/terminal_palette.rs` (Apache-2.0). The `imp`
//! module that codex implements via the nornagon crossterm fork's
//! `query_background_color` / `query_foreground_color` is replaced here with a
//! self-contained OSC 11/10 sender + parser on stable crossterm 0.27.
//! Everything else (cache, color level detection, XTERM_COLORS table,
//! best_color, perceptual snapping) is verbatim.
```

- [ ] **Step 4.3: Replace the `imp` module**

In the copied file, find the `#[cfg(all(unix, not(test)))] mod imp { ... }` block (lines 71-143 in the source). Delete that entire block and replace with:

```rust
#[cfg(all(unix, not(test)))]
mod imp {
    use super::DefaultColors;
    use crossterm::terminal::disable_raw_mode;
    use crossterm::terminal::enable_raw_mode;
    use crossterm::terminal::is_raw_mode_enabled;
    use std::io::IsTerminal;
    use std::io::Read;
    use std::io::Write;
    use std::io::stdin;
    use std::io::stdout;
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    /// Maximum time we wait for the terminal to reply to our OSC query.
    const QUERY_TIMEOUT: Duration = Duration::from_millis(100);

    struct Cache<T> {
        attempted: bool,
        value: Option<T>,
    }

    impl<T> Default for Cache<T> {
        fn default() -> Self {
            Self {
                attempted: false,
                value: None,
            }
        }
    }

    impl<T: Copy> Cache<T> {
        fn get_or_init_with(&mut self, mut init: impl FnMut() -> Option<T>) -> Option<T> {
            if !self.attempted {
                self.value = init();
                self.attempted = true;
            }
            self.value
        }

        fn refresh_with(&mut self, mut init: impl FnMut() -> Option<T>) -> Option<T> {
            self.value = init();
            self.attempted = true;
            self.value
        }
    }

    fn default_colors_cache() -> &'static Mutex<Cache<DefaultColors>> {
        static CACHE: OnceLock<Mutex<Cache<DefaultColors>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(Cache::default()))
    }

    pub(super) fn default_colors() -> Option<DefaultColors> {
        let cache = default_colors_cache();
        let mut cache = cache.lock().ok()?;
        cache.get_or_init_with(query_default_colors)
    }

    pub(super) fn requery_default_colors() {
        if let Ok(mut cache) = default_colors_cache().lock() {
            // Don't try to refresh if a previous attempt succeeded-with-None;
            // the terminal likely doesn't support these queries.
            if cache.attempted && cache.value.is_none() {
                return;
            }
            cache.refresh_with(query_default_colors);
        }
    }

    fn query_default_colors() -> Option<DefaultColors> {
        // Skip entirely if stdin/stdout aren't a TTY (CI, piped, etc).
        if !stdin().is_terminal() || !stdout().is_terminal() {
            return None;
        }

        // We need raw mode to capture the OSC reply byte-for-byte.
        // If raw mode is already on (we're called from inside the TUI), don't toggle it.
        let we_enabled_raw = match is_raw_mode_enabled() {
            Ok(true) => false,
            Ok(false) => match enable_raw_mode() {
                Ok(_) => true,
                Err(_) => return None,
            },
            Err(_) => return None,
        };

        let fg = query_osc_color(10);
        let bg = query_osc_color(11);

        if we_enabled_raw {
            let _ = disable_raw_mode();
        }

        match (fg, bg) {
            (Some(fg), Some(bg)) => Some(DefaultColors { fg, bg }),
            _ => None,
        }
    }

    /// Send `ESC ] {code} ; ? ESC \\` and read the reply, parsing the
    /// `rgb:RRRR/GGGG/BBBB` body. Returns `None` on timeout, parse failure,
    /// or any I/O error. Caller is responsible for raw-mode setup/teardown.
    fn query_osc_color(code: u8) -> Option<(u8, u8, u8)> {
        // Send the query.
        let mut out = stdout().lock();
        let _ = write!(out, "\x1b]{};?\x1b\\", code);
        let _ = out.flush();
        drop(out);

        // Read the reply on a background thread with a hard timeout. We send
        // bytes back via a channel; if the channel times out we return None
        // and let the reader thread exit naturally on the next byte (or never;
        // it's a one-shot at startup, the OS will reap it on process exit).
        let (tx, rx) = mpsc::channel::<u8>();
        thread::spawn(move || {
            let mut byte = [0u8; 1];
            let mut stdin = stdin().lock();
            // Read up to ~80 bytes; the reply is well under that.
            for _ in 0..80 {
                if stdin.read(&mut byte).ok()? != 1 {
                    return Some(());
                }
                if tx.send(byte[0]).is_err() {
                    return Some(()); // receiver dropped
                }
                // Stop after we see ST (`ESC \\`) or BEL.
                if byte[0] == 0x07 {
                    return Some(());
                }
            }
            Some(())
        });

        // Collect bytes within the timeout window.
        let mut buf = Vec::with_capacity(40);
        let deadline = std::time::Instant::now() + QUERY_TIMEOUT;
        loop {
            let remaining = deadline.checked_duration_since(std::time::Instant::now())?;
            match rx.recv_timeout(remaining) {
                Ok(b) => {
                    buf.push(b);
                    // ST is ESC followed by backslash.
                    if b == 0x07 || (buf.len() >= 2 && buf[buf.len() - 2] == 0x1b && b == b'\\') {
                        break;
                    }
                }
                Err(_) => return None,
            }
        }

        parse_osc_color_reply(&buf)
    }

    /// Parse a reply of shape `ESC ] N ; rgb:RRRR/GGGG/BBBB ST` (or with BEL).
    /// Components may be 1-4 hex digits; we use the high byte as the 0-255 value.
    fn parse_osc_color_reply(bytes: &[u8]) -> Option<(u8, u8, u8)> {
        let s = std::str::from_utf8(bytes).ok()?;
        let body = s.split_once("rgb:").map(|(_, rest)| rest)?;
        let body = body
            .trim_end_matches(|c: char| c == 0x07 as char || c == '\\' || c == 0x1b as char);
        let mut parts = body.split('/');
        let r = parts.next().and_then(parse_hex_component)?;
        let g = parts.next().and_then(parse_hex_component)?;
        let b = parts.next().and_then(parse_hex_component)?;
        Some((r, g, b))
    }

    fn parse_hex_component(s: &str) -> Option<u8> {
        if s.is_empty() || s.len() > 4 {
            return None;
        }
        // Pad to 4 hex digits on the right (low nibbles), then take the high byte.
        let padded = format!("{:0<4}", s);
        let full = u16::from_str_radix(&padded, 16).ok()?;
        Some((full >> 8) as u8)
    }

    #[cfg(test)]
    mod tests {
        use super::parse_osc_color_reply;

        #[test]
        fn parses_4_digit_components() {
            // ESC ] 11 ; rgb:1e1e/2e2e/3e3e ESC \
            let reply = b"\x1b]11;rgb:1e1e/2e2e/3e3e\x1b\\";
            assert_eq!(parse_osc_color_reply(reply), Some((0x1e, 0x2e, 0x3e)));
        }

        #[test]
        fn parses_2_digit_components_with_bel_terminator() {
            let reply = b"\x1b]11;rgb:1e/2e/3e\x07";
            assert_eq!(parse_osc_color_reply(reply), Some((0x1e, 0x2e, 0x3e)));
        }

        #[test]
        fn rejects_garbage() {
            assert_eq!(parse_osc_color_reply(b"hello world"), None);
        }
    }
}
```

- [ ] **Step 4.4: Add a public initializer**

At the **top** of the file (after the use statements), add:

```rust
/// Eagerly populate the default-color cache by querying the terminal.
/// Call this once at TUI startup, **before** entering raw mode for the main
/// event loop, so the OSC reply doesn't get mixed in with key events.
pub fn initialize_default_colors() {
    let _ = default_colors();
}
```

- [ ] **Step 4.5: Run the unit tests**

```bash
cargo test -p bakudo-tui --lib terminal_palette 2>&1 | tail -10
```
Expected: 3 new tests pass (`parses_4_digit_components`, `parses_2_digit_components_with_bel_terminator`, `rejects_garbage`).

- [ ] **Step 4.6: Commit**

```bash
git add crates/bakudo-tui/src/terminal_palette.rs
git commit -m "feat(tui): port codex terminal_palette.rs with hand-rolled OSC 11/10

Re-implements the imp module on stable crossterm 0.27 since the
query_background_color / query_foreground_color helpers exist only in
codex's nornagon crossterm fork. Keeps the rest verbatim: cache, color
level detection, XTERM_COLORS table, best_color, perceptual snapping."
```

---

## Task 5: Wire modules into `lib.rs` and initialize at startup

**Files:**
- Modify: `crates/bakudo-tui/src/lib.rs`
- Modify: `src/main.rs`

- [ ] **Step 5.1: Add module declarations**

Edit `crates/bakudo-tui/src/lib.rs`. Current content is just six `pub mod` lines. Add three:

```rust
pub mod app;
pub mod color;
pub mod commands;
pub mod events;
pub mod palette;
pub mod style;
pub mod terminal_palette;
pub mod transcript_store;
pub mod ui;
```

(Alphabetised insertion of `color`, `style`, `terminal_palette`.)

- [ ] **Step 5.2: Verify the workspace builds**

```bash
cargo build --workspace 2>&1 | tail -3
```
Expected: `Finished`. The `style.rs` module's `crate::color::*` and `crate::terminal_palette::*` imports now resolve.

- [ ] **Step 5.3: Initialize from main**

Open `src/main.rs`. Find the `async fn run_tui(` function (around line 718). Locate the line that creates the `TerminalGuard`:

```rust
let _guard = TerminalGuard::enter()?;
```

Insert immediately **before** that line:

```rust
// Query the terminal's default fg/bg colors once at startup, BEFORE we enter
// raw mode for event reading. The query writes an OSC 11/10 sequence and
// reads the reply byte-for-byte; doing it here keeps the reply out of the
// TUI's own key-event stream. Result is cached for the rest of the process.
bakudo_tui::terminal_palette::initialize_default_colors();
```

- [ ] **Step 5.4: Verify build + tests**

```bash
cargo build --workspace 2>&1 | tail -3
cargo test -p bakudo-tui 2>&1 | tail -5
```
Expected: build clean, all 30 tests pass (27 original + 3 new from Task 4).

- [ ] **Step 5.5: Commit**

```bash
git add crates/bakudo-tui/src/lib.rs src/main.rs
git commit -m "feat(tui): wire color/style/terminal_palette modules and init at startup"
```

---

## Task 6: Rewrite `palette.rs` body and add the regression test

This is the keystone change. Every public function in `palette.rs` keeps its signature; bodies switch to ANSI-named colors per the spec mapping table. Direct callers in `ui.rs` (Task 7) will need a parallel update because `dim_border()` no longer carries the dim modifier on its own.

**Files:**
- Modify: `crates/bakudo-tui/src/palette.rs` (full rewrite)

- [ ] **Step 6.1: Replace the entire file content**

Open `crates/bakudo-tui/src/palette.rs` and replace its full contents with:

```rust
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
        assert!(unfocused_border_style().add_modifier.contains(Modifier::DIM));
    }
}
```

Note: this rewrite **deletes** `header_bg()`, the eight `EMERALD_400`/`AMBER_400`/etc. constants, and the `GRAY_*` constants. Anything that referenced them outside `palette.rs` will fail to compile until Task 7 fixes the `ui.rs` callers. That is intentional: the compile failures act as a checklist for Task 7.

- [ ] **Step 6.2: Verify palette unit tests pass**

```bash
cargo test -p bakudo-tui --lib palette 2>&1 | tail -10
```
Expected: 2 new tests pass (`every_public_palette_fn_returns`, `dim_helpers_carry_dim_modifier`).

- [ ] **Step 6.3: Confirm the workspace currently does NOT build**

```bash
cargo build --workspace 2>&1 | tail -10
```
Expected: build errors at every `palette::header_bg()` call site in `ui.rs` (function no longer exists). This is the checklist Task 7 will work through.

- [ ] **Step 6.4: Commit (broken-on-purpose)**

```bash
git add crates/bakudo-tui/src/palette.rs
git commit -m "refactor(tui): switch palette.rs to ANSI-named colors

WIP: ui.rs callers of header_bg() no longer compile. Fixed in next commit.
Single-commit revert is safe; no consumer outside crates/bakudo-tui."
```

---

## Task 7: Migrate `ui.rs` callers + drop header bg + apply user-row tint

**Files:**
- Modify: `crates/bakudo-tui/src/ui.rs`

This task brings the workspace back to building cleanly. Three sub-changes:

(a) Replace 17 spans of the form `Style::default().fg(palette::dim_border())` with `palette::dim_style()`.
(b) Drop the two `palette::header_bg()` references (function no longer exists).
(c) Apply `style::user_message_style()` to the User-role lines in `render_transcript`.

- [ ] **Step 7.1: Migrate `dim_border()` direct callers**

Use a global replace within `ui.rs` for the recurring `·` separator pattern:

```bash
sed -i 's|Style::default()\.fg(palette::dim_border())|palette::dim_style()|g' crates/bakudo-tui/src/ui.rs
```

Verify:

```bash
grep -nE "palette::dim_border\(\)" crates/bakudo-tui/src/ui.rs
```
Expected: zero matches. (If any remain, edit them by hand to wrap in `palette::dim_style()` or `Style::default().fg(palette::dim_border()).dim()` depending on the surrounding context.)

- [ ] **Step 7.2: Drop `header_bg()` at line ~233 (header background fill)**

Find this block in `ui.rs::render_header` (around line 232):

```rust
    let header = Paragraph::new(Text::from(vec![line_1, line_2]))
        .style(Style::default().bg(palette::header_bg()));
    frame.render_widget(header, area);
```

Replace with:

```rust
    let header = Paragraph::new(Text::from(vec![line_1, line_2]));
    frame.render_widget(header, area);
```

(Drop the `.style(...)` chain entirely — let the header text inherit the terminal's background.)

- [ ] **Step 7.3: Drop `header_bg()` at line ~398 (scroll indicator overlay)**

Find this block in `ui.rs::render_transcript` (around line 394-400):

```rust
            let ind_para = Paragraph::new(indicator).style(
                Style::default()
                    .fg(palette::role_info_fg())
                    .bg(palette::header_bg()),
            );
```

Replace with:

```rust
            let ind_para = Paragraph::new(indicator)
                .style(Style::default().fg(palette::role_info_fg()));
```

(Drop the `.bg(...)` call. The scroll indicator becomes plain blue text on the terminal bg, matching codex's no-badge convention.)

- [ ] **Step 7.4: Apply user-row tint in `render_transcript`**

Find this block in `ui.rs::render_transcript` (around lines 332-368, the inner loop that builds `Line`s for each `ChatMessage`):

```rust
    for msg in &app.transcript {
        let (icon, role_label, fg) = match msg.role {
            MessageRole::User => ("▶", "you  ", palette::role_user_fg()),
            // ... other roles ...
        };

        let ts = msg.timestamp.format("%H:%M:%S").to_string();
        let role_style = Style::default().fg(fg).bold();
        let body_style = Style::default().fg(fg);

        let prefix_width = gutter + ts.len() + 1 + 1 + 1 + role_label.len();
        let body_width = (inner.width as usize).saturating_sub(prefix_width).max(1);
        let cont_indent = " ".repeat(prefix_width);

        let mut first_segment_of_msg = true;
        for content_line in msg.content.lines() {
            let wrapped = wrap_to_width(content_line, body_width);
            for segment in wrapped {
                let body_span = render_diff_aware_span(&segment, body_style);
                if first_segment_of_msg {
                    lines.push(Line::from(vec![
                        // ... spans ...
                    ]));
                    first_segment_of_msg = false;
                } else {
                    lines.push(Line::from(vec![Span::raw(cont_indent.clone()), body_span]));
                }
            }
        }
    }
```

Above the `for msg in &app.transcript {` line, add an import (or at the top of the file with the other `use` statements):

```rust
use crate::style::user_message_style;
```

Then, **inside** the `for msg` loop body, after the `match msg.role` block, compute the row style:

```rust
        let row_style = if matches!(msg.role, MessageRole::User) {
            user_message_style()
        } else {
            Style::default()
        };
```

Then, at every `lines.push(Line::from(...))` call inside this loop, attach the row style:

```rust
        lines.push(Line::from(vec![ /* ... */ ]).style(row_style));
```

Apply this `.style(row_style)` to **both** `lines.push(...)` calls inside the inner `for segment in wrapped` block (the first-segment branch and the continuation branch). The rest of the loop body is unchanged.

- [ ] **Step 7.5: Verify build + tests**

```bash
cargo build --workspace 2>&1 | tail -3
cargo test -p bakudo-tui 2>&1 | tail -5
```
Expected: build clean, 30 tests pass (27 original + 3 OSC parser + 2 palette regression — minus one if `every_public_palette_fn_returns` and `dim_helpers_carry_dim_modifier` count as 2 separate tests; expect at least 30 total).

- [ ] **Step 7.6: Commit**

```bash
git add crates/bakudo-tui/src/ui.rs
git commit -m "feat(tui): migrate ui.rs to ANSI palette; drop header bg; tint user row

- Replace 17 direct dim_border() callers with dim_style() (carries dim modifier).
- Drop bg fill on header Paragraph and scroll-indicator overlay.
- Apply style::user_message_style() to User-role lines in render_transcript
  (terminal-bg-aware soft tint via OSC 11)."
```

---

## Task 8: Final verification

- [ ] **Step 8.1: Format + clippy + full test**

```bash
cargo fmt
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -5
cargo test --workspace 2>&1 | tail -10
```
Expected: fmt is a no-op (or applies trivial formatting), clippy is clean, all tests pass (≥30 in bakudo-tui).

If clippy flags `Color::Rgb` use in the new files, add `#[allow(clippy::disallowed_methods)]` only on the lines that codex itself allows (we pulled `color.rs` and `terminal_palette.rs` verbatim, including the codex annotations).

- [ ] **Step 8.2: Build release binary for visual check**

```bash
cargo build --release --workspace 2>&1 | tail -3
```

- [ ] **Step 8.3: Visual smoke test under tui-use at 140×40**

```bash
tui-use start --label phase1-140 --cols 140 --rows 40 \
  --cwd /home/al/git/bakudo-abox/.worktrees/feature-tui-refresh \
  "./target/release/bakudo"
tui-use wait --text "Welcome" 5000
```

Confirm visually:
- Header reads on the terminal background (no header bg fill).
- The `· sys` welcome row reads in magenta.
- `·` separators in the header row are dim.

```bash
tui-use type "/sandboxes" ; tui-use press enter ; tui-use wait 1500
```

Confirm: shelf entries (if any) show distinct ANSI colors per state.

```bash
tui-use type "say hi" ; tui-use press enter ; tui-use wait 5000
```

Confirm: the `▶ you` row carries a faintly tinted background (visible on dark terminals as a slightly lighter band; on light terminals as slightly darker).

- [ ] **Step 8.4: Visual smoke test at 80×30**

```bash
tui-use kill
tui-use start --label phase1-80 --cols 80 --rows 30 \
  --cwd /home/al/git/bakudo-abox/.worktrees/feature-tui-refresh \
  "./target/release/bakudo"
tui-use wait --text "Welcome" 5000
```

Confirm: narrow layout still renders; header collapses to short form; footer hides shelf hint.

- [ ] **Step 8.5: Confirm Ctrl+C exits cleanly**

```bash
tui-use press ctrl+c ; tui-use wait 2000
tui-use list
```
Expected: status `exited`, terminal restored to non-fullscreen.

```bash
tui-use kill
tui-use daemon stop
```

- [ ] **Step 8.6: Final commit (if `cargo fmt` made changes)**

```bash
git status
# If anything is staged from cargo fmt:
git add -u && git commit -m "style(tui): cargo fmt"
```

- [ ] **Step 8.7: Push + summary**

```bash
git log --oneline main..HEAD
```

Expected output: 7-8 commits, all `feat(tui)` / `refactor(tui)` / `chore(tui)` / `docs(spec)` per bakudo conventional-commit style.

---

## Out of scope (Phases 2-5)

Following the spec's "Out of scope" section. Once Phase 1 lands, the next reasonable Phase to start is Phase 2 (status indicator + key hints + shimmer) or Phase 4 (inline rendering, the architectural shift). Decide that in a fresh planning session.
