# Bakudo Agent Harness

`Bakudo` is a lightweight, robust custom agent harness designed for high-autonomy operation within `abox` sandboxing environments. Built with TypeScript and a focus on functional programming, it provides a secure and scalable foundation for building autonomous agents.

> Current status: the interactive shell is transcript-first with persisted active-session continuity. Plain text continues the active session by default; explicit slash commands manage sessions, modes, inspection, and approvals. Legacy `--goal` mode still exists as a compatibility path.

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

**Legacy compatibility**: `createTaskSpec` and `executeTask` are deprecated but preserved. Sessions created before Phase 3 lack `attemptSpec` on their attempts; the inspect surface synthesizes a display-only legacy spec via `synthesizeLegacySpec`.

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
- [pnpm](https://pnpm.io/)
- [mise](https://mise.jdx.dev/) (optional, for environment management)
- [just](https://github.com/casey/just) (optional, for task automation)

### Installation

```bash
pnpm install
```

Install the CLI into your local environment so you can launch it as `bakudo`:

```bash
pnpm install:cli
bakudo
bakudo --help
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

Legacy compatibility mode is still available:

```bash
pnpm start -- --goal "your goal here" --streams stream1,stream2 --repo /path/to/repo
```

Or run directly via Node:

```bash
node dist/src/cli.js --goal "your goal here" --config config/default.json --streams s1,s2 --repo /path/to/repo
```

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

## AI-Driven Workflow

This repository includes structured **Claude Skills** in the `.claude/skills/` directory. These skills guide AI agents through common tasks such as:

- **Feature Development**: Implementing new functionality following the established architecture.
- **Bug Fixing**: A rigorous process of reproduction and verification.
- **Testing**: Guidelines for maintaining the multi-layered test suite.
- **Release Management**: Standardized versioning and branch management conventions.

## License

This project is private and intended for internal use.
