# Current Architecture

This document describes the implementation that currently ships on `v2-architecture-plan`. Use it as the source of truth for behavior, crate boundaries, and runtime expectations.

## Overview

Bakudo has two execution modes that share the same Rust runtime:

1. A classic one-shot task path used by `bakudo run` and `bakudo swarm`.
2. A durable mission path used by the TUI, `bakudo daemon`, and `bakudo status`.

The interactive mission path is explicitly layered:

1. `src/main.rs` loads config, constructs shared services, and starts either the TUI loop, a headless one-shot command, the headless daemon, or the repo mission status view.
2. `SessionController` is the typed command/event boundary for the TUI and host CLI. It preserves the restored conversational host layer and routes host turns into the mission runtime instead of directly deleting or bypassing them.
3. `MissionCore` inside `SessionController` acts as the supervisor. It persists mission state, maintains the wake queue, enforces the wallet, and resumes active missions after restart.
4. `run_deliberator()` launches the active mission provider as a deliberator process over stdio and answers tool calls through a JSON-RPC-like MCP transport.
5. `TaskRunner` and `run_experiment()` still launch `abox run`, stream progress, and update the `SandboxLedger` for classic runs and mission experiments alike.
6. `worktree.rs` still applies the host-side candidate policy after successful one-shot runs.

## Crate Responsibilities

- `bakudo-core`: Protocol types, config loading, provider registry, swarm plan validation, `abox` adapter, and shared state models.
- `bakudo-daemon`: Session orchestration, mission supervisor/deliberator runtime, durable mission storage, divergence queries, and worktree lifecycle management.
- `bakudo-tui`: Application state, slash command parsing, transcript/shelf rendering, and keyboard interaction.
- `src/main.rs`: CLI entrypoint and TUI bootstrap.

## Provider Execution Model

Bakudo now has two provider-loading paths:

- Classic one-shot runs use `bakudo-core/src/provider.rs` and `ProviderRegistry`.
- Autonomous missions use `ProviderCatalog` from `bakudo-daemon/src/provider_runtime.rs`, which loads `.bakudo/providers/*.toml` plus `.bakudo/prompts/*.md` and materializes defaults on demand.

For classic runs:

- Bakudo never hard-codes provider flags outside the registry.
- Prompts are forwarded through `stdin` using `ProviderSpec::build_worker_command(...)`.
- The execution policy can allow, prompt, or forbid a provider launch and can independently enable or disable the provider's "allow all tools" flag.
- Each run also receives `BAKUDO_PROMPT`, `BAKUDO_SPEC_PATH`, and `BAKUDO_TASK_ID`.

For autonomous missions:

- The deliberator process receives `BAKUDO_WAKE_EVENT_PATH`, `BAKUDO_SYSTEM_PROMPT_PATH`, `BAKUDO_MISSION_ID`, `BAKUDO_POSTURE`, `BAKUDO_REPO_ROOT`, and `BAKUDO_MCP_TRANSPORT=stdio`.
- Provider `.toml` files declare the engine, prompt file, abox profile, wake budget, and environment passthrough.
- The current tool surface is:
  `dispatch_swarm`, `abox_exec`, `abox_apply_patch`, `host_exec`, `update_blackboard`, `record_lesson`, `ask_user`, `cancel_experiments`, and `suspend`.
- Every tool result includes a `meta` sidecar with wallet, fleet, posture, pending-user-message, and wake metadata.

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

Autonomous missions add a second durable state model in `MissionStore`:

- `Mission`: top-level objective, posture, provider, wallet, and mission status.
- `Experiment`: each dispatched abox worker, its spec, status, and summary.
- `WakeEvent`: durable wake queue entries, including blackboard, wallet snapshot, user inbox, and recent ledger context.
- `Blackboard`: the mission working memory carried across wakes.
- `UserMessage`: steering from the host layer that should wake or inform the deliberator.
- `LedgerEntry`: durable mission-side decisions, summaries, and lessons.
- `ActiveWaveRecord`: persisted experiment-wave bookkeeping so multi-wave missions survive races and restarts.

