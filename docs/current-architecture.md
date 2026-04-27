# Current Architecture

This document describes the runtime that currently ships from `bakudo/`.

It is intentionally implementation-oriented. If you want the product motive and
operator workflow first, read
[product-motive-and-operator-workflow.md](product-motive-and-operator-workflow.md)
before this file.

## Scope and Source of Truth

This document is the source of truth for:

- crate boundaries
- execution paths
- durable state ownership
- mission lifecycle
- worker lifecycle
- worktree ownership
- operator-visible runtime semantics

When older plans disagree with this document, trust the code and this document.
Historical drafts in `docs/archive/` are context only.

## High-Level Topology

Bakudo is a Rust workspace with three main crates plus a thin root binary:

1. `bakudo-core`
2. `bakudo-daemon`
3. `bakudo-tui`
4. `src/main.rs`

At runtime, those pieces form a layered system:

```text
operator
  |
  v
TUI / CLI / daemon entrypoints
  |
  v
SessionController
  |\
  | \-> HostRuntime
  | \-> MissionCore
  | \-> SandboxLedger
  | \-> TraceRecorder
  |
  +---- classic one-shot path ------------------------------+
  |                                                        |
  |                                                        v
  |                                                  TaskRunner
  |                                                        |
  |                                                        v
  |                                                      abox
  |                                                        |
  |                                                        v
  |                                                 provider process
  |
  +---- durable mission path -------------------------------+
                                                           |
                                                           v
                                                     Wake deliberator
                                                           |
                                                           v
                                                   mission MCP tool calls
                                                           |
                                                           v
                                           dispatch_swarm / abox_exec / host_exec
```

The architectural center is `SessionController` plus its embedded mission
runtime. The TUI does not talk to `abox` directly, and the provider does not
own host-side lifecycle decisions.

## Core Runtime Concepts

The implementation uses a small set of durable concepts.

### Session

A session is the local interactive runtime context. It owns:

- active provider and model override for classic runs
- transcript state
- focused mission
- current `SandboxLedger`
- the typed command/event channel boundary between UI and daemon

Sessions are persisted and resumable, but they are not the authoritative home
for mission state.

### Mission

A mission is the durable top-level unit of work. It records:

- goal
- posture
- provider name
- `abox` profile
- wallet
- mission status
- timestamps

Mission rows live in `MissionStore`, not in the TUI.

### Wake

A wake is a single deliberation turn for a mission. A wake begins with a
`WakeEvent` and ends when the deliberator calls:

- `complete_mission(...)`, or
- `suspend(...)`

The wake is the reasoning boundary. It is where the mission conductor inspects
state and decides what to do next.

### Experiment

An experiment is a sandboxed worker launched by the mission runtime through
`dispatch_swarm`. Experiments are persisted and may be:

- script workloads
- provider-backed agent workloads

### Candidate

A candidate is a preserved worktree outcome from a sandbox run. Bakudo owns the
host-side decision to merge, discard, or leave the worktree for review.

## Execution Paths

Bakudo deliberately maintains two execution paths with shared low-level pieces
but different semantics.

### 1. Classic one-shot execution

Used by:

- `bakudo run`
- `bakudo swarm`
- some direct CLI control-plane commands around persisted results

Characteristics:

- the input is a one-off task prompt or plan
- provider selection comes from `ProviderRegistry`
- execution goes through `TaskRunner`
- output is a `WorkerResult` plus a host-owned candidate policy decision
- no durable mission wake loop exists

### 2. Durable mission execution

Used by:

- the TUI
- `bakudo daemon`
- `bakudo status`
- mission-oriented slash commands and host steering

Characteristics:

- the top-level unit is a mission, not a prompt
- provider selection comes from `ProviderCatalog`
- the conductor runs wake-by-wake
- mission state, plan, experiments, questions, and ledger state are durable
- experiments are a subordinate execution tool of the mission

These paths intentionally do not share a fake unified abstraction. They solve
related but different problems.

## Crate Responsibilities

### `bakudo-core`

`bakudo-core` holds the shared domain and protocol layer:

- provider registry for classic runs
- `abox` adapter and `RunParams`
- mission domain types such as `Mission`, `Experiment`, `WakeEvent`,
  `MissionState`, and `Wallet`
- worker protocol envelopes such as `AttemptSpec`, `WorkerProgressEvent`, and
  `WorkerResult`
- shared state models such as `SandboxLedger`
- config loading and repo-scoped data-root resolution
- swarm plan validation and artifact path normalization

