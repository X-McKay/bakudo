# Bakudo v2 — Agent Conventions

This document describes the conventions, architecture invariants, and
workflow rules that AI agents (Claude Code, Codex, OpenCode, etc.) must
follow when working in this repository.

---

## Repository Layout

```
bakudo/
├── Cargo.toml              # Workspace root
├── Cargo.lock
├── src/
│   └── main.rs             # CLI entry point (clap)
├── crates/
│   ├── bakudo-core/        # Domain types, abox adapter, provider registry, config
│   ├── bakudo-daemon/      # Session controller, task runner, worktree lifecycle
│   └── bakudo-tui/         # ratatui TUI: app state, UI rendering, slash commands
├── tests/
│   └── integration.rs      # Workspace-level integration tests
├── docs/                   # Architecture plans and design documents
├── .claude/skills/         # Claude Code skill definitions for this repo
├── AGENTS.md               # This file
├── justfile                # Task runner
└── .mise.toml              # Tool version management
```

---

## Build and Test Commands

All development tasks are run via `just` (or `cargo` directly):

| Task | Command |
|------|---------|
| Build (debug) | `cargo build` |
| Build (release) | `cargo build --release` |
| Run all tests | `cargo test --workspace` |
| Run a specific crate's tests | `cargo test -p bakudo-core` |
| Check (no codegen) | `cargo check --workspace` |
| Lint (clippy) | `cargo clippy --workspace -- -D warnings` |
| Format | `cargo fmt --all` |
| Full CI check | `just check` |
| Install pre-commit hook | `mise run hooks:install` |

**Quality gate**: before every commit, `just check` must pass with zero
errors and zero warnings. This runs `cargo fmt --check`, `cargo clippy`,
and `cargo test --workspace`.

---

## Architecture Invariants

### 1. Crate boundaries

- **`bakudo-core`** — pure domain logic only. No I/O, no tokio runtime,
  no TUI. All types here must be `Send + Sync`. Tests in this crate must
  be synchronous or use `tokio::test`.
- **`bakudo-daemon`** — owns async task execution and abox lifecycle.
  Depends on `bakudo-core`. Must not import from `bakudo-tui`.
- **`bakudo-tui`** — owns all terminal rendering and user input. Depends
  on `bakudo-core` and `bakudo-daemon`. Must not spawn tokio tasks
  directly; all async work is delegated to the daemon via channels.
- **`src/main.rs`** — wires everything together. Thin layer only: parse
  CLI args, build config, construct the channel pair, spawn the daemon
  task, and hand off to the TUI event loop.

### 2. Provider agnosticism

Providers (Claude Code, Codex, OpenCode, Gemini CLI) are invoked
**headlessly via stdin**. The correct invocation form for each provider
is defined in `bakudo-core/src/provider.rs`. Never hard-code a provider
binary path or flag anywhere else.

```rust
// Correct — use the registry
let spec = registry.get("claude").unwrap();
let args = spec.build_args(&model, /*non_interactive=*/true);

// Wrong — never do this
let cmd = Command::new("claude").arg("-p").arg(prompt);
```

### 3. Worktree lifecycle — host owns merge/discard

The host (bakudo) **always** decides whether to merge or discard a
preserved worktree. The agent running inside the abox sandbox **never**
calls `abox merge` or `git merge`. The lifecycle is:

1. `abox run --detach` — bakudo starts the sandbox.
2. Agent runs, writes output to the worktree.
3. `abox run` exits (VM halts).
4. `bakudo-daemon/src/worktree.rs` evaluates `candidate_policy`.
5. If `AutoApply`: bakudo calls `abox merge` then `abox stop --clean`.
6. If `Review`: worktree is preserved; user calls `/apply` or `/discard`.
7. If `Discard`: bakudo calls `abox stop --clean`.

### 4. State mutations go through `SandboxLedger`

All sandbox state transitions must go through `SandboxLedger::update`.
Never mutate sandbox state directly. The ledger is `Arc<SandboxLedger>`
and is shared between the daemon and TUI.

```rust
// Correct
ledger.update("task-id", SandboxState::Preserved).await;

// Wrong — never do this
let mut guard = ledger.inner.lock().await;
guard.get_mut("task-id").unwrap().state = SandboxState::Preserved;
```

### 5. TUI and Daemon communication

The TUI and daemon communicate **only** through the typed channel pair:

- `mpsc::Sender<SessionCommand>` — TUI sends commands to daemon.
- `mpsc::Sender<SessionEvent>` — daemon sends events to TUI.

Never share mutable state between the TUI and daemon directly. The
`SandboxLedger` is the only `Arc`-shared state, and it is read-only from
the TUI's perspective (the TUI reads it for display; the daemon writes it).

---

## Slash Command Conventions

Slash commands are defined in `bakudo-tui/src/commands.rs` as a
`strum`-derived enum. When adding a new command:

1. Add the variant to `SlashCommand` (maintain presentation order).
2. Implement `description()`, `available_during_task()`, and
   `supports_inline_arg()` for the new variant.
3. Handle the command in `App::handle_parsed_command()` in `app.rs`.
4. If the command requires daemon interaction, add a `SessionCommand`
   variant and handle it in `SessionController::run()`.
5. Add a unit test in `commands.rs` and an integration test in
   `tests/integration.rs`.

---

## Adding a New Provider

1. Add a `ProviderSpec` entry in `ProviderRegistry::default()` in
   `bakudo-core/src/provider.rs`.
2. Implement `build_args()` to return the correct non-interactive CLI
   flags for that provider.
3. Add a unit test in `provider.rs` asserting the non-interactive flag
   is present.
4. Update `docs/bakudo-v2-architecture-revised-plan.md` with the new
   provider's invocation details.

---

## Commit Message Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`.
Scopes: `core`, `daemon`, `tui`, `cli`, `abox`, `provider`.

Examples:

```
feat(tui): add /diverge slash command
fix(daemon): correct argument order in abox.divergence() call
docs: update provider registry section in AGENTS.md
```

Breaking changes must include `BREAKING CHANGE:` in the commit footer.

---

## Release Process

1. Ensure `just check` passes on `main`.
2. Update `CHANGELOG.md` with the new version section.
3. Bump the version in the workspace `Cargo.toml` and all crate
   `Cargo.toml` files using `cargo set-version <version>` (requires
   `cargo-edit`).
4. Commit: `chore: bump version to vX.Y.Z`.
5. Tag: `git tag vX.Y.Z`.
6. Push: `git push origin main --tags`.
7. Build the release binary: `cargo build --release`.
8. Create the GitHub release and attach the binary.
