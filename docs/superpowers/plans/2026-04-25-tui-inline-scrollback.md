# TUI Inline Scrollback Port Implementation Plan

> **For agentic workers:** use subagents for bounded review and verification tasks, but keep the main integration in the parent agent because `src/main.rs`, `app.rs`, and `ui.rs` all move together in this phase.

**Goal:** Complete Phase 4 by dropping alt-screen mode and replaying transcript history into terminal scrollback above a compact live viewport.

**Architecture:** Stay on `ratatui 0.26`, use `Terminal::with_options(... Viewport::Inline(height))` plus `Terminal::insert_before(...)`, add a reusable history formatter, queue pending transcript messages in `app.rs`, remove transcript-pane ownership from `ui.rs`, and wire the inline terminal path through `src/main.rs`.

**Tech stack:** Rust 2024 for `bakudo-tui`, `crossterm 0.27`, existing workspace `ratatui 0.26`, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-25-tui-inline-scrollback-design.md`

**Scope:** `crates/bakudo-tui/src/`, `src/main.rs`, the workspace + crate `Cargo.toml` files, and docs.

---

## File map

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/history_render.rs` | CREATE | reusable transcript-row formatter |
| `crates/bakudo-tui/src/insert_history.rs` | CREATE | inline scrollback insertion helper |
| `crates/bakudo-tui/src/app.rs` | MODIFY | pending-history queue and inline clear semantics |
| `crates/bakudo-tui/src/ui.rs` | MODIFY | remove transcript pane; render compact inline context |
| `crates/bakudo-tui/src/footer.rs` | MODIFY | drop transcript-scroll hints |
| `crates/bakudo-tui/src/commands.rs` | MODIFY | inline-mode wording for `/clear` and `/new` |
| `crates/bakudo-tui/src/lib.rs` | MODIFY | export only the modules Phase 4 actually uses |
| `src/main.rs` | MODIFY | raw-mode-only guard and inline viewport event loop |
| `Cargo.toml` | MODIFY | keep dependency set minimal |
| `crates/bakudo-tui/Cargo.toml` | MODIFY | keep dependency set minimal |

---

## Task 1: Lock the dependency baseline and remove abandoned scaffolding

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/bakudo-tui/Cargo.toml`
- Modify: `crates/bakudo-tui/src/lib.rs`

- [ ] Confirm that `ratatui 0.26` already provides the required inline viewport and insertion APIs.
- [ ] Remove unused `custom_terminal`, `wrapping`, and `test_backend` module slots.
- [ ] Remove any speculative dependencies that are no longer needed.
- [ ] Commit:

```bash
git add Cargo.toml Cargo.lock crates/bakudo-tui/Cargo.toml crates/bakudo-tui/src/lib.rs
git commit -m "chore(tui): align phase 4 scaffolding with ratatui inline mode"
```

## Task 2: Extract transcript-to-scrollback formatting

**Files:**
- Create: `crates/bakudo-tui/src/history_render.rs`

- [ ] Move the former transcript-row formatting rules into a reusable helper.
- [ ] Preserve timestamp gutter, role label/glyph, continuation indentation, user-row tint, and diff-aware coloring.
- [ ] Add focused unit tests for wrapped continuations and diff-like payloads.
- [ ] Commit:

```bash
git add crates/bakudo-tui/src/history_render.rs
git commit -m "refactor(tui): extract inline history row formatting"
```

## Task 3: Add inline scrollback insertion

**Files:**
- Create: `crates/bakudo-tui/src/insert_history.rs`

- [ ] Implement a thin `Terminal::insert_before(...)` adapter.
- [ ] Render queued messages at full terminal width.
- [ ] Add at least one terminal-level test that proves history is inserted above the inline viewport.
- [ ] Commit:

```bash
git add crates/bakudo-tui/src/insert_history.rs
git commit -m "feat(tui): insert transcript history into scrollback"
```

## Task 4: Queue transcript messages for inline emission

**Files:**
- Modify: `crates/bakudo-tui/src/app.rs`

- [ ] Add `pending_history: VecDeque<ChatMessage>`.
- [ ] Queue messages in `push_message()`.
- [ ] Seed the queue from `load_transcript()` on resume.
- [ ] Ensure `/clear` and `/new` clear local history state without claiming to erase terminal scrollback.
- [ ] Commit:

```bash
git add crates/bakudo-tui/src/app.rs
git commit -m "refactor(tui): queue pending history for inline mode"
```

## Task 5: Remove transcript-pane ownership from the live viewport

**Files:**
- Modify: `crates/bakudo-tui/src/ui.rs`
- Modify: `crates/bakudo-tui/src/footer.rs`
- Modify: `crates/bakudo-tui/src/commands.rs`

- [ ] Replace the boxed transcript pane with compact inline-context copy.
- [ ] Remove `PgUp/Dn: scroll` from footer and help text.
- [ ] Make `/clear` and `/new` wording truthful for inline mode.
- [ ] Keep existing shelf, status row, and composer behavior intact.
- [ ] Commit:

```bash
git add crates/bakudo-tui/src/ui.rs crates/bakudo-tui/src/footer.rs crates/bakudo-tui/src/commands.rs
git commit -m "refactor(tui): remove transcript pane for inline mode"
```

## Task 6: Switch runtime wiring to the inline terminal path

**Files:**
- Modify: `src/main.rs`

- [ ] Remove `EnterAlternateScreen` / `LeaveAlternateScreen`.
- [ ] Build the terminal with `Viewport::Inline(...)`.
- [ ] Flush `pending_history` before each draw.
- [ ] Keep cursor restoration on exit.
- [ ] Size the viewport generously enough for the worst normal composer case.
- [ ] Commit:

```bash
git add src/main.rs
git commit -m "feat(tui): run the TUI in inline scrollback mode"
```

## Task 7: Run full automated validation

- [ ] Run `cargo fmt`
- [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] Run `cargo test --workspace`
- [ ] If needed, fix any regressions before proceeding.

## Task 8: Perform visual verification and stop for review

- [ ] Use `tui-use` to verify the inline viewport at `140x40`.
- [ ] Use `tui-use` to verify the inline viewport at `80x30`.
- [ ] Confirm clean exit in both sessions.
- [ ] Stop after reporting results. Do not push, merge, or open a PR.
