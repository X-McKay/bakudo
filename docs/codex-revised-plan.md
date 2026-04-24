# Codex Revised Mission Conductor Plan

Status: Implemented target architecture reference

Date: 2026-04-24

Owner: Bakudo maintainers

## Executive Decision

Bakudo should become an LLM-heavy mission conductor built on top of a small,
deterministic Rust kernel.

That means:

- the model owns planning, decomposition, narration, and mid-flight adaptation
- the Rust runtime owns security boundaries, durable state, approvals,
  worktree lifecycle, provider configuration, and observability
- all meaningful repo mutation and code execution continue to happen inside
  `abox`, not on the host

This plan keeps the parts of the current architecture that are already correct,
removes the host-side over-planning that is fighting the model, and only adds
new infrastructure where the current runtime is genuinely blocking the product.

This plan assumes a direct cutover to the new mission runtime contract. Old
tool names, old prompt semantics, and previous mission-store row shapes do not
need compatibility shims unless the final architecture explicitly requires one.

## Why This Is The Right Direction

Bakudo already has the beginnings of the right shape:

- a durable wake-based mission runtime
- typed command and event boundaries
- a repo-scoped mission store
- host-owned worktree policy
- a secure execution substrate in `abox`

What it does not have yet is a clean separation between:

1. the model's job
2. the harness's job

Today the host runtime still tries to do too much planning in Rust, while the
mission runtime still asks the model to do planning through awkward JSON state
patches and script-only workers. That is the wrong split.

The right split is:

- let the model think
- let Bakudo remember
- let `abox` execute
- let the host enforce policy

This is simpler than the infrastructure-heavy drafts, but more durable than the
prompt-only draft, because it gives the model room to adapt without making the
runtime vague or unsafe.

## Product Vision

The target product behavior is:

- The user gives Bakudo a goal in the TUI or through the daemon.
- The host layer does one cheap routing step, then hands control to a durable
  mission.
- The deliberator model reads the current mission snapshot and a
  human-readable `mission_plan.md`, decides what to do next, and uses a small
  tool surface to act.
- When real work is needed, the mission dispatches one or more `abox` workers.
- Workers may be deterministic scripts or provider-backed coding agents, but
  both run inside sandboxes and both report through the same durable mission
  supervisor.
- The host never gives the deliberator broad raw host powers. The host exposes
  only a curated interface plus approval-gated host actions.
- The mission can be interrupted, resumed, inspected, and debugged from durable
  artifacts without relying on hidden model context.

The distinctive value is not "another agent loop." The distinctive value is:

- provider-agnostic mission supervision
- strong sandboxing by default
- host-owned review and merge policy
- durable recoverable state
- enough structure to support real long-running work without turning the repo
  into orchestration sprawl

## Non-Negotiable Invariants

These are binding. Any implementation that violates them is the wrong
implementation.

1. `abox` remains the execution and mutation boundary for repo work.
2. The classic path and the mission path remain separate:
   - classic one-shot work uses `ProviderRegistry`
   - wake-based missions use `ProviderCatalog`
3. `MissionStore` remains the durable mission authority.
4. Durable mission state continues to use `MissionState` terminology.
5. Worktree merge, preserve, and discard decisions remain host-owned.
6. The TUI continues to communicate with the daemon only through
   `SessionCommand` and `SessionEvent`.
7. We do not add a broad host shell or generic host file-write surface.
8. We do not introduce vendor-specific orchestration logic into the core.

## Core Design Principles

### 1. LLM-heavy policy, deterministic kernel

The model should decide:

- what the next step is
- whether to investigate, implement, verify, or ask the user
- whether a task should be a script worker or an agent worker
- when the plan needs to change
- what progress to narrate

The runtime should decide:

- whether a tool call is allowed
- when budgets are exhausted
- how work is persisted
- how worker runs are scheduled and resumed
- when approval is required
- what happens to worktrees after a worker exits

### 2. Two mission artifacts, not one

Bakudo should keep both:

- `MissionState`: compact machine state used by the runtime
- `mission_plan.md`: human-readable planning artifact used by the model and
  humans

`MissionState` should contain execution-relevant state. `mission_plan.md`
should contain prose, checklist structure, rationale, and user-facing plan
updates.

This avoids both failure modes:

- raw JSON blobs becoming the model's planning workspace
- Markdown becoming the runtime's only durable truth

### 3. Small host tool surface

