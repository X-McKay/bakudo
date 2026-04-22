# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-21

### Changed
- **Complete Rust Rewrite**: The entire TypeScript/Node.js codebase has been removed and replaced with a high-performance Rust workspace.
- **Provider Agnosticism**: Removed hard-coded MCP wiring. Providers (Claude Code, Codex, OpenCode, Gemini CLI) are now invoked headlessly via `stdin` using their native CLI arguments.
- **Preserved Worktree Lifecycle**: Bakudo now fully embraces the host-owned merge/discard lifecycle. The agent never merges its own code; Bakudo evaluates divergence and handles `abox merge` or preserves the worktree for manual review.
- **TUI Revamp**: Replaced the React/Ink interface with a highly polished `ratatui` terminal interface. Features a chat pane, observability shelf, slash commands, tab-completion, bracketed paste, and adaptive color palettes.
- **Concurrency & State**: Implemented a robust `SandboxLedger` and `MacroSession` semaphore to handle multi-mission multiplexing and wallet reservation races safely.
- **Crash Recovery**: PID files have been replaced with `abox list` reconciliation to accurately track running and preserved sandboxes even if the host crashes.
- **Developer Experience**: Replaced `npm` scripts with `just`. Switched from ESLint/Prettier to `cargo clippy` and `cargo fmt`. Updated all `.claude/skills` to reflect the new Rust architecture.

### Removed
- All TypeScript source files, tests, and configuration (`src/`, `tests/`, `package.json`, `tsconfig.json`, `eslint.config.js`, etc.).
- Legacy integration plans and examples (`plans/`, `examples/`).
- Legacy documentation referring to the Node.js runtime.
