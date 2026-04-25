# TUI Inline Scrollback Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 4 of the bakudo TUI codex-port by dropping alt-screen mode and replaying transcript history into terminal scrollback above a compact live viewport.

**Architecture:** Port an adapted `custom_terminal.rs` and `insert_history.rs` into `crates/bakudo-tui/src/`, add a bakudo-specific `history_render.rs` and reduced `wrapping.rs`, queue new transcript messages for inline emission in `app.rs`, remove transcript-pane ownership from `ui.rs`, and switch `src/main.rs::run_tui` to the custom inline terminal path.

**Tech stack:** Rust 2024 for `bakudo-tui`, workspace `ratatui 0.26`, `crossterm 0.27`, `textwrap` for reduced URL-aware wrapping, and likely `vt100` as a dev-dependency for terminal escape tests.

**Spec:** `docs/superpowers/specs/2026-04-25-tui-inline-scrollback-design.md`

**Scope:** `crates/bakudo-tui/src/`, `src/main.rs`, and the workspace + crate `Cargo.toml` files. This is the first codex-port phase that intentionally reaches into `src/main.rs`.

**Known compatibility constraint:** codex's terminal port assumes newer ratatui backend APIs (`get_cursor_position`, `set_cursor_position`, `Size`, scroll-region helpers). Bakudo must adapt the port to ratatui 0.26 instead of bumping ratatui.

---

## File map

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/custom_terminal.rs` | CREATE | ratatui-0.26-adapted inline terminal wrapper |
| `crates/bakudo-tui/src/insert_history.rs` | CREATE | scrollback insertion logic |
| `crates/bakudo-tui/src/history_render.rs` | CREATE | `ChatMessage` -> `Vec<Line>` formatter for scrollback |
| `crates/bakudo-tui/src/wrapping.rs` | CREATE | reduced URL-aware wrapping helpers |
| `crates/bakudo-tui/src/test_backend.rs` | CREATE | VT100 test backend for escape-sequence assertions |
| `crates/bakudo-tui/src/lib.rs` | MODIFY | module declarations |
| `crates/bakudo-tui/src/app.rs` | MODIFY | pending-history queue; remove transcript-scroll ownership |
| `crates/bakudo-tui/src/ui.rs` | MODIFY | compact inline viewport layout |
| `crates/bakudo-tui/src/footer.rs` | MODIFY | inline-mode footer hints |
| `src/main.rs` | MODIFY | raw-mode-only terminal guard + inline event loop integration |
| `Cargo.toml` | MODIFY | add `textwrap` workspace dep if needed |
| `crates/bakudo-tui/Cargo.toml` | MODIFY | add `textwrap`; likely `vt100` as dev-dependency |

---

## Task 1: Add dependency and module scaffolding

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/bakudo-tui/Cargo.toml`
- Modify: `crates/bakudo-tui/src/lib.rs`

- [ ] **Step 1.1: Add only the dependencies Phase 4 actually needs**

Expected additions:

- `textwrap` (runtime; reduced `wrapping.rs` port)
- `vt100` (dev-dependency if terminal-escape tests use the codex backend pattern)

Do **not** add `derive_more`; hand-roll the tiny helper methods codex uses it for.

- [ ] **Step 1.2: Reserve module slots in `lib.rs`**

Add:

```rust
pub mod custom_terminal;
pub mod history_render;
pub mod insert_history;
pub mod wrapping;
```

If `test_backend.rs` is only test support, gate it with `#[cfg(test)]`.

- [ ] **Step 1.3: Commit**

```bash
git add Cargo.toml crates/bakudo-tui/Cargo.toml crates/bakudo-tui/src/lib.rs
git commit -m "chore(tui): add inline scrollback module scaffolding"
```

---

## Task 2: Port `custom_terminal.rs` for ratatui 0.26

**Files:**
- Create: `crates/bakudo-tui/src/custom_terminal.rs`

