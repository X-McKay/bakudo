# TUI Inline Scrollback Port — Design

**Date:** 2026-04-25  
**Branch:** `feature/tui-phase4-scope` (cut from local `main` after Phases 2 and 3 were merged at `3e339b2`)  
**Phase:** 4 of the bakudo-vs-codex polish plan  
**Estimated size:** ~900-1300 LOC added/rewritten across `custom_terminal.rs`, `insert_history.rs`, transcript formatting reuse, `ui.rs`, `app.rs`, and `src/main.rs`

**Compatibility note:** Phase 4 is not a straight file copy. Codex's `custom_terminal.rs` targets a newer `ratatui` backend API than bakudo's pinned `ratatui = "0.26"`:

- codex uses `Backend::get_cursor_position` / `set_cursor_position`; bakudo has `get_cursor` / `set_cursor`
- codex uses `Backend::size() -> Size`; bakudo has `Backend::size() -> Rect`
- codex's surrounding `tui.rs` relies on backend `scroll_region_up/down` helpers that do not exist in ratatui 0.26

Bakudo should adapt the port locally instead of bumping ratatui or pulling in codex's full TUI stack. `crossterm = "0.27"` is sufficient for the raw ANSI work (`DECSTBM`, reverse index, clears, cursor saves/restores).

**Transitive codex surface area note:** `insert_history.rs` also depends on `wrapping.rs`, and its tests depend on `test_backend.rs`. Bakudo does not have those modules today, so Phase 4 needs a reduced URL-aware wrapping helper plus a VT100-backed test backend. This is the main hidden scope beyond the two reference files named in the original phase list.

## Context

Phases 1 through 3 brought bakudo's colors, status row, and footer close to codex, but the TUI still behaves like a traditional alt-screen application:

- `src/main.rs::TerminalGuard` enters the alternate screen on startup and leaves it on exit.
- `ui.rs` renders a bordered transcript pane inside the viewport.
- `app.rs` owns transcript scrolling via `scroll_offset` and `PgUp` / `PgDn`.
- When the app exits, the visible conversation disappears with the alt-screen.

Codex's bigger architectural move is different: it keeps a compact live viewport near the bottom of the terminal and writes completed chat history into the user's normal terminal scrollback above it. That gives the user shell-native persistence, normal terminal copy/search behavior, and a UI that feels lighter because the "conversation" no longer has to fit inside a boxed transcript widget.

That is the defining change for Phase 4. It is also the first phase that must touch `src/main.rs`, not just `crates/bakudo-tui/src/`.

## Goal

Drop alt-screen mode and move transcript rendering into normal terminal scrollback, while preserving bakudo's interactive affordances:

- header
- optional shelf
- running-status row
- composer
- footer
- overlays/prompts

The bottom viewport remains a live control surface. Conversation history lives above it in terminal scrollback.

## Non-goals

- Reworking daemon/session-controller protocol.
- Changing transcript wording or message-role colors beyond what inline history requires.
- Porting codex's entire `tui.rs` orchestration layer or bottom-pane architecture.
- Unifying slash popup, `/model`, and approval UI under codex's selection-popup pattern. That remains Phase 5.
- Replacing bakudo's transcript persistence format (`TranscriptStore` JSONL).
- Introducing a runtime toggle between alt-screen and inline mode in Phase 4. Phase 4 is the inline-mode switch.

## Key decisions

### 1. Inline history should include all transcript messages, not only assistant output

The original phase note says "render assistant output into the user's terminal scrollback", but the codex pattern is broader: once the transcript pane is gone, the user still needs to see user/system/info/error chronology in one place.

Phase 4 should therefore insert every newly appended `ChatMessage` into scrollback:

- `User`
- `System`
- `Mission`
- `AgentOutput`
- `Error`
- `Info`

Assistant output is the most visible beneficiary, but not the only one.

### 2. Scrollback history should use full terminal width

The current transcript pane wraps to the main chat column width because the shelf occupies the right side of the alt-screen layout. In inline mode, emitted history lines sit above the whole viewport, so they should wrap to the full terminal width, not the old chat-column width.

This avoids artificially narrow wrapping and keeps scrollback output readable even when the live shelf is visible below.

### 3. The boxed transcript pane should be removed from the live viewport

Keeping the old transcript pane and also inserting history into scrollback would duplicate content and spend most of the screen on a widget the terminal already provides natively.

Phase 4 should retire `render_transcript` from the normal viewport and reallocate the viewport to:

- header
- optional shelf
- status row
- composer
- footer
- overlays/help when active

### 4. `PgUp` / `PgDn` transcript scrolling should be removed from bakudo key handling

Once transcript content lives in terminal scrollback, bakudo no longer owns transcript scrolling. The footer/help text and global key handling must stop claiming that `PgUp` / `PgDn` scroll a pane that no longer exists.

