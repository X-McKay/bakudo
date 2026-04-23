# Bakudo v2 — Agent Conventions

This document describes the current repository conventions, architecture
invariants, and workflow rules for AI agents working in this tree.

## Repository Layout

```text
bakudo/
├── Cargo.toml
├── src/main.rs
├── crates/
│   ├── bakudo-core/
│   ├── bakudo-daemon/
│   └── bakudo-tui/
├── tests/
│   ├── integration.rs
│   └── runtime.rs
├── docs/
│   ├── current-architecture.md
│   └── archive/
├── .claude/skills/
├── AGENTS.md
├── justfile
└── .mise.toml
```

## Build and Test Commands

Use `just` or `cargo` directly:

| Task | Command |
|------|---------|
| Build (debug) | `cargo build` |
| Build (release) | `cargo build --release` |
| Run all tests | `cargo test --workspace` |
| Run one crate's tests | `cargo test -p bakudo-daemon` |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Format | `cargo fmt --all` |
| Full quality gate | `just check` |
| CI-equivalent gate | `just ci` |

Before every commit, `just check` should pass with zero warnings.

## Architecture Invariants

### 1. Crate boundaries

- `bakudo-core` contains shared domain types, provider specs, protocol types,
  control-plane helpers, and the `abox` adapter.
- `bakudo-daemon` owns async orchestration, mission supervision, durable
  mission storage, provider wake execution, and worktree lifecycle decisions.
- `bakudo-tui` owns rendering, input handling, slash-command UX, and modal
  state.
- `src/main.rs` is a thin CLI/bootstrap layer.

### 2. There are two execution paths

- Classic one-shot work (`bakudo run`, `bakudo swarm`) uses
  `ProviderRegistry` in `bakudo-core/src/provider.rs`.
- Wake-based missions use `ProviderCatalog` in
  `crates/bakudo-daemon/src/provider_runtime.rs` plus
  `.bakudo/providers/*.toml` and `.bakudo/prompts/*.md`.

Do not mix those two provider-loading paths.

### 3. Provider invocations stay declarative

Classic runs build commands through `ProviderSpec::build_worker_command(...)`.
Autonomous missions load provider and wake-budget settings through
`ProviderCatalog`.

Do not hard-code provider binaries or ad hoc flag strings outside those
surfaces.

### 4. Worktree lifecycle is host-owned

The agent inside the sandbox never merges its own work.

1. Bakudo starts a sandbox with `abox run`.
2. The provider or experiment exits.
3. Host-side policy decides whether to preserve, merge, or discard.
4. Merge/discard operations happen from the host via Bakudo, not from inside
   the sandbox.

### 5. Sandbox state and mission state are distinct

- Sandbox lifecycle transitions go through `SandboxLedger::update_state`.
- Wake-based mission persistence goes through `MissionStore`.

Do not mutate either store's internals directly.

### 6. The mission runtime is wake-based

- The conversational host layer stays in front of the mission runtime.
- Durable mission state uses `MissionState` terminology only.
- The deliberator is stateless across wakes.
- Each provider wake respects its configured `wake_budget`.
- Per-mission provenance is appended to
  `.bakudo/provenance/<mission-id>.ndjson`.

Do not reintroduce compatibility aliases for old mission terminology or old
tool names.

### 7. TUI and daemon communicate only through typed channels

- `SessionCommand`: TUI to daemon.
- `SessionEvent`: daemon to TUI.

The TUI does not spawn sandbox work directly.

## Slash Command Conventions

Slash commands live in `bakudo-tui/src/commands.rs`. When adding one:

1. Add the enum variant in presentation order.
2. Implement `description()`, `available_during_task()`, and
   `supports_inline_arg()`.
3. Handle it in `App::handle_parsed_command()`.
4. Add a `SessionCommand` and handle it in `SessionController` if daemon work
   is required.
5. Add coverage in `commands.rs` plus `tests/integration.rs` or
   `tests/runtime.rs`.

## Adding or Changing a Provider

1. Update `ProviderRegistry::with_defaults()` if the classic one-shot path
   changes.
2. Update `.bakudo/providers/*.toml` defaults in
   `crates/bakudo-daemon/data/providers/` if mission runtime behavior changes.
3. Update prompts in `crates/bakudo-daemon/data/prompts/` if the mission tool
   contract changes.
4. Add or update tests in `provider.rs`, `tests/integration.rs`, and
   `tests/runtime.rs` as appropriate.
5. Update `README.md` and `docs/current-architecture.md` when runtime
   behavior changes.

## Documentation Policy

- `README.md` and `docs/current-architecture.md` describe the shipping runtime.
- `docs/archive/` contains historical drafts only.
- AI-tooling guidance under `.claude/skills/` should describe the current Rust
  runtime, not removed TypeScript or macro-orchestration systems.

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
