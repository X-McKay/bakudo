# Bakudo v2 — Agent Conventions

This document describes the conventions, architecture invariants, and workflow rules that AI agents should follow in this repository.

## Repository Layout

```text
bakudo/
├── Cargo.toml
├── Cargo.lock
├── src/
│   └── main.rs
├── crates/
│   ├── bakudo-core/
│   ├── bakudo-daemon/
│   └── bakudo-tui/
├── tests/
│   ├── integration.rs
│   └── runtime.rs
├── docs/
│   ├── current-architecture.md
│   └── archive/                       # historical design drafts
├── .claude/skills/
├── AGENTS.md
├── justfile
└── .mise.toml
```

## Build and Test Commands

All development tasks are run via `just` or `cargo`:

| Task | Command |
|------|---------|
| Build (debug) | `cargo build` |
| Build (release) | `cargo build --release` |
| Run all tests | `cargo test --workspace` |
| Run one crate's tests | `cargo test -p bakudo-core` |
| Check | `cargo check --workspace` |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Format | `cargo fmt --all` |
| Full quality gate | `just check` |

Before every commit, `just check` should pass with zero warnings.

## Architecture Invariants

### 1. Crate boundaries

- `bakudo-core` contains shared domain logic only.
- `bakudo-daemon` owns async execution and sandbox lifecycle management.
- `bakudo-tui` owns rendering and input handling.
- `src/main.rs` is a thin composition layer for TUI and headless execution.

### 2. Provider agnosticism

Providers are invoked headlessly through the registry in `bakudo-core/src/provider.rs`.

```rust
let spec = registry.get("claude").unwrap();
let command = spec.build_stdin_command(&model, true);
```

Do not hard-code provider binaries or flags anywhere else.

### 3. Worktree lifecycle is host-owned

The agent inside the sandbox never merges its own work.

1. Bakudo starts a sandbox with `abox run --task <id> -- <provider-command...>`.
2. The provider runs inside the sandbox and exits.
3. `bakudo-daemon/src/worktree.rs` applies the host-side candidate policy.
4. `AutoApply` calls `abox merge`.
5. `Review` preserves the worktree for `/apply`, `/discard`, `bakudo apply`, or `bakudo discard`.
6. `Discard` calls `abox stop --clean`.

### 4. State changes go through `SandboxLedger`

All sandbox state transitions must go through `SandboxLedger::update_state`.

```rust
ledger.update_state("task-id", SandboxState::Preserved).await;
```

Never mutate the ledger internals directly.

### 5. TUI and daemon communicate only through typed channels

- `mpsc::Sender<SessionCommand>`: TUI to daemon.
- `mpsc::Sender<SessionEvent>`: daemon to TUI.

The TUI does not spawn sandbox work directly.

## Slash Command Conventions

Slash commands live in `bakudo-tui/src/commands.rs`. When adding one:

1. Add the enum variant in presentation order.
2. Implement `description()`, `available_during_task()`, and `supports_inline_arg()`.
3. Handle it in `App::handle_parsed_command()`.
4. If needed, add a `SessionCommand` and handle it in `SessionController`.
5. Add unit coverage in `commands.rs` and integration coverage in `tests/integration.rs` or `tests/runtime.rs`.

## Adding a New Provider

1. Add a `ProviderSpec` entry in `ProviderRegistry::with_defaults()`.
2. Implement the correct non-interactive/stdin invocation.
3. Add unit tests in `provider.rs`.
4. Update `docs/current-architecture.md` if the runtime behavior changes.

## Documentation Policy

- `README.md` and `docs/current-architecture.md` describe the current implementation.
- Files under `docs/archive/` are historical drafts. Do not treat them as the source of truth for current behavior.

## Commit Message Convention

Use Conventional Commits:

```text
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`.

## Release Process

1. Ensure `just check` passes on `main`.
2. Update `CHANGELOG.md`.
3. Bump versions in the workspace manifests.
4. Commit and tag the release.
5. Build the release binary with `cargo build --release`.