Terminal-native scrollback remains the terminal emulator's job, not bakudo's.

## Architecture

### New modules

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/custom_terminal.rs` | CREATE | ratatui-0.26-adapted terminal wrapper derived from codex's `custom_terminal.rs`; owns inline viewport area, diff invalidation, cursor tracking, and clear helpers |
| `crates/bakudo-tui/src/insert_history.rs` | CREATE | scrollback insertion port derived from codex's `insert_history.rs`; owns `DECSTBM`/reverse-index path, Zellij fallback, and styled line emission |
| `crates/bakudo-tui/src/history_render.rs` | CREATE | bakudo-specific formatter that converts `ChatMessage` values into `Line<'static>` history rows for inline scrollback |
| `crates/bakudo-tui/src/wrapping.rs` | CREATE | reduced URL-aware wrapping helper extracted from codex; only the pieces `insert_history.rs` needs |
| `crates/bakudo-tui/src/test_backend.rs` | CREATE (test support) | VT100-backed backend for escape-sequence tests derived from codex's `test_backend.rs` |

### Modified files

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/lib.rs` | MODIFY | module declarations |
| `crates/bakudo-tui/src/app.rs` | MODIFY | add pending-history queue; remove transcript-scroll ownership |
| `crates/bakudo-tui/src/ui.rs` | MODIFY | remove transcript pane from normal viewport; update footer/help semantics for inline mode |
| `crates/bakudo-tui/src/footer.rs` | MODIFY | drop `PgUp/Dn: scroll` hints in inline mode |
| `src/main.rs` | MODIFY | remove alt-screen enter/leave; swap to custom terminal + inline history flush loop |
| `Cargo.toml` | MODIFY | likely add `textwrap` to workspace dependencies |
| `crates/bakudo-tui/Cargo.toml` | MODIFY | add `textwrap`; likely add `vt100` as a dev-dependency if tests port cleanly |

### Why `history_render.rs` exists

Today the transcript formatting logic lives inside `ui.rs::render_transcript`. Inline scrollback needs the same message styling without a ratatui transcript widget.

Phase 4 should extract "message -> rendered lines" into a reusable helper so both the inline-history path and any remaining render tests share the same formatting rules:

- timestamp gutter
- role glyph/label
- user-row tint
- diff-aware color handling
- wrapped continuation indentation

This keeps Phase 4 from forking transcript formatting in two places.

## Runtime design

### Terminal startup and shutdown

`src/main.rs::TerminalGuard` changes from:

- enable raw mode
- enter alt-screen
- enable bracketed paste/focus

to:

- enable raw mode
- enable bracketed paste/focus
- stay on the user's normal screen buffer

Shutdown still disables focus change, bracketed paste, and raw mode, and restores the cursor.

No `EnterAlternateScreen` / `LeaveAlternateScreen` calls remain in the Phase 4 interactive path.

### Custom terminal wrapper

Bakudo should use `bakudo_tui::custom_terminal::Terminal<CrosstermBackend<Stdout>>` in `run_tui` instead of `ratatui::Terminal`.

The adapted wrapper provides:

- a tracked `viewport_area`
- cursor-position tracking without relying on newer ratatui APIs
- diff-buffer invalidation after raw terminal mutations
- scrollback and visible-screen clear helpers
- a `draw` API compatible with bakudo's existing render loop

The port should stay narrower than codex's full wrapper:

- no alt-screen toggling helpers
- no codex frame-requester abstraction
- no dependency on codex's `tui.rs`

### Pending history queue

`App` should gain a queue for transcript messages that have been appended but not yet emitted into scrollback.

Recommended shape:

```rust
pending_history: VecDeque<ChatMessage>
```

Behavior:

- `push_message()` continues to append to `transcript` and `TranscriptStore`
- `push_message()` also pushes a clone into `pending_history`
- `load_transcript()` on resume seeds `pending_history` with the loaded ring so the session is replayed into scrollback once
- the event loop drains `pending_history`, converts messages into `Vec<Line<'static>>` with `history_render.rs`, and hands them to `insert_history`

This keeps scrollback emission incremental and avoids coupling terminal writes to every call site that creates a `ChatMessage`.

### Viewport height

Inline mode needs a dynamic viewport height, because the old transcript pane is gone and overlays may need extra room.

Normal viewport target:

- `HEADER_HEIGHT`
- optional shelf area
- optional running-status row
- composer height
- footer height

Expanded viewport target:

- approval prompt
- question prompt
- help overlay
- completion popup if needed

The simplest Phase 4 rule is: recompute desired viewport height every frame from current app state, clamp to screen height, and update the inline viewport before drawing.

This is one of the reasons Phase 4 belongs partly in `src/main.rs`.

