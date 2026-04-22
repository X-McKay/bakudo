# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `bakudo-worker` crate: a minimal in-sandbox wrapper that emits structured `BAKUDO_EVENT` / `BAKUDO_RESULT` envelopes around provider output so the host can render tool-call / assistant-message events instead of raw stdout.
- `/doctor` slash command and `bakudo doctor` subcommand: probe `abox --version` and every registered provider binary, surfacing missing tools in one shot.
- `/diff <task-id>` slash command: fetches divergence output and renders it with diff-aware colors in the transcript (hunk headers / added / removed lines).
- `bakudo resume <session-id>` subcommand: rehydrates a prior session from the on-disk ledger.
- Layered config loader: `~/.config/bakudo/config.toml` → `<repo>/.bakudo/config.toml` → explicit `-c` path.
- Persistent `SandboxLedger` backed by JSONL at `<data-dir>/ledger.jsonl`; reconcile now ingests unknown `abox list` entries so recovery works across process restarts.
- GitHub Actions CI (`fmt --check`, `clippy -D warnings`, `cargo test --workspace`).

### Changed

- `model` fields (`AttemptSpec`, `SandboxRecord`, `SessionRecord`, `BakudoConfig::default_model`, TUI app state) are now `Option<String>`; the empty-string sentinel is still accepted by the deserializer but normalised to `None`.
- `ProviderRegistry` uses `BTreeMap` for deterministic iteration.
- `parse_list_output` now uses header-derived fixed-width column offsets, tolerating multi-word `vm_state` values like `"merge conflicts"`.
- `worktree.rs` exposes explicit `merge_sandbox` / `discard_sandbox` helpers instead of routing `Discard` through `apply_candidate_policy` with an empty `base_branch`.
- `push_message` now keeps the absolute scroll position stable when the user is scrolled up and new lines arrive.
- `PROTOCOL_SCHEMA_VERSION` reset to `1` (no prior v1/v2 ever shipped).

### Fixed

- Enabled bracketed-paste and focus-change terminal features at startup (previously claimed but never initialised), and wired SIGINT/SIGTERM into a clean shutdown.
- Terminal state is now restored by an RAII guard that runs even on panic.
- Startup recovery now reliably surfaces sandboxes that outlived the previous bakudo process.

### Removed

- Unused dependencies: `tokio-util` (bakudo-core), `strum_macros` direct dep, `unicode-segmentation` (bakudo-tui), `tracing-subscriber`, `thiserror`, `anyhow`, `uuid`, `serde` (bakudo-daemon), `serde`/`serde_json` (bakudo-tui), and `tracing-subscriber` fmt feature re-declaration.
- Dead palette helpers (`luminance`, `is_light_bg`, `blend`, `user_msg_bg`).

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