- [ ] **Step 2.1: Port the file structure from codex**

Carry over:

- `Frame`
- `Terminal<B>`
- diff-buffer management
- `invalidate_viewport`
- `clear_visible_screen`
- `clear_scrollback`
- `clear_scrollback_and_visible_screen_ansi`

Add a short provenance header comment.

- [ ] **Step 2.2: Adapt the ratatui API surface**

Required local changes:

- translate `get_cursor_position` / `set_cursor_position` to ratatui 0.26's cursor APIs
- convert backend `size()` from `Rect` to `Size`
- remove assumptions about backend `scroll_region_up/down`
- keep all raw ANSI scroll-region work inside the port itself

- [ ] **Step 2.3: Keep the port smaller than codex**

Do **not** bring over codex's alt-screen orchestration layer. This file should only provide the inline terminal primitive bakudo needs.

- [ ] **Step 2.4: Add focused tests for cursor + viewport bookkeeping**

Tests should cover:

- initial cursor fallback behavior
- `set_viewport_area`
- `invalidate_viewport`
- `clear_visible_screen` / `clear_scrollback_and_visible_screen_ansi`

- [ ] **Step 2.5: Commit**

```bash
git add crates/bakudo-tui/src/custom_terminal.rs
git commit -m "feat(tui): port inline custom terminal wrapper"
```

---

## Task 3: Port `insert_history.rs` and its reduced support surface

**Files:**
- Create: `crates/bakudo-tui/src/insert_history.rs`
- Create: `crates/bakudo-tui/src/wrapping.rs`
- Create: `crates/bakudo-tui/src/test_backend.rs` (if used)

- [ ] **Step 3.1: Port `insert_history.rs`**

Keep:

- `InsertHistoryMode`
- standard `DECSTBM` / reverse-index insertion path
- Zellij newline fallback
- styled line writing and wrapped-row clearing
- `SetScrollRegion` / `ResetScrollRegion`

Adapt imports and helper calls to bakudo's module tree.

- [ ] **Step 3.2: Port only the wrapping helpers this file needs**

From codex's `wrapping.rs`, bring over the reduced subset required for:

- URL-like token detection
- adaptive wrapping
- mixed URL/non-URL handling

Do **not** port codex's full markdown/render stack.

- [ ] **Step 3.3: Port the VT100 backend helper if needed**

If exact ANSI behavior is easiest to verify through a parser-backed backend, port codex's `test_backend.rs` and keep it test-only.

- [ ] **Step 3.4: Add terminal-escape tests**

Minimum coverage:

- inserts above the viewport in standard mode
- preserves non-default color across wrapped rows
- does not hard-split URL-only lines
- Zellij mode updates the viewport correctly

- [ ] **Step 3.5: Commit**

```bash
git add crates/bakudo-tui/src/insert_history.rs crates/bakudo-tui/src/wrapping.rs crates/bakudo-tui/src/test_backend.rs
git commit -m "feat(tui): port inline history insertion helpers"
```

---

## Task 4: Extract reusable transcript-to-history formatting

**Files:**
- Create: `crates/bakudo-tui/src/history_render.rs`
- Modify: `crates/bakudo-tui/src/ui.rs`

- [ ] **Step 4.1: Move message formatting out of `render_transcript`**

Create a reusable helper that turns a `ChatMessage` into display lines at a target width while preserving:

- timestamp gutter
- role glyph and label
- continuation indentation
- user-row tint
- diff-aware body styling

- [ ] **Step 4.2: Keep formatting parity with today's transcript view**

Do not invent a new chat vocabulary in Phase 4. The inline history should look like the current transcript rows, just no longer boxed inside a pane.

- [ ] **Step 4.3: Add formatter tests**

Assert exact rendered text for representative roles and wrapped continuations.

- [ ] **Step 4.4: Commit**

```bash
git add crates/bakudo-tui/src/history_render.rs crates/bakudo-tui/src/ui.rs
git commit -m "refactor(tui): extract transcript history line formatting"
```

