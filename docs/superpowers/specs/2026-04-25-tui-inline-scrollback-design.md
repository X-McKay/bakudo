# TUI Inline Scrollback Port — Design

**Date:** 2026-04-25  
**Branch:** `feature/tui-phase4-scope` (cut from local `main` after Phases 2 and 3 were merged at `3e339b2`)  
**Phase:** 4 of the bakudo-vs-codex polish plan  
**Estimated size:** ~500-800 LOC across `history_render.rs`, `insert_history.rs`, `app.rs`, `ui.rs`, `footer.rs`, `commands.rs`, and `src/main.rs`

## Implementation choice

Phase 4 will stay on `ratatui 0.26`.

Bakudo already has the two terminal primitives the smaller inline-scrollback port needs:

- `Terminal::with_options(... Viewport::Inline(height))`
- `Terminal::insert_before(...)`

That means the first Phase 4 implementation does **not** need:

- a `ratatui` bump,
- a port of codex's `custom_terminal.rs`,
- a reduced `wrapping.rs`,
- or a VT100-backed backend helper.

If visual verification later shows a real terminal-compatibility gap, those remain valid follow-up options. They are not required for the first implementation.

## Context

Phases 1 through 3 aligned bakudo's theme, status row, and footer with codex, but the TUI still behaves like a classic alternate-screen app:

- `src/main.rs::TerminalGuard` enters and leaves alt-screen.
- `ui.rs` renders a bordered transcript pane inside the live viewport.
- bakudo claims `PgUp` / `PgDn` to scroll that pane.
- the visible conversation disappears with the viewport on exit.

Codex's larger visual shift is to keep only a compact live control surface at the bottom of the terminal and write message history into the user's normal scrollback above it. That is the Phase 4 target.

## Goal

Drop alt-screen mode and replay transcript history into terminal scrollback while preserving bakudo's interactive bottom viewport:

- header
- optional shelf
- running-status row
- composer
- footer
- overlays and prompts

## Non-goals

- Reworking daemon or session-controller protocol.
- Porting codex's full terminal wrapper or raw ANSI scroll-region path.
- Adding new runtime dependencies solely to mirror codex internals.
- Replacing bakudo's JSONL transcript persistence format.
- Dynamic inline viewport resizing. `ratatui 0.26` exposes a fixed-height inline viewport, so the first pass will use a generous fixed height instead.
- Phase 5 popup unification work.

## Key decisions

### 1. Emit every `ChatMessage` role into scrollback

Once the boxed transcript pane is removed, bakudo still needs a coherent chronological history. Phase 4 therefore emits all transcript messages into scrollback, not only assistant output:

- `User`
- `System`
- `Mission`
- `AgentOutput`
- `Error`
- `Info`

### 2. Render history at full terminal width

Inserted history is no longer constrained by the old chat-column width. Scrollback rows should therefore wrap against the full terminal width returned by `Terminal::size()`.

### 3. Replace the transcript pane with compact inline context

The live viewport should no longer duplicate transcript content. Instead, the transcript area becomes a small centered context block that explains where history is going:

- idle without shelf activity: history is above the prompt
- running task: live output is above the prompt
- shelf populated: history is above the prompt and the shelf below stays interactive

### 4. Remove transcript-scroll ownership from bakudo

Bakudo must stop claiming that `PgUp` / `PgDn` scroll a transcript pane that no longer exists. Footer text, help text, and global key handling should all reflect that change.

### 5. Use a fixed inline viewport height sized for the worst normal case

`ratatui 0.26` inline viewports are fixed-height. For the first pass, Phase 4 should size the viewport to comfortably fit:

- header
- max-height composer
- footer
- status row
- a small amount of spare space for inline context and overlays

This keeps the implementation small while still covering the 140x40 and 80x30 validation targets.

## Architecture

