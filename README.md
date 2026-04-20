# Bakudo Agent Harness

`Bakudo` is a lightweight, robust custom agent harness designed for high-autonomy operation within `abox` sandboxing environments. Built with TypeScript and a focus on functional programming, it provides a secure and scalable foundation for building autonomous agents.

> Current status: the interactive shell is transcript-first with persisted active-session continuity. Plain text continues the active session by default; explicit slash commands manage sessions, modes, inspection, and approvals. Legacy `--goal` mode still exists as a compatibility path.

### On-disk layout

Bakudo splits its on-disk state between repo-local and user-global locations. Repo-local state stays under `<repo>/.bakudo/` (config overlay, per-repo session store, host state, durable approvals). User-global state — local-only OTel spans, time-delta logs, startup profiles, heap snapshots — lives under `$XDG_DATA_HOME/bakudo/log/` (defaults to `~/.local/share/bakudo/log/`). On first launch bakudo runs a one-way migration that moves any legacy `~/.bakudo/log/`, `~/.bakudo/spans/`, or `<repo>/.bakudo/log/` directory into the XDG location and stamps a marker (`.migrated-v1-to-v2`) so subsequent launches are no-ops. The migration is logged once via `host.migration_v1_to_v2` (on the `host.event_skipped` envelope). `bakudo doctor` reports the active layout under `storage.layout`. The repo-local `.bakudo/` directory is runtime state and should remain gitignored.

## Core Features

- **Planner → Executor Contract**: Explicit step contracts with dependencies and acceptance metadata to ensure predictable execution.
- **Mode-Aware Policy Engine**: Deterministic policy evaluation for `plan`, `build`, and `review` modes with configurable tool allowlists and autonomy budgets.
- **Parallel Workstreams**: Efficient management of concurrent workstreams over ephemeral `abox run --task` sandboxes.
- **Durable Traces**: Detailed step-by-step traces and periodic checkpoint summaries for auditability and debugging.
- **TypeScript First**: Aligns with modern agent ecosystems (MCP-first integrations, server/CLI UX) while maintaining a lightweight core with zero runtime dependencies.

## Architecture (Phase 3)

Every user prompt flows through a deterministic pipeline:

```
user prompt → intent classification → attempt compilation → bounded sandbox dispatch → structured review
```

**Intent classification** (`intentClassifier.ts`): deterministic heuristic rules classify the prompt into one of four kinds:

| Intent Kind | Trigger | Task Kind | Engine |
|---|---|---|---|
| `implement_change` | Default for standard/autopilot mode | `assistant_job` | `agent_cli` |
| `inspect_repository` | Plan mode prompt | `assistant_job` | `agent_cli` |
| `run_check` | "run tests", "execute lint", etc. | `verification_check` | `shell` |
| `run_explicit_command` | `/run-command <cmd>` | `explicit_command` | `shell` |

**Attempt compilation** (`attemptCompiler.ts`): transforms the intent into an `AttemptSpec` (schema v3) with mode-derived permissions, budget constraints, acceptance checks, and artifact requests.

**Dispatch** (`executeAttempt.ts`): executes the spec in an abox sandbox via `runAttempt`, persists the `attemptSpec` on the `SessionAttemptRecord`, and runs structured review.

**Structured review** (`reviewer.ts` / `reviewAttemptResult`): checks `AttemptExecutionResult.checkResults` for acceptance verification. All checks passed + exit 0 = success. Otherwise falls through to the heuristic classifier.

**Permission model**: deny-precedence invariant. A `deny` rule always overrides `allow`, even in autopilot mode. Permissions are compiled from the composer mode's agent profile at spec compilation time.

**`/run-command` escape hatch**: bypasses intent classification, compiles directly to `explicit_command` with `engine: "shell"` and `command: ["bash", "-lc", "<raw>"]`.

**Control-plane dispatch** (`planner.ts` / `executeAttempt.ts`): the planner produces a `DispatchPlan` with an `ExecutionProfile` (`agentBackend`, `sandboxLifecycle`). `executeAttempt` drives the abox sandbox via `WorkerDispatchInput`. The legacy `createTaskSpec` → `executeTask` path and `WorkerTaskSpec` type have been removed.

## Project Structure

