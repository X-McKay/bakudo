# Bakudo

Bakudo is a Rust agent harness for running provider CLIs inside isolated `abox` sandboxes and managing the resulting worktrees from the host.

Version 2 ships a `ratatui` interface, a headless CLI mode, and a host-owned preserved-worktree lifecycle.

## Features

- **Provider agnostic**: Run Claude Code, Codex, OpenCode, or Gemini CLI headlessly. Prompts are injected via `stdin` and structured specs are passed into the sandbox with `BAKUDO_*` env vars.
- **Host-owned worktree lifecycle**: Bakudo decides whether to preserve, merge, or discard the sandbox worktree after the provider exits.
- **Polished TUI**: A responsive `ratatui` interface with a chat transcript, observability shelf, slash commands, and keyboard-driven worktree actions.
- **Crash recovery**: Uses `abox list` plus a `SandboxLedger` to reconcile sandbox state after host restarts.
- **Robust testing**: Includes unit tests, fake-`abox` runtime integration tests, and optional live smoke tests against installed `abox 0.3.1`.

## Prerequisites

- **Rust**: Stable toolchain (install via `rustup`).
- **abox**: Version `0.3.1` or later.
- **just**: Command runner (install via `cargo install just` or `mise`).

## Installation

```bash
git clone https://github.com/X-McKay/bakudo.git
cd bakudo
cargo build --release
```

The binary will be available at `target/release/bakudo`.

## Usage

Start the interactive TUI:

```bash
bakudo
```

### TUI Slash Commands

- `/provider <name>`: set the active provider.
- `/model <name>`: set the active model override.
- `/providers`: list registered providers.
- `/apply <task-id>`: merge a preserved worktree.
- `/discard <task-id>`: discard a preserved worktree.
- `/diverge <task-id>`: show divergence for a preserved worktree.
- `/sandboxes` (aliases: `/ls`, `/list`): list tracked sandboxes.
- `/diff <task-id>`: fetch and colorise the diff for a preserved worktree.
- `/status`: show provider/model/task counts.
- `/config`: show the active runtime configuration.
- `/doctor`: probe `abox` and provider binaries for health issues.
- `/clear`: clear the transcript display.
- `/new`: start a fresh transcript/session view.
- `/help`: show the command catalog.
- `/quit`: exit the application.

### Headless CLI

```bash
bakudo run "Fix the failing tests"
bakudo list
bakudo apply <task-id>
bakudo discard <task-id>
bakudo divergence <task-id>
bakudo doctor
bakudo resume <session-id>
```

### Configuration

Bakudo loads configuration in layered order:

1. `~/.config/bakudo/config.toml`  (user defaults)
2. `<repo>/.bakudo/config.toml`     (repo overrides)
3. `-c <path>`                      (CLI-explicit file; suppresses layering)

Each layer may set any subset of fields; later layers override earlier ones.

## Architecture

Bakudo is a Cargo workspace with three main crates plus a thin root binary:

1. `bakudo-core`: Protocol types, config loading, provider registry, state models, and the `abox` adapter.
2. `bakudo-daemon`: Session orchestration, task execution, divergence queries, doctor probes, and worktree lifecycle decisions.
3. `bakudo-tui`: Application state, slash command parsing, transcript/shelf rendering, and keyboard interaction.
4. `bakudo-worker`: Small wrapper that runs inside an abox sandbox and emits structured `BAKUDO_EVENT`/`BAKUDO_RESULT` envelopes around provider output.
5. `src/main.rs`: CLI entrypoint and TUI bootstrap.

See [AGENTS.md](AGENTS.md) for development invariants and [docs/current-architecture.md](docs/current-architecture.md) for the current implementation walkthrough. Historical design drafts remain in `docs/` and are marked as archived.

## Development

```bash
just check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release
```

## License

This project is private and intended for internal use.
