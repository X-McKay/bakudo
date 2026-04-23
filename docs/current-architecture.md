# Current Architecture

This document describes the implementation that currently ships on `v2-architecture-plan`. Use it as the source of truth for behavior, crate boundaries, and runtime expectations.

## Overview

Bakudo runs provider tasks inside `abox` sandboxes and manages the resulting worktrees from the host. Tasks can be launched from either the TUI or the headless `bakudo run` command.

The runtime is intentionally small:

1. `src/main.rs` loads config, constructs shared services, and starts either the TUI loop or a single headless run.
2. `SessionController` receives typed `SessionCommand`s, applies the execution policy, dispatches attempts, and emits typed `SessionEvent`s.
3. `TaskRunner` writes the `AttemptSpec`, launches `abox run`, streams worker output, and records state transitions in the `SandboxLedger`.
4. `worktree.rs` applies the host-side candidate policy after successful runs.
5. Optional post-run hooks receive a JSON payload after the final sandbox state is known.

## Crate Responsibilities

- `bakudo-core`: Protocol types, config loading, provider registry, `abox` adapter, and shared state models.
- `bakudo-daemon`: Session orchestration, task execution, divergence queries, and worktree lifecycle management.
- `bakudo-tui`: Application state, slash command parsing, transcript/shelf rendering, and keyboard interaction.
- `src/main.rs`: CLI entrypoint and TUI bootstrap.

## Provider Execution Model

Providers are defined in `bakudo-core/src/provider.rs`.

- Bakudo never hard-codes provider flags outside the registry.
- Prompts are forwarded through `stdin` using `ProviderSpec::build_worker_command(...)`.
- The execution policy can allow, prompt, or forbid a provider launch and can independently enable or disable the provider's "allow all tools" flag.
- Each run also receives `BAKUDO_PROMPT`, `BAKUDO_SPEC_PATH`, and `BAKUDO_TASK_ID`.
- Provider specs can supply sandbox sizing hints (`memory_mib`, `cpus`), and those are forwarded to `abox run`.

## State Model

`SandboxLedger` is the single source of truth for sandbox state observed by the daemon and TUI.

- New runs start as `Starting`, then move to `Running`.
- Successful runs become `Preserved` until a host-side candidate policy changes them to `Merged` or `Discarded`.
- Failed runs become `Failed { exit_code }`.
- Timed out runs become `TimedOut`.
- Merge conflicts become `MergeConflicts`.

Startup recovery is ledger-based:

1. Bakudo calls `abox list`.
2. The ledger reconciles any missing running sandboxes as failed.
3. The TUI receives a `LedgerSnapshot` and rebuilds the shelf from it.

The persisted ledger is repo-scoped. Each repository gets its own runtime state directory under the configured Bakudo data root, so preserved sandboxes from one repo do not leak into another repo's TUI session.

## Worktree Lifecycle

Bakudo uses a host-owned preserved-worktree model.

- `Review`: leave the worktree preserved for manual `/apply`, `/discard`, or CLI actions.
- `AutoApply`: call `abox merge` on success.
- `Discard`: call `abox stop --clean`.

The agent inside the sandbox never merges its own changes.

## TUI Contract

The TUI only communicates with the daemon through channels.

- `SessionCommand`: dispatch, provider/model changes, apply/discard/diverge, shutdown.
- `SessionEvent`: startup ledger snapshot, task lifecycle events, provider changes, info, and errors.

The TUI does not spawn sandbox work directly. It renders transcript output and shelf state derived from the daemon and ledger.

Interactive transcript history is persisted to a repo-scoped JSONL log and reloaded on `bakudo resume`, so resume restores both preserved sandboxes and the visible transcript instead of only rebuilding the shelf from the ledger.

## Headless Contract

`bakudo run` now supports two machine-facing integrations:

- `--json`: emit newline-delimited JSON events for task start, progress, raw output, errors, and the final summary.
- `--output-schema <path>`: validate the final summary object against a JSON Schema file before returning success.

If `post_run_hook` is configured, Bakudo writes a JSON payload describing the completed run to the hook's stdin after the final state is known.

## Testing Strategy

The current test suite is layered:

- Unit tests for protocol/config/provider/state logic.
- Deterministic fake-`abox` integration tests in `tests/runtime.rs`.
- TUI state and render tests.
- Optional live smoke tests against installed `abox 0.3.1` when available locally.

The expected verification commands are:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release
```

## Historical Documents

Files under `docs/archive/` are historical design drafts. They are retained for context only and do not describe the current shipping implementation.
