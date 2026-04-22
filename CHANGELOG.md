# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-21

### Changed

- Complete Rust rewrite of the prior TypeScript/Node.js implementation.
- Provider invocation now goes through stdin-driven native CLIs with provider-defined sandbox sizing hints.
- Bakudo now uses a host-owned preserved-worktree lifecycle: the agent never merges its own changes.
- The TUI is now `ratatui`-based with transcript, observability shelf, slash commands, and richer task metadata.
- Runtime state recovery is ledger-backed and reconciled against `abox list`.
- Test coverage now includes deterministic fake-`abox` runtime integration tests, TUI regression coverage, and optional live smoke tests against installed `abox 0.3.1`.
- Documentation now separates the current implementation from archived design drafts.

### Removed

- Unused `MacroSession` and objective-orchestration scaffolding that no longer matched the shipping runtime.
- All TypeScript source files, tests, and configuration (`src/`, `tests/`, `package.json`, `tsconfig.json`, `eslint.config.js`, etc.).
- Legacy integration plans and examples (`plans/`, `examples/`).
- Legacy documentation that described the Node.js runtime as current behavior.
