# TUI Status + Footer Codex Port — Design

**Date:** 2026-04-25
**Branch:** `feature/tui-phase23` (cut from `origin/main` in the live `bakudo-codex-full` tree)
**Phases:** 2 and 3 of the bakudo-vs-codex polish plan
**Estimated size:** ~450 LOC added (`key_hint.rs`, `shimmer.rs`, `status_indicator.rs`, `footer.rs`), ~120 LOC rewritten in `ui.rs`, no daemon/runtime changes

**Crossterm / ratatui compatibility note:** unlike Phase 1's OSC 11 work, Phases 2 and 3 do **not** require the nornagon crossterm fork. `key_hint.rs`, `shimmer.rs`, and the footer-collapse logic all fit bakudo's current `crossterm = "0.27"` / `ratatui = "0.26"` stack with only local path adjustments. No new runtime dependency is required.

## Context

Phase 1 landed the ANSI palette and terminal-bg-aware tinting. The next two polish gaps are both in `crates/bakudo-tui/src/ui.rs`:

1. The live status strip is still a bakudo-specific row (`spinner + count + latest note`) rather than codex's compact in-progress status language.
2. The footer is still a hardcoded one-line span list with no width-aware collapse policy. At narrow widths it either lies (`Tab: inspect shelf` when the shelf is hidden) or degrades awkwardly as spans run together.

Codex already solved both classes of problem:

- `key_hint.rs` and `shimmer.rs` provide the small rendering primitives for subtle inline affordances and animated status text.
- `status_indicator_widget.rs` shows the compact `• Working ({elapsed} • esc to interrupt)` pattern.
- `bottom_pane/footer.rs` contains a width-aware collapse strategy that chooses the best-fitting hint line instead of blindly drawing everything.

This phase ports the useful parts of those surfaces into bakudo while staying inside the existing TUI architecture. No alt-screen, scrollback, event-loop, or daemon changes are part of this work.

## Goal

Bring bakudo's status row and footer up to the codex visual standard by:

- replacing the current spinner/count strip with a codex-style animated running row;
- making footer hints width-aware so the line stays truthful and readable on both wide and narrow terminals.

## Non-goals

- Dropping alt-screen or rendering transcript history into terminal scrollback. That remains Phase 4.
- Unifying slash popup, `/model`, and approval prompts. That remains Phase 5.
- Reworking transcript layout, message vocabulary, or shelf information density beyond what the new status row and footer require.
- Adding daemon fields or changing `SessionEvent` payloads.
- Pulling in codex's full bottom-pane state machine. Bakudo keeps its simpler `Chat` / `Shelf` focus model.

## Architecture

### New modules

Three codex-inspired modules are added under `crates/bakudo-tui/src/`:

| File | Source | Shape |
|---|---|---|
| `key_hint.rs` | `codex-rs/tui/src/key_hint.rs` | near-verbatim port; owns `KeyBinding`, formatting helpers, and `Span` conversion |
| `shimmer.rs` | `codex-rs/tui/src/shimmer.rs` | near-verbatim port; uses Phase 1's terminal palette helpers to animate text without introducing a new timing loop |
| `status_indicator.rs` | `codex-rs/tui/src/status_indicator_widget.rs` | bakudo-scoped adaptation; ports compact elapsed formatting, shimmered header text, inline interrupt hint, and width truncation, but not codex's frame-requester/details widget layers |

Phase 3 adds one bakudo-specific adapter module:

| File | Source | Shape |
|---|---|---|
| `footer.rs` | `codex-rs/tui/src/bottom_pane/footer.rs` | selective port of the width-aware collapse pattern; keeps bakudo's simpler hint vocabulary and no right-side context line |

Each new file gets a short provenance header noting the codex source and Apache-2.0 license compatibility.

### Status row behavior (Phase 2)

The current row:

```text
⠋  2 running · [02bf30c1] Booting sandbox…
```

becomes a codex-style row:

```text
• Running (3s • esc to interrupt) · 2 sandboxes active · [02bf30c1] Booting sandbox…
```

with these rules:

- The leading marker is codex's `•`, not bakudo's braille spinner. The motion comes from the shimmer over `Running`.
- The shimmered header text is **`Running`**, not `Working`, because the row is tied specifically to live sandbox tasks.
- The elapsed timer is derived from the **oldest currently running shelf entry** so it reflects how long the UI has been busy overall.
- If shelf data lags but `active_task_count > 0`, the row still renders with `0s` and no task-specific suffix rather than disappearing.
- The compact interrupt hint uses `key_hint::plain(KeyCode::Esc)` so Phase 2 already benefits from the shared key-hint formatter.
- Inline suffix text preserves bakudo's useful local context:
  - when `count == 1`: `· [short-id] {latest_note}`;
  - when `count > 1`: `· {count} sandboxes active · [short-id] {latest_note}`.
