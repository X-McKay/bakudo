# Skill: Feature Development in Bakudo

## Trigger

When asked to add a new feature to the `bakudo` repository.

## Context

Bakudo v2 is a pure Rust project structured as a Cargo workspace with three
crates: `bakudo-core`, `bakudo-daemon`, and `bakudo-tui`. The CLI entry point
lives in `src/main.rs`. There is no TypeScript, Node.js, or `pnpm` in this
repository.

## Process

1. **Understand the crate boundary.** Decide which crate owns the new feature:
   - Domain types, provider specs, abox adapter changes -> `bakudo-core`
   - Task execution, worktree lifecycle, session state -> `bakudo-daemon`
   - TUI rendering, slash commands, keyboard handling -> `bakudo-tui`
   - CLI flags and top-level wiring -> `src/main.rs`

2. **Write the implementation.** Follow the architecture invariants in
   `AGENTS.md`. Key rules:
   - Sandbox lifecycle updates go through `SandboxLedger::update_state`.
   - Mission runtime persistence goes through `MissionStore`.
   - Classic headless providers use `ProviderRegistry`; wake-based missions
     use `ProviderCatalog` plus `.bakudo/providers/*.toml`.
   - TUI and daemon communicate only via the typed channel pair.
   - Use `MissionState` terminology in current runtime code and docs.

3. **Write tests.** Every new public function needs a unit test in its crate.
   Cross-crate scenarios go in `tests/integration.rs` or `tests/runtime.rs`
   depending on whether the change is classic execution or wake-based runtime.

4. **Run the quality gate:**
   ```bash
   just check
   ```
   This runs `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
   and `cargo test --workspace`. All must pass with zero warnings.

5. **Commit** using Conventional Commits (see `AGENTS.md`).

## Quality Gate

`just check` must pass with zero errors and zero warnings before every commit.