### Inline history insertion

`insert_history.rs` should be ported nearly verbatim in behavior, but adapted for bakudo's stack:

- use the custom terminal wrapper instead of codex's
- convert ratatui-0.26 backend size/cursor APIs
- keep `SetScrollRegion` / `ResetScrollRegion`
- keep the Zellij fallback mode

Recommended runtime selection:

```rust
let is_zellij = std::env::var_os("ZELLIJ").is_some();
```

Use `InsertHistoryMode::Zellij` when set, `Standard` otherwise.

### URL-aware wrapping

This is the main hidden dependency from codex.

If Phase 4 writes long URLs into terminal scrollback using naive character wrapping, terminals will often fail to detect them as clickable links. Codex solves this with `wrapping.rs`.

Bakudo should port a reduced subset:

- `RtOptions`
- `adaptive_wrap_line`
- `line_contains_url_like`
- `line_has_mixed_url_and_non_url_tokens`

Not the whole codex render stack.

That likely introduces `textwrap` as the only new runtime dependency Phase 4 truly needs.

### Resume behavior

Resumed sessions must rehydrate visible history into scrollback. Otherwise the user resumes into a compact viewport with no visible transcript context.

Phase 4 should:

1. load the persisted transcript ring as it does today;
2. queue those messages into `pending_history`;
3. let the event loop replay them above the viewport before the first stable frame.

The replay should be bounded by the existing in-memory transcript cap, not by the entire session log on disk.

## UI changes

### Viewport layout

The old viewport:

- header
- transcript
- status
- composer
- footer
- optional shelf

becomes:

- header
- body with compact main controls and optional shelf
- status
- composer
- footer

There is no bordered transcript box in normal operation.

### Footer and help text

Because bakudo no longer owns transcript scrolling:

- remove `PgUp/Dn: scroll` from footer variants
- update `/help` copy that currently says `PgUp / PgDn: scroll the transcript`
- adjust any tests that assert the older footer strings

No replacement key is required; the footer simply becomes more honest and shorter.

### Scroll indicator

The transcript scroll indicator in the top-right of the transcript pane goes away with the pane.

`scroll_offset` and its UI should be deleted unless some later inline-specific use emerges. Phase 4 should not keep dead scroll state around "just in case".

## Testing

### Automated

Phase 4 needs more than ordinary render tests because it is manipulating terminal state outside ratatui's normal diff model.

Required coverage:

1. `custom_terminal.rs`
   - cursor tracking
   - viewport resize bookkeeping
   - diff invalidation after out-of-band writes
2. `insert_history.rs`
   - standard insertion mode inserts lines above the viewport
   - multi-row wrapped lines preserve color across continuation rows
   - URL-like lines are not hard-split in the middle of a link token
   - Zellij mode shifts the viewport using raw newlines and then invalidates correctly
3. `history_render.rs`
   - role prefixes/gutters match today's transcript formatting
   - continuation indent is preserved
   - user-message tint and diff-aware styles survive formatting
4. `ui.rs` / `footer.rs`
   - footer/help strings no longer mention transcript scrolling
   - compact inline layout still renders cleanly with and without the shelf

For terminal escape tests, bakudo should port codex's `VT100Backend` helper and add `vt100` as a dev-only dependency if needed.

### Manual

Under `tui-use`, verify at `140x40` and `80x30`:

- bakudo starts without entering alt-screen
- assistant/user/info/error output appears in terminal scrollback above the live viewport
- the live viewport stays anchored near the bottom as new output arrives
- footer text no longer advertises transcript scrolling
- resize does not smear the viewport
- `Ctrl+C` exits cleanly and leaves the history visible in the terminal

## Risks

- **Ratatui 0.26 API mismatch is real scope, not noise.** The codex port cannot be pasted in whole. Mitigation: adapt locally and avoid a ratatui version bump in this phase.
- **Overlay height can force the viewport to expand mid-session.** If that resize path is wrong, the diff buffer will desync or stale rows will remain on screen. Mitigation: centralize viewport-height computation in one helper and invalidate after raw scroll operations.
- **Resume replay can flood the terminal with many historical lines.** Mitigation: replay only the existing transcript ring, not unbounded history; keep inserts batched.
- **Terminal compatibility varies across tmux, Zellij, Warp, and Terminal.app.** Mitigation: keep codex's Zellij fallback and preserve the ANSI clear helpers from `custom_terminal.rs`.
- **Footer/help semantics can regress silently.** Mitigation: exact string tests for footer rows and help-copy lines need to be updated as part of the phase, not as cleanup afterward.

## Out of scope after this branch

- **Phase 5** — unify the slash popup, `/model` picker, and approval prompt under codex's `selection_popup_common.rs` pattern.