The deliberator should get a small number of strong tools rather than a large
surface of generic host access.

The first target tool surface is:

- `read_plan`
- `update_plan`
- `notify_user`
- `ask_user`
- `complete_mission`
- `read_experiment_summary`
- `dispatch_swarm`
- `abox_exec`
- `abox_apply_patch`
- `host_exec`
- `cancel_experiments`
- `update_mission_state`
- `record_lesson`
- `suspend`

This is intentionally small. If the model needs more repo context, it should
obtain it inside an `abox` worker, not by reading the host filesystem directly.

### 4. Prefer prompt and provider configuration over Rust branching

When a behavior is mostly about reasoning style or recurring workflow, we
should encode it in prompts and provider defaults, not in new Rust state
machines.

Examples:

- when to prefer script workers over agent workers
- when to notify the user versus ask a blocking question
- how often to update the plan
- when local models are appropriate

Examples that do belong in Rust:

- wallet enforcement
- scheduling
- approval rules
- worktree policy
- persistence
- trace capture

### 5. Add structure only where the current runtime is actually failing

We should not build:

- generic host repo read tools in v1
- a shared provider abstraction spanning classic and mission paths before both
  paths actually need it
- a fake SQL migration framework
- a UI dashboard redesign before the runtime semantics are correct

## Provider Strategy

Bakudo should be provider-agnostic, but not provider-naive.

### Deliberator

The deliberator is the model that reads wake context and decides the next step.
This role benefits most from strong long-horizon reasoning and clean tool use.

Default recommendation:

- use Claude Code or Codex for the deliberator by default
- keep the choice declarative in `ProviderCatalog`
- keep the runtime unaware of provider-specific product strategy

### Worker

Workers do bounded implementation, verification, or exploration inside `abox`.
The worker provider may be the same as the deliberator provider, but it does not
have to be.

Default recommendation:

- frontier coding agents for code-changing or high-trust worker tasks
- deterministic scripts for setup, verification, and cheap commands
- local vLLM-backed workers only for narrow workloads at first:
  summarization, scouting, evaluator-style checks, or low-risk exploration

Do not add a special "local model orchestration" subsystem up front. If a local
model can be invoked through the existing `exec` provider engine, use that first
and add a richer engine only when there is a real need.

## Target End State

At the end of this plan, the runtime should look like this:

- `HostRuntime` is a thin router, not a staged planner.
- `SessionController` remains the mission supervisor and typed tool host.
- `MissionStore` remains authoritative for durable mission state and wake state.
- `ProviderCatalog` owns both deliberator and worker runtime configuration for
  mission-native execution.
- `mission_plan.md` is stored under the repo-scoped data directory and exposed
  through dedicated tools.
- `dispatch_swarm` can launch either script workloads or provider-backed agent
  workloads inside `abox`, with a strict typed payload on each experiment item:
  `{"kind":"script","script":...}` or `{"kind":"agent_task","prompt":"..."}`.
- `concurrency_hint` actually limits concurrent experiment start, rather than
  being accepted and ignored.
- the TUI receives typed mission activity events instead of flattening
  everything into generic info messages.
- the runtime emits durable trace artifacts that make failures debuggable.

## Mission Data Model

### `MissionState`

`MissionState` remains authoritative machine state. It should stay compact and
execution-oriented.

Recommended top-level structure:

```json
{
  "version": 1,
  "objective": "...",
  "done_contract": "...",
  "constraints": [],
  "best_known": [],
  "things_tried": [],
  "open_questions": [],
  "next_steps": [],
  "active_wave": null,
  "completion_summary": null
}
```

Rules:

- keep values structured and brief
- do not store freeform planning prose here
- update only fields the runtime or prompts actually consume
- prefer appending durable decisions to ledger entries instead of burying them
  inside state blobs

### `mission_plan.md`

`mission_plan.md` is the model-facing and human-facing planning artifact.

Location:

```text
<repo-data>/missions/<mission-id>/mission_plan.md
```

Recommended template:

```markdown
# Mission Plan

## Objective

## Done Contract

## Constraints

## Current Assessment

## Plan
- [ ] Step 1

## Active Wave

## Risks And Unknowns

## Questions For User

## Completion Summary
```

Rules:

- preserve the top-level headings
- allow the model to rewrite section contents freely
- do not parse the Markdown for execution decisions
- expose the whole document through `read_plan` and `update_plan`

