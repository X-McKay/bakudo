# Bakudo

Bakudo is a lightweight, high-autonomy agent harness designed for executing complex tasks inside isolated `abox` sandboxes. 

Version 2 is a complete rewrite in Rust, featuring a polished `ratatui` terminal interface, provider-agnostic headless execution, and a robust concurrency model.

## Features

- **Provider Agnostic**: Run Claude Code, Codex, OpenCode, or Gemini CLI headlessly. Prompts are injected via `stdin` and structured specs are mounted into the sandbox.
- **Preserved Worktrees**: The host (bakudo) owns the worktree lifecycle. When a task finishes, Bakudo evaluates the divergence and decides whether to automatically `abox merge` or preserve the worktree for manual review.
- **Polished TUI**: A responsive, non-blocking `ratatui` interface featuring a main chat pane, an observability shelf for tracking running sandboxes, and slash commands (`/provider`, `/model`, `/apply`, `/discard`, `/ls`).
- **Multi-Mission Multiplexing**: A robust `SandboxLedger` and `MacroSession` handle concurrent objective dispatches and wallet/budget reservations safely.
- **Crash Recovery**: Uses `abox list` to reconcile running sandboxes and recover state if the host crashes.

## Prerequisites

- **Rust**: Stable toolchain (install via `rustup`).
- **abox**: Version `0.3.1` or later.
- **just**: Command runner (install via `cargo install just` or `mise`).

## Installation

Clone the repository and build from source:

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

### Slash Commands

Inside the TUI, you can use the following slash commands:

- `/provider <name>` — Set the active provider (e.g., `claude`, `codex`, `opencode`).
- `/model <name>` — Set the active model (e.g., `claude-3-opus-20240229`).
- `/apply <task-id>` — Manually merge a preserved worktree that requires review or has conflicts.
- `/discard <task-id>` — Discard a preserved worktree and destroy the sandbox.
- `/diverge <task-id>` — Show the git divergence (diff) of a preserved worktree.
- `/ls` — List all running and preserved sandboxes.
- `/quit` (or `Ctrl+C`) — Exit the application.

## Architecture

Bakudo is structured as a Cargo workspace with three primary crates:

1. **`bakudo-core`**: Pure domain logic. Defines the protocol types, provider registry, configuration schema, state models, and the `abox` adapter.
2. **`bakudo-daemon`**: The async execution engine. Owns the `SessionController`, `TaskRunner`, worktree lifecycle evaluation, and the `MacroSession` for multi-mission orchestration.
3. **`bakudo-tui`**: The terminal interface. Owns the `ratatui` rendering loop, keyboard event handling, and slash command parsing.

See `AGENTS.md` for detailed architecture invariants and development guidelines.

## Development

Bakudo uses `just` as its task runner.

```bash
# Run the full quality gate (format, lint, test)
just check

# Build the project
just build

# Run tests
just test
```

### Agent Workflows

This repository includes `.claude/skills` that define the exact conventions and workflows for AI agents working on the codebase. See `AGENTS.md` for the strict rules governing state mutation, crate boundaries, and provider invocations.

## License

This project is private and intended for internal use.