This crate should not grow orchestration policy that belongs in the daemon.

### `bakudo-daemon`

`bakudo-daemon` owns the live runtime behavior:

- `SessionController`
- `HostRuntime`
- `MissionCore`
- `MissionStore`
- wake queueing and deliberator execution
- `TaskRunner`
- trace capture
- host-side worktree lifecycle actions
- mission/provider contract syncing

This is where most of the product semantics live.

### `bakudo-tui`

`bakudo-tui` owns local application behavior:

- slash command parsing
- transcript and shelf state
- mission banner rendering
- approval and question popup interactions
- keyboard handling
- inline history rendering

The TUI is presentation plus local interaction state. It does not own mission
truth.

### `src/main.rs`

The root binary is deliberately thin:

- load config
- wire shared services
- choose TUI, daemon, or headless command path
- render status or persisted result queries

## Configuration and Provider Layers

Bakudo has two provider-loading systems because the two execution paths have
different requirements.

### Classic path: `ProviderRegistry`

Classic runs use `bakudo-core/src/provider.rs`.

This registry defines:

- provider ids
- binary names
- command-line arguments
- model flag shape
- whether a provider has a built-in "allow all tools" mode

The classic path stays declarative: command assembly happens through provider
specs rather than ad hoc string concatenation scattered across the codebase.

### Mission path: `ProviderCatalog`

Mission execution uses `crates/bakudo-daemon/src/provider_runtime.rs`.

The catalog loads repo-local defaults from:

```text
.bakudo/providers/*.toml
.bakudo/prompts/*.md
```

Each mission provider config may define:

- `engine`
- `posture`
- `engine_args`
- `allow_all_tools`
- `abox_profile`
- `system_prompt_file`
- wake budget
- environment passthrough
- optional `[worker]` settings for mission-native agent workers

The shipped defaults live in `crates/bakudo-daemon/data/providers/` and
`crates/bakudo-daemon/data/prompts/`. Bakudo can materialize or resync them
with `bakudo doctor --sync-mission-contract`.

### Why the split exists

The classic path needs a small built-in provider registry suitable for direct
CLI use. The mission path needs richer, posture-specific, repo-local runtime
configuration and prompt contracts. Those are different requirements, so Bakudo
keeps different loading layers.

## Interactive Session Architecture

The TUI and daemon interact only through typed channels:

- `SessionCommand`
- `SessionEvent`

This boundary matters because it keeps the UI from turning into an orchestration
engine.

### `SessionCommand`

The TUI sends commands such as:

- host input
- mission start
- mission list/focus
- budget updates
- manual wake
- provider/model changes for classic runs
- apply/discard/diverge/diff
- host approval resolution
- user question answers

### `SessionEvent`

The daemon emits events such as:

- ledger snapshots
- task lifecycle updates
- `MissionUpdated` banner state
- typed `MissionActivity`
- approval requests
- user questions
- info and error messages

The UI renders these. It does not infer them from scrollback.

## Host Layer

`HostRuntime` is a deliberately small control layer in front of the mission
runtime.

Its responsibilities are:

- route obvious status queries to a local answer
- ask for a done contract when the initial objective is too underspecified
- start a mission immediately when the objective is already clear
- treat subsequent freeform input as steering for the active mission
- track focused mission identity for operator continuity
- keep local notes about running tasks for quick host-visible status replies

`HostRuntime` is not a second planner. It is a small operator router that keeps
the interactive shell usable without making the mission runtime parse every
status question.

## Durable Mission Runtime

The durable mission runtime lives inside `MissionCore`, which is embedded in
`SessionController`.

### Mission creation

Starting a mission does all of the following:

1. load the posture-specific provider runtime
2. create the `Mission`
3. seed the initial `MissionState`
4. seed `mission_plan.md`
5. append a mission-created ledger entry
6. focus the mission in the host layer
7. queue an initial `ManualResume` wake

This is the moment where an operator goal becomes durable runtime state.

### Mission state duality

Bakudo intentionally stores mission context in two forms:

- `MissionState`: compact execution-oriented JSON
- `mission_plan.md`: concise operator-facing Markdown

`MissionState` currently has a default layout including:

- `objective`
- `done_contract`
- `constraints`
- `best_known`
- `things_tried`
- `open_questions`
- `next_steps`
- `active_wave`
- `completion_summary`

The conductor prompt explicitly tells the provider how to use that structure.

### Wake queue

Wake entries are durable. A wake carries:

