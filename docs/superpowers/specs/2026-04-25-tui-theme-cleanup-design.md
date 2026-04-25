# TUI Theme Cleanup — Design

**Date:** 2026-04-25
**Branch:** `feature/tui-refresh` (cut from `feat/codex-revised-plan-full` in the `bakudo-codex-full` tree — the live runtime per `CLAUDE.md`)
**Phase:** 1 of the bakudo-vs-codex polish plan
**Estimated size:** ~700 LOC added (color.rs + terminal_palette.rs + style.rs incl. hand-rolled OSC 11), ~150 LOC body-rewritten, no call-site churn

**Crossterm OSC 11/10 path:** bakudo's pinned `crossterm = "0.27"` does not export `query_background_color` / `query_foreground_color` (those live only in the nornagon fork that codex uses). Phase 1 hand-rolls the OSC 11 sender + parser inside the new `terminal_palette.rs` (~80-100 LOC of self-contained platform code) instead of bumping crossterm to a Git fork. See "Architecture" below.

## Context

The bakudo v2 ratatui TUI uses a hardcoded Tailwind RGB palette in `crates/bakudo-tui/src/palette.rs`. The eight base hues (emerald, amber, blue, red, violet, fuchsia, orange, sky) are written as `Color::Rgb(r, g, b)` constants and applied unconditionally regardless of the user's terminal theme.

This produces two failure modes:

1. **On dark terminals**, the gray-600 borders nearly disappear and the emerald user-row text reads as washed-out lime against a black background.
2. **On light terminals**, the same emerald clashes badly with the bg, and the gray-200 "agent text" sits very close to the gray-100 background.

Codex ships across many terminals by following two rules in `codex-rs/tui/styles.md`:
- Use ANSI-named colors (cyan, green, red, magenta) so the user's terminal theme defines the actual hue.
- Where a tint is needed (e.g., the soft user-message background), query the terminal's actual background via OSC 11 and blend a small percentage of black/white over it.

This spec ports those rules into bakudo with no behavior change beyond color/style — `app.rs` keeps its current logic, `ui.rs` keeps its layout. Only `palette.rs`'s function bodies change, plus one one-line `Style` addition in `render_transcript`'s user-message branch.

## Goal

Make the bakudo TUI legible across light and dark terminal themes by adopting codex's ANSI-named-color scheme and terminal-bg-aware tint mechanism, without changing any rendering logic.

## Non-goals (Phase 1)

- Inline rendering / dropping the alt-screen — that's Phase 4.
- Restructuring the chat-cell vocabulary (`▶ you` / `· info` / `✗ err`) — that's Phase 2.
- Changing the spinner frames, glyphs, layout, footer collapse logic, or the shelf widget.
- Changing `app.rs` event handling or message routing.

## Architecture

Three new modules in `crates/bakudo-tui/src/`, ported from codex (Apache-2.0, same as bakudo):

| File | LOC | Source |
|---|---|---|
| `color.rs` | ~110 | `codex-rs/tui/src/color.rs` (verbatim) |
| `terminal_palette.rs` | ~500 | `codex-rs/tui/src/terminal_palette.rs` minus the `query_background_color`/`query_foreground_color` calls; plus a hand-rolled `query_osc_color(code: u8)` helper (~80-100 LOC) using vanilla crossterm 0.27's raw mode + a stdin reader thread with a 100ms timeout; otherwise the cache, `default_colors()`, `requery_default_colors()`, `best_color`, `xterm_fixed_colors`, and the 256-entry `XTERM_COLORS` table are ported verbatim |
| `style.rs` | ~50 | `codex-rs/tui/src/style.rs` (verbatim) |

Each ported file gets a one-line header comment crediting `codex-rs` and the Apache-2.0 license inheritance.

`palette.rs` keeps every existing public function signature; only the bodies change. Call sites in `ui.rs` and `app.rs` see no API change.

`lib.rs` gains three `pub mod` declarations.

`Cargo.toml` (workspace) gains:
```toml
supports-color = "3"
```

`crates/bakudo-tui/Cargo.toml` adds `supports-color.workspace = true` to its `[dependencies]`.

## Color mapping

The "Pragmatic" palette: cyan, green, red, magenta as the four primary semantic hues; blue allowed where it has clear informational value; yellow not used; no custom RGB except via terminal-bg-aware blends.