Whole-file replacement is acceptable here. There is only one mission
deliberator wake at a time, and the host is not an independent writer.

## Mission Tool Contract

This plan keeps the tool surface small and explicit.

### Keep

- `dispatch_swarm`
- `abox_exec`
- `abox_apply_patch`
- `host_exec`
- `update_mission_state`
- `record_lesson`
- `ask_user`
- `cancel_experiments`
- `suspend`

### Add

- `read_plan() -> { path, markdown, updated_at }`
- `update_plan({ markdown, reason }) -> { path, updated_at }`
- `notify_user({ message }) -> { delivered: true }`
- `complete_mission({ summary }) -> { completed: true }`
- `read_experiment_summary({ experiment_id }) -> { summary, trace_bundle_path? }`

### Change

- `suspend` should mean "yield this wake and sleep", not "complete mission"
- `ask_user` remains the blocking question tool
- `notify_user` is non-blocking and transcript-facing
- `abox_exec` and `abox_apply_patch` should take plain shell strings for
  quick conductor-side verification, while `dispatch_swarm` keeps the stricter
  typed experiment payloads

### Do Not Add In Phase 1

- `repo_search`
- `repo_read_file`
- generic host patching
- generic host file writes

## Provider Contract Versioning

This is a load-bearing part of the plan.

`ProviderCatalog::ensure_defaults()` currently writes prompts and provider files
only if they are missing. That means tool contract changes are dangerous unless
we add an explicit sync story.

We should add a prompt and provider contract version mechanism before changing
the prompt contract.

### Design

Add:

- a constant contract version in `bakudo-daemon`
- a manifest file in the repo-local `.bakudo/` directory recording the last
  synced version
- a sync routine that can update shipped default prompt and provider files when
  the contract changes

Recommended behavior:

1. If a repo has no local prompt or provider files, materialize the new defaults.
2. If the repo has default-generated files from an older contract version and
   they are unmodified, overwrite them automatically.
3. If the repo has locally modified files and the contract version is too old,
   fail mission startup with a precise error explaining that the prompt contract
   changed and the repo must be resynced explicitly.
4. Add an explicit CLI command for this:

```text
bakudo doctor --sync-mission-contract
```

This keeps us aligned with the repository invariant against old tool-name
compatibility aliases. We migrate the contract cleanly instead of carrying both
contracts forever.

## Worker Model

Bakudo should support two experiment workload types.

### 1. Script workload

Use for:

- deterministic setup
- verification
- compilation
- tests
- metric collection
- cheap investigation

### 2. Agent workload

Use for:

- code changes
- non-trivial debugging
- deeper repo exploration
- review/refactor tasks
- tasks where the model needs iterative tool use inside the sandbox

### Proposed Rust Types

Extend `ExperimentSpec` to include a `workload` field.

Recommended shape:

```rust
pub struct ExperimentSpec {
    pub base_branch: String,
    pub workload: ExperimentWorkload,
    pub skill: Option<String>,
    pub hypothesis: String,
    pub metric_keys: Vec<String>,
}

pub enum ExperimentWorkload {
    Script {
        script: ExperimentScript,
    },
    AgentTask {
        prompt: String,
        provider: Option<String>,
        model: Option<String>,
        sandbox_lifecycle: SandboxLifecycle,
        candidate_policy: CandidatePolicy,
        timeout_secs: Option<u64>,
        allow_all_tools: Option<bool>,
    },
}
```

### Cutover

Do not add a SQL migration framework for this.

Because repo-local mission-store state is explicitly allowed to break during
this architecture reset, we can move `experiments.spec_json` directly to the
new `workload` shape and keep the runtime code simple. Any persistence
adaptation should exist only when it materially improves the final design, not
just to preserve obsolete rows.

## Scheduling Model

This is another load-bearing correction.

`dispatch_swarm` currently accepts `concurrency_hint` but starts the entire wave
immediately. That is incorrect and should be fixed as part of the worker work.

### Required behavior

- `concurrency_hint` limits how many experiments in the wave may be running at
  once
- the effective limit is:

```text
min(concurrency_hint, wallet.concurrent_max, wallet.abox_workers_remaining)
```

- queued experiments remain in `ExperimentStatus::Queued`
- when one experiment finishes, the scheduler starts the next queued
  experiment, if capacity remains
- `wake_when` still controls when the deliberator wakes, but does not implicitly
  cancel the rest of the wave

### Persistence

Avoid a SQL migration framework if possible.