- `src/models.ts`: Shared domain types, including `Mode`, `RiskLevel`, `PlanStep`, and autonomy budgets.
- `src/policy.ts`: The deterministic policy engine for evaluating tool risks and permits.
- `src/tools.ts`: Tool registry and normalized error handling for harness operations.
- `src/aboxAdapter.ts`: Adapter for stream-scoped command execution via the `abox` binary.
- `src/orchestrator.ts`: The central planner, coordinator, and executor loop.
- `src/memory.ts`: Session memory management and trace logging.
- `config/`: JSON configuration profiles for different runtime environments.
- `tests/`: Comprehensive test suite including unit, integration, and regression tests.
- `.claude/skills/`: Specialized AI skills for development, testing, and release management.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v22 or later)
- [abox](https://github.com/X-McKay/abox)
- [pnpm](https://pnpm.io/) for source builds
- [mise](https://mise.jdx.dev/) (optional, for environment management)
- [just](https://github.com/casey/just) (optional, for task automation)

### Installation

Install the latest released CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/X-McKay/bakudo/main/scripts/install.sh | bash
bakudo doctor
```

If you are working from source instead of a release bundle:

```bash
pnpm install
pnpm install:cli
bakudo --help
```

`pnpm install:cli` builds the current checkout and installs a global pnpm link,
so `bakudo` resolves from any directory on a shell that already has the pnpm
global bin directory on `PATH`.

To prepare a local release bundle for smoke testing or a release draft:

```bash
just release-bundle
```

### Usage

Run the new host CLI with explicit host intent:

```bash
pnpm start -- plan "inspect why the harness exited 0 on failure" --repo /path/to/repo
pnpm start -- build "add a richer review screen for sandbox results" --repo /path/to/repo --yes
```

Start the interactive shell:

```bash
bakudo
```

Inside the interactive shell, plain text continues the active session as a new turn. Slash commands manage session state, mode, and inspection:

```text
/new                                    # start a fresh session
/resume [session-id]                    # resume the most recent (or named) session
/sessions                               # browse saved sessions
/inspect [summary|review|sandbox|artifacts|logs]
/mode [standard|plan|autopilot]         # composer mode; standard = code-changing
/autopilot [on|off]                     # equivalent to /mode autopilot
/compact                                # summarize older turns (Phase 2)
/clear                                  # clear the on-screen transcript
/init                                   # write repo-local AGENTS.md template
/help                                   # contextual command list
/exit                                   # exit the shell

# Legacy compatibility aliases (still functional):
/run /build /plan /status /tasks /review /sandbox /logs /approve
```

A bare prompt is interpreted as a goal for the active session. There is no "new session per prompt" — a new session is created only on first launch (when none exists) or after `/new`.

Example transcript:

```text
Bakudo  STANDARD  session 8ab12cd3  bakudo

You: add a richer review surface for sandbox results
Bakudo: Queued sandbox attempt.
Bakudo: Sandbox worker started.
Bakudo: Worker is producing output.
Bakudo: Worker completed. Reviewing result.
Review: accepted — 3 files changed and targeted tests passed.

[inspect]  [help]
>
```

Inspect a saved session:

```bash
bakudo sessions
bakudo status
bakudo status <session-id>
bakudo tasks <session-id>
bakudo sandbox <session-id>
bakudo review <session-id>
bakudo logs <session-id>
bakudo resume <session-id>
bakudo init --repo /path/to/repo --yes
```

### JSON output

All listing and inspection commands support `--json` (alias for `--output-format=json`). Output is JSONL: one JSON record per line, using the same model types as the internal storage layer (`SessionIndexEntry`, `SessionRecord`, `SessionEventEnvelope`, `ArtifactRecord`).

```bash
bakudo sessions --json          # one SessionIndexEntry per line
bakudo status --json            # summaries, or full SessionRecord with --session-id
bakudo logs <session-id> --json # one SessionEventEnvelope per line
bakudo review <session-id> --json
bakudo sandbox <session-id> --json
```

### Flag compatibility

Phase 5 wires the Copilot-parity flag namespace through all three renderer
backends (TTY / plain / JSON). Three flags are confirmed parity with the
public GitHub Copilot CLI; the remaining three are documented as
bakudo-specific reframes because their semantics are not publicly spec'd.

| Flag | Parity | Semantics |
| --- | --- | --- |
| `-p, --prompt <text>` | Copilot parity | One-shot: run the prompt end-to-end and exit. |
| `--output-format=json` | Copilot parity | JSONL stream on stdout. Review summary is emitted as a `review_completed` envelope. |
| `--allow-all-tools` | Copilot parity | Forces Autopilot mode. Deny rules still win. |
| `--stream=off` | **Bakudo-specific** | Buffer stdout until the worker terminal event. |
| `--plain-diff` | **Bakudo-specific** | Strip ANSI escape sequences from `kind: "diff"` artifacts before persistence. |
| `--no-ask-user` | **Bakudo-specific** | `launchApprovalDialog` throws `--no-ask-user: approval required for <tool>(<arg>)`; exit code 2 per Phase 6 error taxonomy. |
| `--max-autopilot-continues=N` | **Bakudo-original** | Cap unattended Autopilot continue chains (default 10). Halts with `autopilot continue limit reached`. |

Example one-shot:

```bash
bakudo -p "run tests in ./cli" --output-format=json --no-ask-user
```

### Session model

Sessions follow a **session -> turns -> attempts** hierarchy:

- A **session** is a multi-turn conversation. Each session has a title derived from its first prompt.
- A **turn** is one user prompt and its dispatched work. Turns carry a `latestReview` after the first attempt completes.
- An **attempt** is a single sandbox execution within a turn. Failed attempts can be retried, appending new attempts to the same turn.

Turn and attempt IDs are scoped to their session (e.g. `turn-1`, `1:session-abc:turn1-attempt-1`).

### Config cascade

Configuration is resolved in priority order: CLI flags > override file > repo-local `.bakudo/config.json` > user `~/.config/bakudo/config.json` > built-in defaults. Use `/config show` in the interactive shell to inspect the merged result.

### Event log

Each session records a structured event log at `.bakudo/sessions/<id>/events.ndjson`. Events use the `SessionEventEnvelope` schema (v2) and cover the full lifecycle: `user.turn_submitted`, `host.dispatch_started`, `worker.attempt_*`, `host.review_*`, `host.artifact_registered`.

`Bakudo` makes the host/worker split explicit in the terminal UX:

- **Modes**: `standard` for code-changing work, `plan` for read-only discovery, `autopilot` for unattended execution that bypasses approval prompts.
- **Sessions** are conversation-oriented: each turn appends to the active session, with one or more sandbox attempts per turn. The active session is persisted at `<repo>/.bakudo/host-state.json` and restored on the next shell launch.
- **`/inspect`** unifies the previously separate `review`, `sandbox`, `artifacts`, and `logs` surfaces. Raw event streams are still available via `/inspect logs`; the default summary highlights reviewed outcome and provenance.
- **Worker narration**: the shell shows assistant-style status lines (`Worker is producing output.`) instead of raw event names. Full event detail is available in `/inspect logs`.
- **Provenance** stays first-class: every attempt records its sandbox task ID, dispatch command, and artifact paths, accessible via `/inspect sandbox` and `/inspect artifacts`.

### Approvals

Bakudo asks before risky actions in standard mode and persists every decision:

- **Interactive prompt** shows the pending operation, the matched rule set, and four choices: `[1] allow once`, `[2] allow always`, `[3] deny`, `[4] show context`.
- **Deny-precedence invariant**: any `deny` rule wins, even against an `allow` in a higher layer and even in autopilot. `/allow-all on` does NOT bypass deny.
- **Durable allowlist**: `allow always` appends a `PermissionRule` to `<repo>/.bakudo/approvals.jsonl` that survives across sessions; `/allow-all show` lists it; `/allow-all off` removes a session-scoped rule.
- **Audit log**: every approval (including hook-sourced auto-approvals and deny-short-circuits) writes an `ApprovalRecord` to `<storage>/<session>/approvals.ndjson`, plus `host.approval_requested` + `host.approval_resolved` envelopes in the session event log.

Use `/allow-all on|off|show` to manage the session-scoped `allow_all_tools` rule.

### Inspect tabs

`/inspect [tab]` shows one of six tabs backed by the durable session records:

- `summary` — turn status, goal, review outcome, retry lineage.
- `review` — the reviewer's outcome, action, reason, and confidence grade.
- `provenance` — active agent profile, attempt spec, abox dispatch command, sandbox task ID, env allowlist, exit details. Renamed from `sandbox` (the old alias still routes here).
- `artifacts` — registered artifact paths (results, patches, summaries, logs).
- `approvals` — chronological `ApprovalRecord` entries with rationale and matched rule.
- `logs` — raw `SessionEventEnvelope` stream.

### /timeline

`/timeline` opens a turn-level rollback picker. Each row shows `turn-N status agent-profile · brief goal summary · timestamp`. Selecting a row offers `inspect this turn` (read-only) or `restart from this turn` (creates a new turn whose `parentTurnId` is the selected turn and writes a `TurnTransition { reason: "user_rewind" }`).

### /usage

`bakudo usage` / `/usage` reports per-session token + attempt totals derived from the Phase 2 append-only event log. No new envelope kinds are introduced; the reader tolerates payloads with or without token accounting.

```bash
bakudo usage --session <id>            # rollup for one session (TTY table)
bakudo usage --since 7d                # last week across every session
bakudo usage --format json             # machine-readable envelope
```

In the shell, `/usage` defaults to the active session. Flags supported: `--session <id>`, `--since <duration>`, `--format text|json`.

### /chronicle

`bakudo chronicle` / `/chronicle` queries the cross-session event log (the same indexed store `/inspect` reads) so operators have a scriptable audit surface without ad hoc log greps. Plan reference: [`plans/bakudo-ux/06-rollout-reliability-and-operability.md:782-791`](../plans/bakudo-ux/06-rollout-reliability-and-operability.md).

```bash
bakudo chronicle --since 7d            # envelopes newer than 7 days
bakudo chronicle --tool shell          # envelopes whose payload references a tool
bakudo chronicle --approval denied     # host.approval_resolved with denied / auto_denied
bakudo chronicle --session <id>        # restrict to a single session
bakudo chronicle --format json         # NDJSON stream (one envelope per line)
```

Filters are ANDed. In the shell, `/chronicle` defaults to `--since 24h --session <active>`.

### /metrics

`bakudo metrics` / `/metrics` prints the in-memory UX success-metrics bucket
(Phase 6 Workstream 7, plan lines 430-461). The bucket tracks shell-startup
latency, time-to-first-render, prompt-to-host-line latency, worker-to-review
latency, session-listing latency, and per-workflow command counts. Snapshot is
side-channel only — never emitted as a `SessionEventEnvelope`. See
[`plans/bakudo-ux/06-rollout-reliability-and-operability.md:426-463`](../plans/bakudo-ux/06-rollout-reliability-and-operability.md).

```bash
bakudo metrics                  # text table (TTY default)
bakudo metrics --format=json    # machine-readable snapshot
bakudo metrics --json           # alias for --format=json (lock-in 12)
```

The thresholds (plan 443-448) are asserted by
`tests/unit/metricsThresholds.test.ts`; the dropped-batch SLO (plan 804-811)
by `tests/integration/dropped-batch-slo.test.ts`. Scripted benchmarks live
under `tests/benchmarks/*.bench.ts` — invoke manually, e.g.:

```bash
pnpm build && node dist/tests/benchmarks/open-shell-and-resume-latest.bench.js
```

### Provenance

Every dispatch persists a `ProvenanceRecord` to `<storage>/<session>/provenance.ndjson` with:

- `attemptId`, `sandboxTaskId`, `dispatchCommand[]`, the active agent profile (name + autopilot flag), `permissionRulesSnapshot[]`, `envAllowlist[]`, `workerEngine`, `taskMode`, `composerMode`.
- Finalisation appends `exitCode`, `exitSignal`, `timedOut`, `elapsedMs`.

Records are read by the `provenance` inspect tab and answer "what exactly ran and why was it allowed?" without falling back to raw log parsing.

Legacy compatibility mode is still available:

```bash
pnpm start -- --goal "your goal here" --streams stream1,stream2 --repo /path/to/repo
```

Or run directly via Node:

```bash
node dist/src/cli.js --goal "your goal here" --config config/default.json --streams s1,s2 --repo /path/to/repo
```

### UI rollout mode (`--ui`)

Phase 6 Workstream 1 stages the UX migration as explicit, reversible rollout
states. The active state is selected with `--ui <mode>` and reported by
`bakudo doctor` under `ui mode`. Full checklist:
[`plans/bakudo-ux/phase-6-rollout-checklist.md`](../plans/bakudo-ux/phase-6-rollout-checklist.md).

| Mode | Stage | Purpose |
| --- | --- | --- |
| `preview` | A | Opt-in preview of the new host UX. |
| `default` | B | New UX is the default (current stage). |
| `legacy` | B → C | Escape hatch to the legacy `--goal` surface. |
| `hidden` | C | Alias for `default`; legacy hidden from help. |

Rollback: `bakudo --ui legacy …` invokes the legacy surface for a single
invocation. The flag remains functional for at least one release cycle after
the rollout reaches Stage C (plan 06, hard rule 2). `--ui` values are
validated at parse time — invalid values fail with exit code 2 before any
sandbox work begins.

## Operations

Day-to-day operator commands delivered in Phase 6. See also
[`plans/bakudo-ux/phase-6-rollout-checklist.md`](../plans/bakudo-ux/phase-6-rollout-checklist.md).

### Pruning stale artifacts (`bakudo cleanup`)

`bakudo cleanup` walks every session under the repo's storage root and
removes intermediate artifacts older than the retention window. Protected
kinds (`result`, `summary`, `report`) and per-session record files
(`session.json`, `events.ndjson`, `transitions.ndjson`, `provenance.ndjson`,
`approvals.ndjson`, `artifacts.ndjson`, `cleanup.ndjson`, `session.lock`)
are never pruned regardless of age (plan 06, hard rule 3).

```bash
bakudo cleanup [--dry-run] [--older-than <duration>] [--session <id>]
```

- `--dry-run` — report what *would* be removed without touching disk. Always
  run this first.
- `--older-than <dur>` — override the default 30-day retention window.
  Accepts `30d`, `7d`, `6h`, `45m`.
- `--session <id>` — scope the pass to a single session.

Every real deletion appends a line to the session's `cleanup.ndjson` so
`/inspect` and `bakudo chronicle` surface pruned artifacts as "deleted under
policy" rather than "missing".

### Crash and interruption recovery

bakudo holds an exclusive lock on the session directory across every write.
When a session resumes, the recovery gate classifies the prior state:

| Verdict | Meaning | Resumable? |
| --- | --- | --- |
| `running_incomplete` | An attempt started but never recorded a terminal event (crash mid-dispatch). | No — blocks resume until cleared. |
| `finished_no_review` | An attempt finished but no review verdict was stored. | Yes, informational. |
| `stale_lock` | Prior `session.lock` is older than the liveness threshold and its owner is gone. | Yes — the lock is cleared automatically. |

Stable exit codes (plan 06 §Exit Semantics): `0` success, `1` failure,
`2` blocked, `3` policy-denied, `4` worker-protocol-mismatch,
`5` session-corruption (includes live-lock contention against another
running bakudo), `130` SIGINT (`Ctrl+C`).

Run `bakudo doctor` for the aggregate health picture across every session.

## Development and Testing

`Bakudo` maintains a high bar for code quality through automated linting, formatting, and a multi-layered testing strategy.

### Available Scripts

- `pnpm test`: Build the project and run all tests.
- `pnpm lint`: Run ESLint to check for code quality issues.
- `pnpm format`: Format the codebase using Prettier.
- `pnpm build`: Compile the TypeScript source code to the `dist/` directory.

### Task Automation (via `just`)

If you have `just` installed, you can use the following shortcuts:

- `just check`: Run linting, tests, and build in sequence.
- `just clean`: Remove build artifacts.
- `just release-bundle`: Build the release tarball and checksum manifest under `dist/release/`.

## AI-Driven Workflow

This repository includes structured **Claude Skills** in the `.claude/skills/` directory. These skills guide AI agents through common tasks such as:

- **Feature Development**: Implementing new functionality following the established architecture.
- **Bug Fixing**: A rigorous process of reproduction and verification.
- **Testing**: Guidelines for maintaining the multi-layered test suite.
- **Release Management**: Standardized versioning and branch management conventions.

## License

This project is private and intended for internal use.