| Bakudo slot (function in `palette.rs`) | Today (RGB constant) | New (returned `Style` or `Color`) |
|---|---|---|
| `focus_border()` | SKY_400 | `Color::Cyan` |
| `dim_border()` | GRAY_600 | `Color::Reset` returned, callers continue to wrap in `Style::default().dim()` via existing `dim_style()` helper. *(See note 1.)* |
| `header_bg()` | GRAY_900 | **removed** — bg fill dropped from header. *(See note 2.)* |
| `header_fg()` | GRAY_200 | `Color::Reset` |
| `footer_fg()` | GRAY_500 | `Color::Reset` (callers add `.dim()` via existing helper) |
| `hint_key_fg()` | GRAY_400 | `Color::Reset` (callers add `.bold()` via existing `hint_key` helper) |
| `role_user_fg()` | EMERALD_400 | `Color::Cyan` |
| `role_system_fg()` | AMBER_400 | `Color::Magenta` |
| `role_agent_fg()` | GRAY_200 | `Color::Reset` |
| `role_error_fg()` | RED_400 | `Color::Red` |
| `role_info_fg()` | BLUE_400 | `Color::Blue` |
| `role_mission_fg()` | FUCHSIA_500 | `Color::Magenta` (live-tree only; renders the `◆ plan` row in `render_transcript` per the `MessageRole::Mission` arm at `ui.rs:337`) |
| `provider_accent()` | VIOLET_500 | `Color::Magenta` |
| `model_accent()` | EMERALD_400 | `Color::Green` |
| `shelf_running()` | EMERALD_400 | `Color::Cyan` |
| `shelf_preserved()` | AMBER_400 | `Color::Green` |
| `shelf_merged()` | BLUE_400 | `Color::Blue` |
| `shelf_discarded()` | GRAY_500 | `Color::Reset` (callers add `.dim()`) |
| `shelf_failed()` | RED_400 | `Color::Red` |
| `shelf_conflicts()` | FUCHSIA_500 | `Color::Magenta` |
| `shelf_timed_out()` | ORANGE_500 | `Color::Red` (caller-side `.dim()`) |
| `shelf_selected_bg()` | GRAY_800 | terminal-bg-aware: `style::user_message_bg(default_bg())` returns `Color::Rgb(blended)` if bg known, else `Color::Reset`. |
| `diff_added()` | EMERALD_400 | `Color::Green` |
| `diff_removed()` | RED_400 | `Color::Red` |
| `diff_hunk()` | BLUE_400 | `Color::Cyan` (codex hunk-header convention) |

**Note 1 — `dim_border()` and friends:** Today, `dim_border()` returns a `Color` (GRAY_600); `dim_style()` returns a `Style` based on it; `unfocused_border_style()` returns `Style::default().fg(dim_border())` (no dim modifier).

After the change:

- `dim_border()` returns `Color::Reset` (no carried modifier — `Color` cannot carry one).
- `dim_style()` returns `Style::default().add_modifier(Modifier::DIM)`.
- `unfocused_border_style()` returns `Style::default().add_modifier(Modifier::DIM)` (i.e., adds the dim modifier where it used to rely on a hardcoded gray fg).

