# TUI Status + Footer Codex Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phases 2 and 3 of the bakudo TUI codex-port: codex-style running status row first, then width-aware footer collapse with snapshot-style render coverage.

**Architecture:** Add `key_hint.rs`, `shimmer.rs`, `status_indicator.rs`, and `footer.rs` inside `crates/bakudo-tui/src/`. `status_indicator.rs` is a bakudo-specific adaptation of codex's `status_indicator_widget.rs`; `footer.rs` ports the collapse pattern from codex's `bottom_pane/footer.rs` but keeps bakudo's smaller hint vocabulary. `ui.rs` becomes a thin caller for both surfaces.

**Tech stack:** Rust 2024 for `bakudo-tui`, `crossterm 0.27`, `ratatui 0.26`, existing Phase 1 palette/terminal helpers. No new runtime dependency and no `src/main.rs` change expected.

**Spec:** `docs/superpowers/specs/2026-04-25-tui-status-footer-design.md`

**Scope:** TUI crate only. **Out of scope:** Phase 4 alt-screen removal / scrollback rendering, selection popup unification, daemon protocol changes.

---

## File map

| File | Status | Purpose |
|---|---|---|
| `crates/bakudo-tui/src/key_hint.rs` | CREATE | codex key hint formatter |
| `crates/bakudo-tui/src/shimmer.rs` | CREATE | codex shimmer helper |
| `crates/bakudo-tui/src/status_indicator.rs` | CREATE | compact running-row renderer + tests |
| `crates/bakudo-tui/src/footer.rs` | CREATE | width-aware footer collapse + tests |
| `crates/bakudo-tui/src/lib.rs` | MODIFY | module declarations |
| `crates/bakudo-tui/src/ui.rs` | MODIFY | replace inline status/footer rendering with module calls |

---

## Task 1: Port `key_hint.rs` and `shimmer.rs`

**Files:**
- Create: `crates/bakudo-tui/src/key_hint.rs`
- Create: `crates/bakudo-tui/src/shimmer.rs`
- Modify: `crates/bakudo-tui/src/lib.rs`

- [ ] **Step 1.1: Port `key_hint.rs` from codex**

Copy `/tmp/codex-research/codex/codex-rs/tui/src/key_hint.rs` into `crates/bakudo-tui/src/key_hint.rs`.

Keep the core shape:

- `KeyBinding`
- `plain`, `alt`, `shift`, `ctrl`, `ctrl_alt`
- `impl From<KeyBinding> for Span<'static>`
- `has_ctrl_or_alt`

Add a short provenance header comment at the top.

- [ ] **Step 1.2: Port `shimmer.rs` from codex**

Copy `/tmp/codex-research/codex/codex-rs/tui/src/shimmer.rs` into `crates/bakudo-tui/src/shimmer.rs`.

Keep:

- `PROCESS_START`
- `elapsed_since_start()`
- `shimmer_spans(text: &str) -> Vec<Span<'static>>`
- the true-color fallback behavior using Phase 1's `color.rs` / `terminal_palette.rs`

Add a short provenance header comment at the top.

- [ ] **Step 1.3: Wire the modules into the crate**

Edit `crates/bakudo-tui/src/lib.rs` and add module declarations for:

```rust
pub mod key_hint;
pub mod shimmer;
```

- [ ] **Step 1.4: Build-check the crate**

Run:

```bash
cargo check -p bakudo-tui
```

Expected: after Tasks 2 and 3 land, the crate builds cleanly with the new modules. If this task is done in one patch with Tasks 2 and 3, use the post-patch build as the verification point.

- [ ] **Step 1.5: Commit**

```bash
git add crates/bakudo-tui/src/lib.rs crates/bakudo-tui/src/key_hint.rs crates/bakudo-tui/src/shimmer.rs
git commit -m "feat(tui): port codex key hint and shimmer helpers"
```

---

## Task 2: Add a dedicated status indicator module

**Files:**
- Create: `crates/bakudo-tui/src/status_indicator.rs`
- Modify: `crates/bakudo-tui/src/ui.rs`
- Modify: `crates/bakudo-tui/src/lib.rs`

- [ ] **Step 2.1: Create `status_indicator.rs`**

Implement a focused, bakudo-sized renderer inspired by codex's `status_indicator_widget.rs`.

Required exports:

```rust
pub(crate) fn fmt_elapsed_compact(elapsed_secs: u64) -> String
pub(crate) fn render_status_line(app: &App, width: u16) -> Option<Line<'static>>
```

Guidance:

- `fmt_elapsed_compact` should match codex formatting:
  - `0s`
  - `59s`
  - `1m 00s`
  - `59m 59s`
  - `1h 00m 00s`
- `render_status_line` should return `None` when nothing is running.
- The line should start with `•`, then a shimmered `Running`, then `({elapsed} • esc to interrupt)`.
- Use `key_hint::plain(KeyCode::Esc)` for the key hint.
- If there is suffix context, append it after ` · ` and truncate the final line with an ellipsis if it overflows `width`.

- [ ] **Step 2.2: Define suffix behavior**

Use current app state only; do not add daemon fields.

Rules:

- Determine running entries from `app.shelf`.
- `count = max(app.active_task_count, running_entries.len())`.
- Elapsed time is based on the **oldest** running entry's `started_at`.
- Latest note context comes from the **first** running shelf entry in display order.
- Suffix text:
  - `count == 1`: `[{short_id}] {last_note}`
  - `count > 1`: `{count} sandboxes active · [{short_id}] {last_note}`
- If there is no running entry but `count > 0`, render only the base status text with elapsed `0s`.

- [ ] **Step 2.3: Replace `render_status_strip` in `ui.rs`**