- `WakeId`
- reason
- created timestamp
- payload
- current mission-state snapshot
- wallet snapshot
- queued user inbox
- recent ledger entries

The wake queue allows Bakudo to stop and resume work across provider exits and
host restarts without pretending the provider itself is stateful.

### Deliberator launch

For a wake, Bakudo:

1. reads the posture-specific system prompt
2. appends runtime wake reminders
3. appends pretty-printed `WakeEvent` JSON
4. starts a wake-local MCP HTTP server on `127.0.0.1`
5. launches the provider with provider-native MCP wiring

Provider-specific wiring currently includes:

- Claude Code: temporary `--mcp-config`
- Codex: per-run MCP override arguments
- repo-local `exec`: env vars including `BAKUDO_MCP_SERVER_URL`

The deliberator is stateless across wakes by design. The durable state lives in
Bakudo, not inside the provider process.

### Per-wake tool surface

The mission runtime exposes a deliberately small tool contract:

- `read_plan`
- `update_plan`
- `notify_user`
- `ask_user`
- `complete_mission`
- `read_experiment_summary`
- `dispatch_swarm`
- `abox_exec`
- `host_exec`
- `cancel_experiments`
- `update_mission_state`
- `record_lesson`
- `suspend`

Repo mutations come exclusively from `dispatch_swarm` workers (the actual
unit of repo work) plus host-owned candidate policy. The conductor has no
patch-apply tool: `abox` is the execution boundary, and `bakudo` (the host)
reviews worker output and decides whether to merge, discard, or leave a
preserved worktree for review.

The conductor prompt tells the provider to use the tools directly and not
invent a side transport.

### Wake budgets

Each mission provider has a configured wake budget with limits such as:

- tool calls
- wall clock
- debounce interval

If a wake overruns its budget, Bakudo terminates that wake and queues the next
one with an appropriate reason instead of letting the provider run forever.

## MissionStore

`MissionStore` is the durable authority for mission data.

It persists at least the following logical record families:

- missions
- experiments
- mission-state blobs
- ledger entries
- wake queue
- active wave records
- user messages
- pending questions

It also manages the sidecar mission plan artifact and the repo-local mission
provenance stream.

### Storage layout

The repo-scoped data root is resolved from configuration. Within that root,
Bakudo stores:

```text
<bakudo-data>/repos/<repo-scope>/
  state.db
  wakes/<wake-id>.json
  missions/<mission-id>/mission_plan.md
  traces/missions/<mission-id>/wakes/<wake-id>/
  traces/attempts/<task-id>/
  swarm-artifacts/<mission-storage-key>/
  ...
```

Bakudo also writes repo-local mission-owned artifacts:

```text
<repo>/.bakudo/provenance/<mission-id>.ndjson
<repo>/.bakudo/lessons/*.md
```

The split is intentional:

- repo-scoped runtime state lives under the Bakudo data root
- repo-native mission artifacts that should travel with the repo live under
  `.bakudo/`

## Experiment and Worker Lifecycle

Mission experiments are launched through `dispatch_swarm`.

### Dispatch-time validation and policy

`dispatch_swarm`:

- validates experiment shapes
- enforces mission wallet limits
- resolves provider runtime for agent workloads
- evaluates execution policy
- determines whether approval is required
- persists queued experiments
- persists an `ActiveWaveRecord`
- marks the mission sleeping while the wave is in flight

### Workload types

Experiments may be:

#### Script workers

- payload is tagged `{"kind":"inline", ...}` or `{"kind":"file", ...}`
- default to `sandbox_lifecycle = "ephemeral"`
- default to `candidate_policy = "discard"`
- are useful for cheap probes and deterministic checks

#### Agent-task workers

- payload is a raw `prompt`
- use the mission provider catalog's `[worker]` runtime config
- default to preserved/review-oriented host policy unless configured otherwise
- are used for deeper code-changing or provider-native exploration tasks

### Agent-worker prompt shaping

Provider-backed agent workers do not receive a naked prompt anymore.

Bakudo now wraps agent-task prompts with:

- the scoped assignment
- explicit worker role and boundary rules
- mission objective
- done contract
- constraints
- best-known state
- open questions
- next steps
- experiment label and hypothesis
- base branch
- candidate policy and sandbox lifecycle
- provider/model context

This improves worker autonomy without pretending the worker is the conductor.

### Worker hand-off contract

Provider-backed agent workers are asked to end with exactly one line beginning
with:

```text
BAKUDO_SUMMARY:
```