Direct callers of `dim_border()` in `ui.rs` (currently: the composer's `> ` prompt span and a few "small dim text" spots) are migrated to call `dim_style()` instead. This is a 2-3 line `ui.rs` edit, listed explicitly in the implementation order. After migration, all "should look dim" sites carry the dim modifier instead of relying on a specific gray RGB.

**Note 2:** `render_header` in `ui.rs:232-234` currently does `Paragraph::new(...).style(Style::default().bg(palette::header_bg()))`. This bg fill is removed (the call to `.style(...)` is dropped). The header text — already styled with bold for `bakudo v2` — will read on the user's terminal background. This makes the header visually "lift" naturally rather than fighting the theme.

## New behaviour: user-row background tint

This is the only rendering-logic change in Phase 1.

In `ui.rs::render_transcript` (around lines 332-366), when a message has `MessageRole::User`, the entire row gets a soft background tint via `style::user_message_style()`. The tint is:

- 4% black-on-bg if the terminal background is light;
- 12% white-on-bg if the terminal background is dark;
- absent if `default_bg()` returns `None` (terminal didn't respond to OSC 11).

Implementation: at the existing `MessageRole::User` branch, compute the bg style once per message via `crate::style::user_message_style()` and apply it as the `Line.style` for each pushed line of that message.

This matches codex's user-message visual: a near-invisible row tint that subtly groups multi-line user input without being chrome.

## Edge cases

- **No OSC 11 support** (Windows console, mosh, dumb terminals): `terminal_palette::default_bg()` returns `None`. `style::user_message_style()` returns `Style::default()` — no tint, no harm.
- **Slow terminal**: codex's `terminal_palette` queries OSC 11 once at startup with a 100 ms timeout via a spawned reader thread. Bakudo inherits this. Worst case: the first frame has no tint; subsequent frames pick it up once the reply arrives (or after the timeout, the absence is cached and the path stays fallback).
- **16- or 256-color terminal**: `color::best_color` (already in the ported file) snaps RGB to nearest palette entry via Lab perceptual distance (`color::perceptual_distance`). The blend output stays usable.
- **Terminal multiplexers (tmux, screen, zellij)**: codex's `terminal_palette.rs` already handles passthrough quirks (the file references zellij specifically). Bakudo inherits.
- **Tests run without a terminal**: `default_bg()` returns `None` in CI; the existing 27 tests check rendered byte sequences, not the bg blend, so they pass unchanged.

## Testing

**Existing:** all 27 tests in `crates/bakudo-tui` must pass without modification.

**New:** one regression test in `palette.rs::tests` that calls every public `palette::*` function and asserts it returns without panicking and yields a non-default value where expected. Cheap insurance against an accidental signature break in a future refactor.

**Manual visual verification (per BAKUDO_TUI_FIX_PROMPT.md style):** boot the rebuilt TUI under tui-use at 140×40 and 80×30, capture screen, confirm:
- Header text reads on the terminal bg (no header bg fill).
- The `▶ you` row (after dispatching a prompt) has a faintly tinted background row.
- Error rows render in red, info rows in blue, system rows in magenta.
- The shelf entries show distinct colors for `running` (cyan), `preserved` (green), `merged` (blue), `failed` (red), `conflicts` (magenta).
- Slash popup, `/help` modal, footer hints all read cleanly.
- Ctrl+C exits cleanly (terminal restored).

## Implementation order (for the writing-plans phase)

1. Add `supports-color` to workspace + bakudo-tui Cargo.toml.
2. Port `color.rs` (file copy + license header). Verify it builds standalone (`cargo check -p bakudo-tui`).
3. Port `terminal_palette.rs` (file copy + license header + adjust internal `use` paths). Verify build.
4. Port `style.rs` (file copy + license header). Verify build.
5. Add `pub mod` declarations to `lib.rs`. Verify build.
6. Rewrite `palette.rs` body per the mapping table. Update `dim_style()` and `unfocused_border_style()` to carry `Modifier::DIM` (per Note 1). Run `cargo test -p bakudo-tui`. All 27 should pass.
7. Migrate the 2-3 direct callers of `palette::dim_border()` in `ui.rs` to use `palette::dim_style()` instead (per Note 1). Re-run tests.
8. Drop the bg fill in `render_header` (single-line edit in `ui.rs`).
9. Apply `user_message_style()` to user-row lines in `render_transcript`.
10. Add the regression test in `palette.rs::tests` (the 28th test).
11. `cargo fmt && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`. Must be clean.
12. Manual visual check via tui-use (verification step from BAKUDO_TUI_FIX_PROMPT.md).
13. Commit each numbered step with a `refactor(tui):` or `feat(tui):` prefix per bakudo convention.

## Out of scope (deferred to later phases)

- **Phase 2** — port `key_hint.rs` and `shimmer.rs`; rebuild the status indicator using codex's `• Working ({elapsed} • esc to interrupt)` pattern with shimmered "Running" text.
- **Phase 3** — port `bottom_pane/footer.rs`'s width-aware collapse with snapshot tests.
- **Phase 4** — drop alt-screen, render assistant output into the user's terminal scrollback via a port of `insert_history.rs` and `custom_terminal.rs`. The architectural shift.
- **Phase 5** — unify the slash popup, `/model` picker, and approval prompt under codex's `selection_popup_common.rs` pattern.

## Risks

- **OSC 11 timeout might delay first paint by up to 100 ms.** Mitigation: codex has shipped this for ~year; the 100 ms is a hard ceiling, not a floor; query is async/non-blocking on the render path.
- **A terminal that responds to OSC 11 with garbage could trip a parser bug.** Mitigation: the ported parser is fuzzed in codex; we don't modify it. If a user reports a hang, the fallback path (return `None`) is one match arm away.
- **Removing the header bg fill changes the visual identity of the TUI.** Acceptable because the goal is to look like codex; if the user dislikes the change after seeing it live we can re-add a 1-row bold rule under the header text instead.