The mission store is a repo-scoped SQLite database at:

```text
<bakudo-data>/repos/<repo-scope>/state.db
```

Wake payload snapshots are also written to:

```text
<bakudo-data>/repos/<repo-scope>/wakes/<wake-id>.json
```

## Worktree Lifecycle

Bakudo uses a host-owned preserved-worktree model.

- `Review`: leave the worktree preserved for manual `/apply`, `/discard`, or CLI actions.
- `AutoApply`: call `abox merge` on success.
- `Discard`: call `abox stop --clean`.

The agent inside the sandbox never merges its own changes.

## TUI Contract

The TUI only communicates with the daemon through channels.

- `SessionCommand`: host chat input, mission start/budget/wake commands, approval/question responses, classic dispatch, provider/model changes, apply/discard/diverge, and shutdown.
- `SessionEvent`: startup ledger snapshot, task lifecycle events, mission banner updates, approval prompts, user questions, provider changes, info, and errors.

The TUI does not spawn sandbox work directly. Freeform text is treated as a host turn first, so the daemon can answer status/progress questions, ask clarifying questions, stage a plan, steer an active mission, and only then dispatch sandbox work. The TUI renders transcript output, shelf state, mission wallet/fleet status, and approval/question modals derived from daemon events.

Interactive transcript history is persisted to a repo-scoped JSONL log and reloaded on `bakudo resume`, so resume restores both preserved sandboxes and the visible transcript instead of only rebuilding the shelf from the ledger.

The current mission-oriented slash commands are:

- `/mission <goal>`
- `/explore <goal>`
- `/budget time=<minutes>m workers=<count>`
- `/wake`
- `/lessons`

Classic commands such as `/provider`, `/model`, `/apply`, `/discard`, `/diff`, `/status`, and `/doctor` remain available.

## Headless Contract

`bakudo run` now supports two machine-facing integrations:

- `--json`: emit newline-delimited JSON events for task start, progress, raw output, errors, and the final summary.
- `--output-schema <path>`: validate the final summary object against a JSON Schema file before returning success.

If `post_run_hook` is configured, Bakudo writes a JSON payload describing the completed run to the hook's stdin after the final state is known.

Completed run summaries are persisted under the repo-scoped Bakudo data root, so later host-side queries can read them without re-entering the sandbox. The current CLI control surface is intentionally narrow:

- `bakudo result <task-id>` reads a persisted run summary.
- `bakudo wait <task-id>` polls for a persisted run summary to appear.
- `bakudo candidates` lists preserved and merge-conflict worktrees from the repo-scoped ledger.
- `bakudo artifact --mission ... --path ...` reads a swarm artifact from Bakudo-owned storage.

Bakudo does not expose a generic host `shell`, arbitrary host file write, or host-side patch application surface.

`bakudo swarm --plan <path>` builds on the same execution path, but schedules multiple tasks from a JSON plan:

- `mission_id`, `goal`, and `concurrent_max` describe the overall run.
- Each task may set `id`, `prompt`, `provider`, `model`, `depends_on`, `parent_task_id`, `role`, `goal`, `artifact_path`, `candidate_policy`, `sandbox_lifecycle`, and `approve_execution`.
- `artifact_path` is treated as a logical relative path. Bakudo rejects absolute paths and traversal segments, then writes the JSON summary for that task under a Bakudo-owned repo-scoped mission directory derived from `mission_id`.
- Dependencies gate scheduling, but downstream tasks only see upstream code changes if the upstream task merged them back to the repo, typically via `candidate_policy = "auto_apply"`.

Mission-aware headless commands now include:

- `bakudo daemon`: run the session controller without the TUI.
- `bakudo status`: read the durable mission store for the current repo and print mission posture, state, wallet counters, and goal.

## Testing Strategy

The current test suite is layered:

- Unit tests for protocol/config/provider/state logic.
- Deterministic fake-`abox` integration tests in `tests/runtime.rs`, including wake flow, blackboard updates, wallet enforcement, host approvals, ask-user flow, multi-wave dispatch, lesson persistence, and restart recovery.
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