The Python worker wrapper captures that line preferentially, and `TaskRunner`
also prefers that summary when extracting a fallback summary from stdout/stderr.

This matters because later mission wakes need a concise machine-readable handoff
instead of guessing from the last arbitrary line of provider output.

### `TaskRunner`

`TaskRunner` is the low-level execution bridge to `abox`.

For each attempt it:

1. writes `AttemptSpec` to a temp file
2. registers the sandbox in `SandboxLedger`
3. launches `abox run`
4. injects env vars such as `BAKUDO_PROMPT`, `BAKUDO_TASK_ID`, and
   `BAKUDO_SPEC_PATH`
5. parses structured stdout envelopes:
   - `BAKUDO_EVENT`
   - `BAKUDO_RESULT`
   - `BAKUDO_ERROR`
6. updates the ledger
7. records attempt traces and stream logs
8. returns `WorkerResult`

### Worker wrapper

The worker bootstrap is a small Python wrapper that:

- spawns the real provider process
- sends the prompt to stdin
- pumps stdout/stderr
- emits structured progress events
- emits a final structured result
- tracks the explicit `BAKUDO_SUMMARY:` handoff line when present

The wrapper exists so Bakudo can keep provider integration declarative while
still normalizing progress and result envelopes.

### Experiment summary persistence

When an experiment finishes, Bakudo persists an `ExperimentSummary` containing:

- exit code
- duration
- stdout tail
- stderr tail
- optional `worker_summary`
- extracted metrics
- optional patch path

`read_experiment_summary` returns that persisted summary plus the trace-bundle
path so the conductor can make follow-up decisions from durable data instead of
guessing.

## Active Waves and Scheduling

Bakudo models coordinated experiment dispatch as an active wave.

An `ActiveWaveRecord` persists:

- mission id
- experiment ids
- concurrency limit
- wake policy
- whether the wake has already been sent
- last update time

This record lets Bakudo:

- schedule only up to the allowed concurrency
- survive restarts without forgetting which experiments belong together
- know when to resume the conductor
- summarize wave state in the mission banner

The mission banner derives a runtime-facing wave summary with counts such as:

- total
- running
- queued
- completed
- failed

The UI surfaces that summary directly because active-wave state is one of the
operator's main orientation anchors.

## Inline Mission Tools

Not every mission action justifies a full worker dispatch.

### `abox_exec`

`abox_exec` is for short one-off inspection or verification inside `abox`.

It takes a plain shell snippet and returns:

- exit code
- duration
- stdout tail
- stderr tail

This keeps the conductor from having to launch a whole agent worker for simple
checks.

### `host_exec`

`host_exec` is approval-gated and intentionally exceptional. It exists for
real host-boundary actions that cannot occur inside `abox`.

When the deliberator calls `host_exec`, Bakudo:

1. creates a pending approval record
2. emits a `SessionEvent::ApprovalRequested`
3. waits for user resolution
4. records the approval decision in the mission ledger
5. only then runs the host command

The product point is not convenience. It is explicit boundary crossing.

### `ask_user`

`ask_user` is the blocking user-decision path. It persists a pending question,
surfaces a popup in the TUI, and resumes the mission once the operator answers.

## `SandboxLedger` and Worktree Lifecycle

`SandboxLedger` is the durable authority for sandbox state.

Typical state transitions are:

- `Starting`
- `Running`
- `Preserved`
- `Failed { exit_code }`
- `TimedOut`
- `Merged`
- `Discarded`
- `MergeConflicts`

### Why ledger state is separate from mission state

The ledger is about sandbox and worktree lifecycle across the whole session and
repo. Mission state is about durable objective progress. They overlap, but they
are not the same authority and should not be collapsed.

### Candidate policy

Host-owned candidate policy currently includes:

- `Review`
- `AutoApply`
- `Discard`

The worker inside the sandbox never merges its own worktree. If a merge occurs,
it is initiated from the host after the sandbox run succeeds.

## TUI Semantics

The TUI is designed around runtime truth rather than broad control-panel
coverage.

Important rendered surfaces include:

- transcript
- observability shelf
- top working strip
- mission banner
- inline history
- shared popup surface for slash completion, approvals, and user questions

The UI should surface:

- focused mission
- wake state
- active wave state
- running and queued worker counts
- pending approvals
- pending user questions
- latest issue
- latest change

Those signals come from typed daemon events and mission banner state, not from
visual heuristics.

### Current slash-command model

Mission-oriented slash commands include:

- `/mission`
- `/explore`
- `/missions`
- `/focus`
- `/budget`
- `/wake`
- `/lessons`