`active_waves.experiment_ids_json` should move to a richer JSON payload that
stores both `experiment_ids` and `concurrency_limit`. Since restart-safe wave
state is part of the target runtime and old mission-store state is not
load-bearing, prefer a direct cutover to the new payload over dual-format
compatibility code.

Recommended internal wave payload:

```json
{
  "experiment_ids": ["..."],
  "concurrency_limit": 2
}
```

That lets the scheduler survive restarts without adding a new table or a
migration system.

## Worktree And Approval Policy

The policy model should remain host-owned and deterministic.

### Script workloads

For script workloads, keep the current behavior:

- default to `SandboxLifecycle::Ephemeral`
- default to `CandidatePolicy::Discard`

### Agent workloads

For agent workloads, use safer defaults:

- default to `SandboxLifecycle::Preserved`
- default to `CandidatePolicy::Review`

Rationale:

- code-changing work is exactly where Bakudo's host-owned review path is a
  product advantage
- `AutoApply` should remain opt-in
- agent workers should not be allowed to merge their own work

### Approval

Approval rules belong in Rust, not in the prompt.

Initial approval model:

- the deliberator asks for code-changing or high-risk work
- `dispatch_swarm` evaluates wallet and execution policy before starting the
  wave
- if approval is required and not armed, the tool returns a structured refusal
  describing why
- the deliberator uses `notify_user` or `ask_user` to resolve the block

Do not build a dedicated wave-approval UI before the core worker path exists.
The current approval transport can be extended later once real usage justifies
it.

## Detailed Implementation Phases

## Phase 1: Observability Baseline

Goal: make the current runtime inspectable before changing semantics.

### Scope

- add wake trace capture under:

```text
<repo-data>/traces/missions/<mission-id>/wakes/<wake-id>/
```

- add worker attempt trace capture under:

```text
<repo-data>/traces/attempts/<task-id>/
```

- add `trace_bundle.md` for each completed experiment
- keep writes best-effort; trace failure must not fail the mission
- add count-based retention only

### Files