### New files

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/history_render.rs` | CREATE | reusable `ChatMessage` -> `Vec<Line<'static>>` formatter for scrollback rows |
| `crates/bakudo-tui/src/insert_history.rs` | CREATE | thin adapter over `ratatui::Terminal::insert_before` |

### Modified files

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/app.rs` | MODIFY | add pending-history queue; clear local history state correctly in inline mode |
| `crates/bakudo-tui/src/ui.rs` | MODIFY | remove transcript pane and replace it with compact inline-context copy |
| `crates/bakudo-tui/src/footer.rs` | MODIFY | remove `PgUp/Dn: scroll` hints |
| `crates/bakudo-tui/src/commands.rs` | MODIFY | make `/clear` and `/new` descriptions truthful for inline mode |
| `crates/bakudo-tui/src/lib.rs` | MODIFY | export only the modules the chosen design actually uses |
| `src/main.rs` | MODIFY | remove alt-screen enter/leave; create inline viewport terminal; flush pending history each loop |
| `Cargo.toml` | MODIFY | no new dependencies required after choosing the built-in ratatui path |
| `crates/bakudo-tui/Cargo.toml` | MODIFY | no new dependencies required after choosing the built-in ratatui path |

## Runtime design

### Terminal startup and shutdown

`TerminalGuard` changes from:

- enable raw mode
- enter alt-screen
- enable bracketed paste and focus change

to:

- enable raw mode
- enable bracketed paste and focus change
- stay on the user's normal screen buffer

Shutdown still disables focus change, disables bracketed paste, restores the cursor, and exits raw mode.

### Pending-history queue

`App` gains a queue for transcript messages that have not yet been emitted into terminal scrollback:

```rust
pending_history: VecDeque<ChatMessage>
```

Behavior:

- `push_message()` appends to the on-disk transcript store as before
- `push_message()` also queues a clone into `pending_history`
- `load_transcript()` seeds `pending_history` on resume so saved history is replayed once
- the event loop drains `pending_history` before each draw and inserts it above the inline viewport

### Scrollback insertion

`insert_history.rs` stays deliberately small:

- ask the terminal for its current width,
- render queued messages with `history_render.rs`,
- call `Terminal::insert_before(...)` with the resulting row count,
- draw a `Paragraph<Text>` into the inserted buffer.

This keeps Phase 4 aligned with codex's visible behavior without bringing in codex's raw ANSI terminal machinery.

### Inline viewport layout

The live viewport keeps the existing bakudo controls, but the transcript pane is removed. The left main area becomes:

- header
- compact inline-context copy
- running-status row when active
- composer
- footer

The right shelf remains width-aware exactly as Phase 3 left it.

### Clear semantics

`/clear` and `/new` can only clear bakudo's local transcript state and pending queue. They cannot erase history already written into the user's terminal scrollback, so their descriptions and user-visible confirmation messages must say that explicitly.

### Resume behavior

On resume, bakudo should:

1. load the persisted transcript ring,
2. seed `pending_history` with those messages,
3. replay them into terminal scrollback before the first steady-state frame.

That preserves the user's local session context without bringing back the old boxed transcript pane.

## Testing strategy

- unit tests for `history_render.rs`
- inline terminal insertion test for `insert_history.rs`
- existing footer/UI/status tests updated for inline-mode expectations
- `cargo fmt`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- visual verification under `tui-use` at `140x40` and `80x30`, including clean exit

## Risks

- **Fixed-height inline viewport may feel tight with a max-height composer.** Mitigation: size the viewport for the worst normal composer case and verify visually at both target sizes.
- **Terminal scrollback interaction in raw mode varies by terminal and multiplexer.** Mitigation: bakudo no longer claims `PgUp` / `PgDn` ownership; the terminal remains responsible for any native scrollback affordances it supports.
- **Zellij/tmux-specific behavior may still surface.** Mitigation: if the built-in ratatui path proves insufficient in practice, a follow-up can revisit either a `ratatui` bump or a narrower custom terminal wrapper.