Classic control and inspection commands remain available:

- `/provider`
- `/model`
- `/providers`
- `/apply`
- `/discard`
- `/diverge`
- `/diff`
- `/status`
- `/doctor`
- `/config`

`/model` currently remains a raw override/reset surface. Bakudo does not yet
ship a truthful provider-model picker because the runtime does not yet expose a
real model inventory.

## Headless CLI and Control Plane

The headless CLI exposes a narrow control plane around the same runtime.

Important commands include:

- `bakudo run`
- `bakudo swarm --plan ...`
- `bakudo daemon`
- `bakudo status`
- `bakudo result`
- `bakudo wait`
- `bakudo candidates`
- `bakudo artifact`
- `bakudo apply`
- `bakudo discard`
- `bakudo divergence`
- `bakudo sessions`
- `bakudo resume`

### Machine-readable output

Classic runs support:

- `--json`
- `--output-schema`
- `post_run_hook`

Swarm plans extend the same execution surface with dependency-aware scheduling
and logical artifact paths under Bakudo-owned storage.

## Observability

Bakudo records several layers of trace data:

- wake traces
- attempt traces
- streamed stdout/stderr logs
- `trace_bundle.md` summaries
- append-only mission provenance
- ledger entries

This observability model is intentionally layered:

- the transcript is for human interaction flow
- the mission ledger is for durable mission-level notable events
- trace bundles are for detailed debugging and review

## Recovery

Bakudo is designed to survive restarts.

### Sandbox recovery

On startup Bakudo:

1. calls `abox list`
2. reconciles running sandboxes against `SandboxLedger`
3. marks missing running sandboxes as failed
4. rebuilds the TUI shelf from the recovered ledger

### Mission recovery

`MissionCore::recover_on_startup()`:

- reloads active missions
- repairs experiments that were left in running state
- recovers pending questions
- reevaluates active waves
- reschedules wakes as needed

This is possible because mission state does not depend on a single long-lived
provider process surviving.

## Security and Boundary Model

Bakudo's safety model depends on separation of concerns.

### `abox` is the execution boundary

Repo work, probes, and most verification happen inside `abox`.

### Bakudo is the host control plane

Bakudo owns:

- durable mission state
- worktree lifecycle
- approvals
- user questions
- data-root storage

### The provider is not the authority

The provider supplies reasoning and worker output, but Bakudo remains the
authority for:

- mission progression
- whether a wake is complete
- whether host actions are approved
- whether a worktree is merged or discarded

## Architecture Invariants

Several invariants are central enough to repeat here explicitly:

- `MissionStore` is the durable mission authority.
- `SandboxLedger` is the durable sandbox authority.
- TUI and daemon communicate only through `SessionCommand` and `SessionEvent`.
- Worktree lifecycle remains host-owned.
- `abox` remains the execution and security boundary.
- Classic one-shot execution and wake-based mission execution remain distinct
  paths.
- Provider/model/runtime identity must remain truthful.
- Missing runtime signals should not be hidden behind UI theater.

## Extension Guidance

If you change Bakudo, preserve the conceptual shape of the runtime:

### When adding a provider

- update `ProviderRegistry` only for classic-run behavior
- update repo-local mission provider defaults only for mission behavior
- do not hardcode provider flags outside those layers

### When changing mission semantics

- update prompts under `crates/bakudo-daemon/data/prompts/`
- update `MissionStore` or wake handling as needed
- keep `MissionState` compact and intentional
- update this document if the shipped behavior changes

### When changing UI

- add only surfaces backed by real runtime state
- prefer orientation over extra chrome
- keep mission visibility centered on real wake and wave signals

## Reading Order for Engineers

For a code-first walkthrough, the most important files are:

- `src/main.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-daemon/src/mission_store.rs`
- `crates/bakudo-daemon/src/task_runner.rs`
- `crates/bakudo-daemon/src/worker/mod.rs`
- `crates/bakudo-daemon/src/host.rs`
- `crates/bakudo-tui/src/app.rs`
- `crates/bakudo-tui/src/ui.rs`

## Summary

Bakudo's architecture is built around a single product decision:

the mission, not the prompt, is the durable unit of work.

Once that choice is made, the rest of the system follows naturally:

- durable mission state
- wake-based deliberation
- sandboxed experiments
- host-owned worktree lifecycle
- typed UI boundaries
- explicit approval and question flows
- traceable worker handoffs

That is the shape the current runtime is trying to preserve.