- The entire line is truncated from the right with an ellipsis when it overflows.

The shelf continues using `palette::spinner_frame()` for row-local running markers. Phase 2 only changes the status strip above the composer.

### Footer behavior (Phase 3)

The footer remains a single line, but its rendering moves out of `ui.rs` into a dedicated `footer.rs` module that applies codex-style best-fit selection instead of unconditional span concatenation.

Bakudo keeps four logical footer variants:

1. `ChatSlash` — chat focus and `input.starts_with('/')`
2. `ChatShelf` — chat focus, non-slash input, shelf visible
3. `ChatPlain` — chat focus, non-slash input, shelf hidden
4. `Shelf` — shelf focus

Each variant is modeled as an ordered list of `FooterItem { key, label, priority }`, rendered through `key_hint.rs`.

### Collapse policy

The collapse policy is adapted from codex's `single_line_footer_layout` pattern:

1. Start with the fullest truthful line for the current variant.
2. Try a shortened-label variant before dropping the hint entirely.
3. If the full line still does not fit, drop the lowest-priority hint and retry.
4. Never show a hint for UI that is currently unavailable.
5. Keep at least one actionable hint visible in every state.

Concrete rules:

- `Tab: inspect shelf` is only ever available when the shelf is actually visible.
- `Tab: inspect shelf` may shorten to `Tab: shelf` before being dropped.
- `/help: commands` may shorten to `/help: help` before being dropped.
- `Tab/Esc: back to chat` may shorten to `Tab/Esc: chat` before being dropped.
- Chat footer priority is: `Enter`, context-specific `Tab`, `PgUp/Dn`, `Ctrl+C`, `/help`.
- Shelf footer priority is: `Tab/Esc`, `j/k`, `a`, `d`.
- Final fallbacks are:
  - chat: `Enter: send`
  - shelf: `Tab/Esc: chat`

This fixes the existing narrow-width lie and gives Phase 3 a stable structure for later popup/prompt unification work.

## File map

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/key_hint.rs` | CREATE | ported codex key hint formatter |
| `crates/bakudo-tui/src/shimmer.rs` | CREATE | ported codex shimmer helper |
| `crates/bakudo-tui/src/status_indicator.rs` | CREATE | bakudo-specific codex-style status row renderer |
| `crates/bakudo-tui/src/footer.rs` | CREATE | bakudo-specific width-aware footer collapse adapter |
| `crates/bakudo-tui/src/lib.rs` | MODIFY | add module declarations |
| `crates/bakudo-tui/src/ui.rs` | MODIFY | delegate status/footer rendering to the new modules |

No changes are expected in `src/main.rs`, the daemon, or workspace manifests.

## Testing

### Automated

- Add unit tests for compact elapsed formatting in `status_indicator.rs`.
- Add render tests that verify the status row includes:
  - `• Running`
  - the compact elapsed segment
  - the `esc to interrupt` hint
  - truncation when width is small.
- Add snapshot-style footer tests that render exact one-line outputs at representative widths for:
  - chat + slash input
  - chat + shelf visible
  - chat + shelf hidden
  - shelf focus.

To keep scope small, the snapshot coverage uses the existing `TestBackend` + exact rendered-string assertions already present in `ui.rs`; no new snapshot framework is required.

### Manual

Under `tui-use`, verify at `140x40` and `80x30`:

- the running row reads as codex-style status text, not the old spinner/count strip;
- `Running` visibly shimmers;
- `esc to interrupt` appears inline and the app exits cleanly after `Ctrl+C`;
- the footer does not mention the shelf when the shelf is hidden;
- the footer collapses cleanly instead of turning into a packed unreadable line.

## Risks

- **Shimmer snapshot fragility.** The shimmer animation changes style, not text, so tests must assert symbols/content rather than colorized terminal escapes.
- **Elapsed timer ambiguity with multiple tasks.** Using the oldest running entry gives stable "busy since" behavior, but it should be called out explicitly so a later Phase 4 refactor does not accidentally switch to "latest task age".
- **Width thresholds are easy to regress.** Phase 3 therefore needs exact bottom-row snapshots at multiple widths, not just `contains(...)` assertions.

## Out of scope after this branch

- **Phase 4** — drop alt-screen and render assistant output into terminal scrollback via a port of `insert_history.rs` and `custom_terminal.rs`.
- **Phase 5** — unify slash popup, `/model`, and approval prompt under codex's `selection_popup_common.rs` pattern.