- `crates/bakudo-daemon/src/trace.rs` (new)
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-daemon/src/task_runner.rs`
- `tests/runtime.rs`

### Acceptance Criteria

- every wake has a durable trace directory
- every experiment completion has a readable trace bundle
- trace write failure is surfaced as a warning only

### Reasoning

This phase makes every later phase safer. If the prompt contract or worker path
goes wrong, we need artifacts before we need opinions.

## Phase 2: Mission Contract Sync

Goal: make prompt and provider contract updates safe without tool aliases.

### Scope

- add a mission contract version constant
- add repo-local contract manifest storage under `.bakudo/`
- teach `ProviderCatalog` to gate repo-local prompt/provider defaults behind an
  explicit contract sync when the local contract version is unknown
- add `bakudo doctor --sync-mission-contract`
- update default prompt and provider assets to the new contract only after the
  sync mechanism exists

### Files

- `crates/bakudo-daemon/src/provider_runtime.rs`
- `crates/bakudo-daemon/data/prompts/mission.md`
- `crates/bakudo-daemon/data/prompts/explore.md`
- `crates/bakudo-daemon/data/providers/*.toml`
- `src/main.rs`
- `tests/runtime.rs`

### Acceptance Criteria

- a repo without mission defaults materializes the shipped contract
- a repo with unknown-version prompt/provider defaults fails with a clear action
  message
- the runtime no longer depends on old tool-name compatibility aliases

### Reasoning

Without this, every tool contract change is unsafe because the repo-local prompt
copy may lag the shipped runtime.

## Phase 3: Conductor Artifact And Tool Cutover

Goal: give the model a better planning workspace without removing durable
machine state.

### Scope

- create `mission_plan.md` when a mission starts
- add `read_plan`
- add `update_plan`
- add `notify_user`
- add `complete_mission`
- add `read_experiment_summary`
- keep `update_mission_state`
- keep `ask_user`
- change `suspend` so completion is no longer encoded in `suspend.complete`
- update default prompts to use the new contract

### Files

- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-daemon/src/mission_store.rs`
- `crates/bakudo-daemon/data/prompts/mission.md`
- `crates/bakudo-daemon/data/prompts/explore.md`
- `tests/runtime.rs`

### Concrete Implementation Notes

- store `mission_plan.md` under the repo-scoped data directory, not under the
  repo working tree
- `read_plan` returns the full file contents
- `update_plan` replaces the whole file and records a ledger entry summarizing
  the reason
- `notify_user` emits a transcript event and records a ledger note, but does
  not block the wake
- `complete_mission` sets `MissionStatus::Completed`, records the summary in
  both mission state and ledger, and emits the existing completion transcript
  output until Phase 5 adds typed mission activity events

### Acceptance Criteria

- the model can maintain a human-readable plan without abusing
  `update_mission_state`
- a mission can complete without using a `suspend.complete` escape hatch
- the transcript clearly distinguishes user-facing notifications from blocking
  questions

### Reasoning

This is where we lean harder on the model. The plan artifact becomes the model's
workspace, while `MissionState` stays durable and operational.

## Phase 4: Thin Host Router

Goal: stop doing mission planning in `HostRuntime`.

### Scope

- preserve direct status answers for status-like host turns
- preserve one cheap intake turn for missing acceptance criteria or constraints
- start a mission quickly when the initial request is already specific enough
- route all later freeform input into the active mission as steering
- remove staged host-side plan drafting and yes/no confirmation loops

### Files

- `crates/bakudo-daemon/src/host.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `tests/runtime.rs`

### Acceptance Criteria

- host planning logic becomes materially smaller
- the first meaningful goal can start a mission without a multi-turn Rust-side
  planning ritual
- status questions still receive fast local answers

### Reasoning

The model is better at planning than the current host planner. The host's job is
to route, not to cosplay as the planner.

## Phase 5: Typed Mission Activity Events

Goal: improve operator visibility without redesigning the UI.

### Scope

- add `SessionEvent::MissionActivity`
- add a small `MissionActivity` enum with variants for:
  - plan updated
  - user notified
  - question asked
  - wave dispatched
  - worker finished
  - approval blocked
  - mission completed
- render these distinctly from generic `Info`

### Files

- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-tui/src/app.rs`
- `crates/bakudo-tui/src/ui.rs`
- `tests/runtime.rs`

### Acceptance Criteria

- the transcript makes mission progress legible without reading raw ledger lines
- no new shelf dashboard or wave column is added yet

### Reasoning

The product needs to be inspectable, but we should not spend UI complexity on
views we cannot justify yet.

## Phase 6: Mission-Native Agent Workers

Goal: let the conductor dispatch real code-changing and exploratory workers
inside `abox`.

### Scope

- extend `ExperimentSpec` with `ExperimentWorkload`
- add worker-capable provider configuration to `ProviderCatalog`
- implement a mission-native worker launch path that does not touch
  `ProviderRegistry`
- support both script workloads and agent workloads in `run_experiment`
- honor `concurrency_hint`
- preserve host-owned worktree policy

### Provider Runtime Changes

Add an optional worker section to mission provider configs.

Recommended shape:

```toml
name = "codex"
engine = "codex"
posture = "mission"
allow_all_tools = true
abox_profile = "mission"
system_prompt_file = "prompts/mission.md"
engine_args = []

[wake_budget]
tool_calls = 30
wall_clock = "300s"
debounce = "1500ms"

[worker]
engine = "codex"
engine_args = ["exec"]
abox_profile = "worker"
allow_all_tools = true
timeout_secs = 1800
max_output_bytes = 1048576
```

Implementation rules:

- if `[worker]` is absent, agent workloads are rejected with a clear tool error
- do not silently fall back to the classic path
- keep provider selection declarative
- top-level `allow_all_tools` controls the deliberator's low-friction launch
  mode; worker `allow_all_tools` controls the default for dispatched agent
  workers

### Worker Envelope

Do not start by adding a new workspace crate unless it is necessary.

Implementation order:

1. extract the current classic wrapper behavior into a mission-owned Rust helper
   module under `bakudo-daemon`
2. use that helper to launch agent workloads inside `abox`
3. only split it into `crates/bakudo-worker/` later if the classic path also
   needs to share the same implementation

This is the maintainable path. It avoids both duplicated wrapper logic and a
premature new crate.

### `run_experiment` behavior

For script workloads:

- keep the current `abox run` script flow

For agent workloads:

- resolve worker provider config from `ProviderCatalog`
- build a worker attempt inside `abox`
- stream structured progress events through the same mission event path
- preserve or discard the worktree according to the experiment spec and host
  policy
- persist summary and trace artifacts exactly like script workloads

### Files

- `crates/bakudo-core/src/mission.rs`
- `crates/bakudo-daemon/src/provider_runtime.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-daemon/src/task_runner.rs`
- `crates/bakudo-daemon/src/worker/` (new module)
- `tests/runtime.rs`

### Acceptance Criteria

- the deliberator can launch an agent worker using mission-native provider
  configuration
- the worker runs inside `abox`
- `concurrency_hint` actually limits in-flight experiments
- preserved agent worktrees can be reviewed and applied by the host

### Reasoning

This is the real product unlock. Everything earlier exists to make this phase
safe and understandable.

## Phase 7: Policy Hardening And Provider Tuning

Goal: make the first real worker deployment safe and tunable.

### Scope

- refine daemon-side approval checks for agent workloads
- add provider-specific defaults for deliberator versus worker roles
- add posture-specific prompt guidance about when to use scripts, agent workers,
  or cheaper local providers
- add a small evaluation matrix for supported providers

### Provider evaluation guidance

For each supported provider profile, validate:

- wake reliability
- tool-call reliability
- code-change quality on bounded tasks
- verification discipline
- behavior under low budget and restart conditions

### Files

- `crates/bakudo-daemon/data/prompts/*.md`
- `crates/bakudo-daemon/data/providers/*.toml`
- `tests/runtime.rs`
- `README.md`
- `docs/current-architecture.md`

### Acceptance Criteria

- the runtime can explain why a wave was blocked
- provider defaults reflect real observed behavior rather than guesswork
- the shipping docs match the new runtime

### Reasoning

This phase tunes the product after the real worker path exists. It should not
be moved earlier.

## Test Plan

The test strategy must focus on runtime behavior, not just helper functions.

### End-to-end runtime tests to add

- mission contract sync writes the shipped prompt/provider defaults
- ensure-defaults rejects unknown-version repo-local defaults with a clear error
- `read_plan` returns seeded plan contents
- `update_plan` rewrites the plan file and, after Phase 5, emits a mission
  activity event
- `notify_user` emits transcript-visible activity without blocking the wake
- `complete_mission` marks the mission complete and records completion summary
- host status queries still work after the host router is simplified
- `dispatch_swarm` respects `concurrency_hint`
- queued experiments resume correctly after process restart
- agent workload launches through mission-native provider config
- preserved agent workload worktrees remain host-reviewable
- approval-required agent wave returns a structured refusal instead of silently
  running

### Unit tests to add

- prompt contract manifest parsing and sync decisions
- `ExperimentSpec` workload serialization/deserialization
- active-wave payload serialization/deserialization
- mission activity rendering

### Manual smoke tests

- run one mission with Codex deliberator and script workers
- run one mission with Codex or Claude deliberator and agent workers
- run one mission with a local `exec`-backed provider for low-risk evaluation
- restart the daemon mid-wave and confirm recovery

## Rollout Strategy

This plan is intentionally staged so that each phase can land independently.

Recommended release order:

1. Phase 1
2. Phase 2
3. Phase 3 and Phase 4 together
4. Phase 5
5. Phase 6
6. Phase 7

Reasoning:

- observability and contract sync reduce risk before behavior changes
- artifact and router changes improve the mission loop before worker complexity
- agent workers land only after traces, contract sync, and transcript clarity
  exist

## What We Are Explicitly Not Building

- a generic host repo browser in v1
- a broad host shell surface
- a new SQL migration framework
- provider-specific orchestration logic in the daemon
- a UI-first mission dashboard before core runtime correctness
- a mandatory new `bakudo-worker` crate on day one
- a "replace `MissionState` with Markdown" design

## Implementation Checklist For The First Engineer

If this plan is handed to one engineer to start tomorrow, the first slice should
be:

1. Land Phase 1 trace capture with runtime tests.
2. Land Phase 2 contract sync and the explicit doctor command.
3. Land Phase 3 tool additions plus `mission_plan.md`.
4. Simplify `HostRuntime` only after the new tool contract is usable.

That sequence gives the project better visibility, safer prompt updates, and a
cleaner conductor loop before the worker path is touched.

## Final Recommendation

Proceed with a model-forward conductor, but keep the kernel narrow and hard.

Bakudo should not try to outsmart frontier coding models in Rust, and it should
not give them unsafe or sprawling powers on the host. The right product is a
durable wake-based conductor with a small host tool surface, a strong
`abox` security boundary, host-owned worktree policy, and mission-native agent
workers that can evolve without entangling the classic execution path.