---

## Task 5: Queue transcript messages for inline emission and remove transcript scrolling

**Files:**
- Modify: `crates/bakudo-tui/src/app.rs`
- Modify: `crates/bakudo-tui/src/footer.rs`
- Modify: `crates/bakudo-tui/src/ui.rs`

- [ ] **Step 5.1: Add a pending-history queue to `App`**

Recommended methods:

- `take_pending_history() -> Vec<ChatMessage>`
- queue seeded by `push_message()`
- queue replay seeded by `load_transcript()` on resume

- [ ] **Step 5.2: Remove transcript-scroll ownership**

Delete or retire:

- `scroll_offset`
- global `PageUp` / `PageDown` transcript handling
- transcript scroll indicator UI

- [ ] **Step 5.3: Update footer/help semantics**

Remove `PgUp/Dn: scroll` from inline-mode footer variants and update `/help` copy so the keyboard hints stay truthful.

- [ ] **Step 5.4: Commit**

```bash
git add crates/bakudo-tui/src/app.rs crates/bakudo-tui/src/footer.rs crates/bakudo-tui/src/ui.rs
git commit -m "refactor(tui): queue transcript history for inline mode"
```

---

## Task 6: Replace alt-screen runtime wiring in `src/main.rs`

**Files:**
- Modify: `src/main.rs`

- [ ] **Step 6.1: Remove alt-screen entry/exit from `TerminalGuard`**

Keep:

- raw mode
- bracketed paste
- focus change

Drop:

- `EnterAlternateScreen`
- `LeaveAlternateScreen`

- [ ] **Step 6.2: Swap `ratatui::Terminal` for the custom terminal wrapper**

Use the adapted `bakudo_tui::custom_terminal::Terminal`.

- [ ] **Step 6.3: Recompute viewport height every frame**

The main loop should:

1. drain session events
2. drain `pending_history`
3. render those messages into `Vec<Line<'static>>` at full terminal width
4. insert them above the viewport using `InsertHistoryMode::new(is_zellij)`
5. compute desired viewport height from current app state
6. update the viewport
7. draw the live UI

- [ ] **Step 6.4: Handle resume replay and resize cleanly**

Ensure resumed transcript history appears before the first stable frame, and ensure viewport updates after resize do not leave stale rows behind.

- [ ] **Step 6.5: Commit**

```bash
git add src/main.rs
git commit -m "feat(tui): render transcript history into terminal scrollback"
```

---

## Task 7: Full automated gate

**Files:** working tree only

- [ ] **Step 7.1: Add or update UI tests for inline mode**

Minimum assertions:

- footer/help text no longer mentions transcript scrolling
- compact viewport renders cleanly with and without the shelf
- resume queue or pending-history drain behaves deterministically

- [ ] **Step 7.2: Format**

```bash
cargo fmt
```

- [ ] **Step 7.3: Lint**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 7.4: Test**

```bash
cargo test --workspace
```

- [ ] **Step 7.5: Commit any mechanical follow-up**

If fmt/clippy/test required small cleanup edits:

```bash
git add ...
git commit -m "chore(tui): satisfy inline scrollback quality gates"
```

Only make this commit if there is a real diff.

---

## Task 8: Visual verification under `tui-use`

**Files:** none

- [ ] **Step 8.1: Verify at `140x40`**

Confirm:

- no alt-screen flash or blank-screen exit
- new output lands above the viewport in normal terminal history
- header/status/composer/footer remain stable while work is running

- [ ] **Step 8.2: Verify at `80x30`**

Confirm:

- compact viewport remains usable
- shelf/no-shelf cases still fit
- footer hints stay truthful
- clean exit leaves scrollback visible

- [ ] **Step 8.3: Stop and report**

Do **not** push, merge, or open a PR after visual verification. Stop and report branch state, commits, and verification results for review.