Edit `crates/bakudo-tui/src/ui.rs`:

- add `pub mod status_indicator;` to `crates/bakudo-tui/src/lib.rs`;
- remove the old hand-built spinner/count row;
- call into `status_indicator::render_status_line(app, area.width)`;
- render the returned `Line` with `Paragraph::new(...)` when present.

Do **not** change the row-height/layout policy in this phase; the status row remains exactly one terminal row.

- [ ] **Step 2.4: Add Phase 2 tests**

Add focused tests in `status_indicator.rs` and/or `ui.rs` that cover:

- `fmt_elapsed_compact` formatting cases
- status row contains `• Running`
- status row contains `esc to interrupt`
- status row includes `[short-id]` and the latest note
- truncation at narrow widths uses `…`

Because shimmer affects style rather than content, test only rendered text.

- [ ] **Step 2.5: Verify**

Run:

```bash
cargo test -p bakudo-tui status_indicator
cargo test -p bakudo-tui ui::tests::status_strip_shows_spinner_and_count_when_tasks_running -- --exact
```

Update or rename the existing UI test so it reflects the new row semantics.

- [ ] **Step 2.6: Commit**

```bash
git add crates/bakudo-tui/src/lib.rs crates/bakudo-tui/src/status_indicator.rs crates/bakudo-tui/src/ui.rs
git commit -m "feat(tui): adopt codex-style running status row"
```

---

## Task 3: Add a width-aware footer module

**Files:**
- Create: `crates/bakudo-tui/src/footer.rs`
- Modify: `crates/bakudo-tui/src/ui.rs`
- Modify: `crates/bakudo-tui/src/lib.rs`

- [ ] **Step 3.1: Extract footer vocabulary into `footer.rs`**

Create a bakudo-specific footer adapter with small data types, for example:

```rust
enum FooterVariant { ChatSlash, ChatShelf, ChatPlain, Shelf }
struct FooterItem { key: KeyBinding, label: &'static str, short_label: Option<&'static str> }
```

The exact type names may differ, but the module must make footer fitting a data problem rather than a string-concatenation branch inside `ui.rs`.

- [ ] **Step 3.2: Implement collapse candidates**

Encode the full and shortened candidates for each variant:

- `ChatSlash`
  - `Enter: send`
  - `Tab: complete`
  - `PgUp/Dn: scroll`
  - `Ctrl+C: quit`
  - `/help: commands` (short form: `/help: help`)
- `ChatShelf`
  - `Enter: send`
  - `Tab: inspect shelf` (short form: `Tab: shelf`)
  - `PgUp/Dn: scroll`
  - `Ctrl+C: quit`
  - `/help: commands` (short form: `/help: help`)
- `ChatPlain`
  - same as chat, but **no** `Tab` hint
- `Shelf`
  - `Tab/Esc: back to chat` (short form: `Tab/Esc: chat`)
  - `j/k: navigate`
  - `a: apply`
  - `d: discard`

Then implement a best-fit selector that:

1. tries the full line;
2. tries shortened labels;
3. drops the lowest-priority item and retries;
4. preserves the highest-priority action as the final fallback.

- [ ] **Step 3.3: Wire `render_footer` to the new module**

Edit `crates/bakudo-tui/src/ui.rs` so `render_footer`:

- adds `pub mod footer;` to `crates/bakudo-tui/src/lib.rs`;
- determines the current `FooterVariant` from app focus, slash input, and shelf visibility;
- asks `footer.rs` for the best-fitting `Line<'static>` for `area.width`;
- renders that line without a black background fill.

The footer should remain one row high.

- [ ] **Step 3.4: Add snapshot-style footer tests**

Use existing `render_to_string` testing utilities in `ui.rs` or dedicated tests in `footer.rs`.

Add exact bottom-row assertions for representative widths and modes, at minimum:

- wide chat + shelf visible
- narrow chat + shelf hidden
- wide slash completion footer
- shelf-focus footer
- at least one very narrow width where the final fallback is exercised

The tests should assert **exact rendered footer rows**, not just `contains(...)`.

- [ ] **Step 3.5: Verify**

Run:

```bash
cargo test -p bakudo-tui footer
```

and then the full crate tests:

```bash
cargo test -p bakudo-tui
```

- [ ] **Step 3.6: Commit**

```bash
git add crates/bakudo-tui/src/lib.rs crates/bakudo-tui/src/footer.rs crates/bakudo-tui/src/ui.rs
git commit -m "feat(tui): add width-aware footer collapse"
```

---

## Task 4: Full quality gate

**Files:** working tree only

- [ ] **Step 4.1: Format**

```bash
cargo fmt
```

- [ ] **Step 4.2: Lint**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **Step 4.3: Test**

```bash
cargo test --workspace
```

- [ ] **Step 4.4: Commit any mechanical fixes**

If fmt/clippy/test required small follow-up edits, commit them with:

```bash
git add ...
git commit -m "chore(tui): satisfy fmt clippy and test gates for status/footer port"
```

Only make this commit if there is a real diff after the gate.

---

## Task 5: Visual verification under `tui-use`

**Files:** none

- [ ] **Step 5.1: Run the TUI at 140×40**

Verify:

- status row shows `• Running ({elapsed} • esc to interrupt)`
- `Running` visibly shimmers
- footer shows the full truthful hint set

- [ ] **Step 5.2: Run the TUI at 80×30**

Verify:

- footer no longer mentions shelf inspection when the shelf is hidden
- footer collapse remains legible
- clean exit restores the terminal

- [ ] **Step 5.3: Stop and report**

Do **not** push, merge, or open a PR after the smoke test. Stop and report branch state, commits, and verification results for user review.
