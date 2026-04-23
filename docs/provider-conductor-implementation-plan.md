# Provider-Conductor Mission Architecture Plan

Status: Draft for review

Owner: Bakudo maintainers

Last updated: 2026-04-23

## Objective

Refactor Bakudo's interactive mission flow so the configured provider on the
host acts as a real mission conductor, while all code changes and execution
remain sandboxed inside `abox`.

The target behavior is:

1. The user states an objective in freeform chat.
2. The host-side provider inspects context and proposes a concrete first wave.
3. The user approves or edits that proposal.
4. Bakudo dispatches sandboxed workers for implementation, testing, or
   verification.
5. The host-side provider monitors outcomes, analyzes failures or successes,
   reports progress in chat, and decides the next step.

This should feel closer to a "Claude Super Powers" style conductor on the host,
but with Bakudo's daemon, mission store, wallet, approvals, and sandbox
boundary still in charge.

## Why This Change Is Needed

The current implementation has a structural mismatch between the user-facing
conversation flow and the underlying runtime:

- The host layer in
  [crates/bakudo-daemon/src/host.rs](../crates/bakudo-daemon/src/host.rs)
  stages a canned Q/A flow and renders a fixed worker plan.
- That staged plan is not the actual source of mission execution.
- The mission runtime is already wake-based and durable, but the configured
  provider is not yet being used effectively as the planner/conductor.
- Mission dispatch is script-oriented today, which makes it awkward to express
  "spin up two coding workers and one verification scout".
- Existing logs are useful but not sufficient for provider-contract debugging
  or iterative mission UX improvement.

The result is a transcript that looks structured, rigid, and partially detached
from what the runtime is actually doing.

## Design Goals

1. Use the configured provider effectively at the host/conductor layer.
2. Preserve the current repository invariants:
   - `bakudo-core` owns shared types and classic provider registry logic.
   - `bakudo-daemon` owns mission supervision and worktree lifecycle decisions.
   - The agent in the sandbox never merges its own work.
   - TUI/daemon communication remains typed via `SessionCommand` and
     `SessionEvent`.
3. Keep host reasoning powerful but host mutation constrained.
4. Make mission execution iterative instead of front-loaded into a canned host
   planner.
5. Improve observability so failed or confusing interactions are easy to debug.

## Non-Goals

- No direct host-side repo edits by Claude Code, Codex, or any other provider.
- No broad host shell surface beyond the existing approval-gated `host_exec`.
- No replacement of durable `MissionState` with provider session memory.
- No mixing the classic one-shot `ProviderRegistry` path with the wake-based
  `ProviderCatalog` path.

## Current State Summary

### Host planning path

The current host layer:

- stages an objective
- asks for success criteria
- asks for constraints
- renders a canned worker plan
- waits for a textual "yes"

Key files:

- [crates/bakudo-daemon/src/host.rs](../crates/bakudo-daemon/src/host.rs)
- [crates/bakudo-daemon/src/session_controller.rs](../crates/bakudo-daemon/src/session_controller.rs)

### Mission runtime path

The mission runtime already supports:

- durable `MissionStore`
- `WakeEvent` queueing
- mission-side tool calls
- wallet enforcement
- append-only provenance
- wake-based resumption

Key files:

- [crates/bakudo-daemon/src/session_controller.rs](../crates/bakudo-daemon/src/session_controller.rs)
- [crates/bakudo-daemon/src/mission_store.rs](../crates/bakudo-daemon/src/mission_store.rs)
- [crates/bakudo-daemon/src/provider_runtime.rs](../crates/bakudo-daemon/src/provider_runtime.rs)

### Current gap

The host planner is currently too opinionated, while the mission runtime is
not yet expressive enough to let the configured provider behave like a real
conductor.

## Proposed Architecture

### High-Level Model

```text
User/TUI
  -> SessionController
  -> MissionCore
  -> Host-side deliberator wake (provider adapter)
  -> typed Bakudo mission tools
  -> sandboxed worker attempts in abox
  -> experiment summaries + trace bundles
  -> next wake for analysis / verification / next wave
```

### Core principle

The host-side provider should decide:

- whether more clarification is needed
- what the first wave should be
- when to ask the user for approval
- how to analyze results
- what next tasks should run

The daemon should decide:

- what tools exist
- what data is persisted
- what execution is allowed
- how sandboxes are launched
- how wallets and wakes are enforced
- what is logged

## Proposed Changes

## 1. Replace the canned host planner with a thin conversation router

### Problem

`HostRuntime` currently performs mission intake and planning directly with
hardcoded logic.

### Proposal

Reduce the host layer to four responsibilities:

1. answer local status/progress questions without waking the provider when
   possible
2. capture one cheap local intake turn for constraints when they are missing
3. start a mission from the objective plus any captured constraints
4. route later freeform steering into the active mission

### Sketch

```rust
pub enum HostAction {
    ReplyLocal(String),
    CaptureConstraints {
        goal: String,
    },
    StartMission {
        goal: String,
        posture: Posture,
        constraints: Option<String>,
    },
    SteerMission {
        text: String,
        urgent: bool,
    },
}
```

```rust
match router.handle_input(&text, active_mission, &snapshot) {
    HostAction::ReplyLocal(msg) => {
        let _ = self.event_tx.send(SessionEvent::Info(msg)).await;
    }
    HostAction::CaptureConstraints { goal } => {
        let _ = self.event_tx.send(SessionEvent::Info(format!(
            "Before I start the mission, any hard constraints or preferences for '{}'? \
             For example scope, provider, or runtime budget.",
            goal
        ))).await;
    }
    HostAction::StartMission {
        goal,
        posture,
        constraints,
    } => {
        self.start_mission(posture, goal, None, constraints);
    }
    HostAction::SteerMission { text, urgent } => {
        self.enqueue_active_mission_message(text, urgent);
    }
}
```

### Rationale

The configured provider should be deciding the planning flow, not a Rust
template. At the same time, the current host layer is collecting useful
information cheaply. This proposal keeps a single low-cost local intake turn so
that scope constraints can be gathered before the first wake and before any
mission budget is spent.

### Expected effect on UX

Instead of:

```text
Before I queue workers, what does success look like?
```

Bakudo can do:

```text
Before I start the mission, any hard constraints or preferences? For example
scope, provider, or runtime budget.
```

and then, after the first wake:

```text
I propose two first steps:
1. Add a simple end-to-end integration test.
2. Add a dispatch-path test to verify workers are started correctly.
Do those sound like the right first steps?
```

## 2. Add safe read and conversational tools for the host-side conductor

### Problem

The mission tool surface is currently focused on execution and state mutation.
It lacks the read-only inspection and structured reporting surfaces that a
host-side conductor needs.

### Proposal

Extend the tool surface with host-safe mission tools:

- `repo_search`
- `repo_read_file`
- `read_experiment_summary`
- `read_mission_state`
- `post_message`
- `ask_user`

These tools are intended for planning, narration, and analysis on the host.
`post_message` is the general conversational primitive. `ask_user` remains the
explicit blocking user-decision tool because it already maps cleanly to durable
pending-question state and typed TUI behavior.

### Sketch

```rust
fn tool_list_value() -> Vec<Value> {
    vec![
        json!({"name": "repo_search", "description": "Search the repo read-only."}),
        json!({"name": "repo_read_file", "description": "Read a repo file or line window read-only."}),
        json!({"name": "read_experiment_summary", "description": "Read the output and summary of a completed experiment."}),
        json!({"name": "read_mission_state", "description": "Read the current durable Mission State."}),
        json!({"name": "post_message", "description": "Publish a conversational progress or proposal update to the chat transcript."}),
        json!({"name": "dispatch_swarm", "description": "Dispatch a batch of abox experiments."}),
        json!({"name": "ask_user", "description": "Prompt the user for a decision."}),
        json!({"name": "suspend", "description": "Suspend the current wake."}),
    ]
}
```

### `post_message` shape

```rust
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum MissionMessageKind {
    Progress,
    Proposal,
}

#[derive(Debug, serde::Deserialize)]
struct PostMessageArgs {
    kind: MissionMessageKind,
    message: String,
}
```

### Read boundary policy

The read-only tools need explicit boundaries because "host read-only" is still
powerful. The initial policy should be:

- repo root only
- text files only
- line and byte caps per call
- deny-list sensitive paths such as `.git/`, `.bakudo/sessions/`, `.env*`,
  `*.pem`, `*.key`
- `.gitignore` is not a security boundary

This should be enforced in the daemon rather than delegated to prompt wording.

### Rationale

This makes the provider effective without giving it unsafe host powers. It can
understand the repo, explain what it is doing, and ask for approval, while the
daemon still controls actual execution.

## 3. Extend mission experiments beyond scripts to sandboxed agent tasks

### Problem

Mission experiments are script-oriented today. That is too narrow for the
desired behavior of dispatching coding/testing workers with prompts.

### Proposal

Refactor mission experiments to support two workload kinds:

- `Script`
- `AgentTask`

`AgentTask` should flow through the existing `AttemptSpec` and `run_attempt()`
machinery, so the conductor can launch real provider-backed workers inside
`abox`.

This plan keeps `AgentTask` inside `ExperimentSpec` for the first pass rather
than creating a separate durable table or type. To make that clean:

- script-only fields move under the `Script` workload branch
- the persisted JSON format gets a tagged-union migration
- the existing terminal status enum remains sufficient for phase 3 because an
  agent task is still modeled as a one-shot sandbox attempt

If Bakudo later needs pause/resume semantics for agent workers, we can split the
type at that point.

### Sketch

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExperimentWorkload {
    Script {
        script: ExperimentScript,
        #[serde(default)]
        metric_keys: Vec<String>,
    },
    AgentTask {
        prompt: String,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        model: Option<String>,
        approve_execution: bool,
        candidate_policy: CandidatePolicy,
        sandbox_lifecycle: SandboxLifecycle,
        #[serde(default)]
        context_policy: AgentTaskContextPolicy,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentSpec {
    pub base_branch: String,
    pub skill: Option<String>,
    pub hypothesis: String,
    pub workload: ExperimentWorkload,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskContextPolicy {
    PromptOnly,
    PromptAndMissionState,
    PromptMissionStateAndRecentLedger,
}
```

### Dispatch tool request shape

```rust
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DispatchExperimentSpec {
    Script {
        label: String,
        hypothesis: String,
        #[serde(default)]
        skill: Option<String>,
        #[serde(default)]
        base_branch: Option<String>,
        script: ExperimentScript,
        #[serde(default)]
        metric_keys: Vec<String>,
    },
    AgentTask {
        label: String,
        hypothesis: String,
        prompt: String,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        model: Option<String>,
        approve_execution: bool,
        candidate_policy: CandidatePolicy,
        sandbox_lifecycle: SandboxLifecycle,
        #[serde(default)]
        context_policy: Option<AgentTaskContextPolicy>,
        #[serde(default)]
        base_branch: Option<String>,
    },
}
```

### Example mission-side dispatch

```json
{
  "experiments": [
    {
      "kind": "agent_task",
      "label": "e2e_test",
      "hypothesis": "a focused end-to-end test will validate the mission entry path",
      "prompt": "Add a focused integration test covering the simplest end-to-end bakudo command flow.",
      "provider": "codex",
      "candidate_policy": "review",
      "sandbox_lifecycle": "preserved",
      "approve_execution": false
    },
    {
      "kind": "agent_task",
      "label": "dispatch_test",
      "hypothesis": "dispatch-path coverage will catch worker launch regressions",
      "prompt": "Add a test that validates mission workers are dispatched and tracked correctly.",
      "provider": "codex",
      "candidate_policy": "review",
      "sandbox_lifecycle": "preserved",
      "approve_execution": false
    }
  ],
  "wake_when": "all_complete"
}
```

### Rationale

This is the key runtime change that lets the host-side conductor delegate
implementation work securely without turning host deliberation into host-side
execution.

### Approval policy for waves

Wave approval should be deterministic:

- approval required when a wave dispatches more than one worker
- approval required when any worker has `approve_execution = true`
- otherwise the conductor may dispatch directly and narrate the action

This keeps user-facing behavior predictable and avoids pushing approval policy
entirely into prompt heuristics.

## 4. Introduce provider launch planning with a deferred shared-adapter boundary

### Problem

The current provider integration model is too thin:

- classic path: `binary + non_interactive_args + model flag + allow-all flag`
- mission path: ad hoc process launch with engine args and env vars

That does not leverage Claude Code or Codex to their full extent, and it makes
provider-specific failures hard to debug.

### Proposal

The long-term target is a shared lower-level launch-planning layer used by both:

- `ProviderRegistry` classic execution
- `ProviderCatalog` mission wake execution

However, the early implementation should not force a fully shared abstraction
before the conductor path is working end-to-end. The boundary is:

- shared later: launch-plan construction, capability detection, output parsing
- not shared: dispatch orchestration, state persistence, wake handling,
  experiment lifecycle

That keeps the classic and wake-based paths separate even if they eventually use
the same lower-level launch-plan builder.

### Sketch

```rust
pub enum PromptTransport {
    Stdin,
    InlineArg { flag: Option<String> },
    TempFile { env_key: String },
}

pub enum ParseMode {
    PlainText,
    JsonLines,
    Mixed,
}

pub struct ProviderLaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub stdin: Option<String>,
    pub parse_mode: ParseMode,
}

pub trait ProviderAdapter {
    fn build_classic_launch(&self, req: &ClassicInvokeRequest) -> anyhow::Result<ProviderLaunchPlan>;
    fn build_wake_launch(&self, req: &WakeInvokeRequest) -> anyhow::Result<ProviderLaunchPlan>;
    fn parse_output_line(&self, line: &str) -> ProviderOutputEvent;
}
```

### Likely adapter capability fields

```rust
pub struct ProviderCapabilities {
    pub prompt_transport: PromptTransport,
    pub supports_system_prompt: bool,
    pub supports_resume: bool,
    pub parse_mode: ParseMode,
    pub allow_all_flag: Option<String>,
    pub model_flag: Option<String>,
}
```

### Rationale

This gives Bakudo one place to:

- build correct provider invocations
- detect CLI contract differences
- use provider-native capabilities where possible
- emit consistent trace logs

This is also the right place to improve Claude Code and Codex support without
entangling those details with mission storage or TUI rendering.

### Implementation note

Phase 1 should stop at trace bundles and mission-side launch tracing. A true
shared adapter is deferred until after the conductor loop and `AgentTask`
workloads exist. This reduces the risk of drawing an abstraction before the
consumers are stable.

## 5. Add typed mission activity and plan proposal events

### Problem

The current TUI mostly receives generic `Info` strings. That is not enough to
render transparent mission activity cleanly.

### Proposal

Add typed session events for:

- mission activity
- analysis/failure reasoning
- wave-aware progress rendering

### Sketch

```rust
#[derive(Debug, Clone)]
pub enum MissionPhase {
    Intake,
    Planning,
    AwaitingApproval,
    Dispatching,
    Monitoring,
    Analyzing,
    Verifying,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub enum SessionEvent {
    MissionActivity {
        mission_id: String,
        wave: u32,
        phase: MissionPhase,
        kind: MissionMessageKind,
        message: String,
    },
    // existing variants...
}
```

### Example transcript

```text
[mission][wave 1] Planning: inspecting runtime and test surfaces before proposing the first wave.
[mission][wave 1] Proposal: two implementation workers and one verification scout.
[mission][wave 1] Monitoring: both workers are running; verification scout is queued for the next wave.
[mission][wave 1] Analyzing: one worker failed because the provider expected a prompt argument instead of stdin.
```

### Rationale

This is the main UX bridge between the wake runtime and a conversational TUI.

## 6. Add per-wake and per-attempt trace bundles

### Problem

Current observability is fragmented:

- transcript JSONL
- mission provenance NDJSON
- wake JSON snapshots
- global `bakudo.log`

Useful, but not enough to diagnose provider invocation issues or mission-loop
mistakes quickly.

### Proposal

Keep compact, append-only logs, but also add verbose trace bundles under the
repo-scoped data root.

### Layout

```text
<repo-data>/traces/missions/<mission-id>/wakes/<wake-id>/
  context.json
  provider-launch.json
  stdout.log
  stderr.log
  rpc.ndjson
  summary.json

<repo-data>/traces/attempts/<task-id>/
  attempt-spec.json
  provider-launch.json
  stdout.log
  stderr.log
  summary.json
```

### Example trace summary

```json
{
  "mission_id": "9df0...",
  "wake_id": "06a3...",
  "provider": "claude-mission",
  "exit_code": 1,
  "failure_kind": "provider_contract_mismatch",
  "message": "provider expected prompt input via argument, not stdin"
}
```

### Rationale

This is the basis for iterative improvement. It gives maintainers a durable,
structured record of what Bakudo asked the provider to do, how the provider
responded, and where the contract broke down.

### Retention policy

Raw trace bundles need bounded growth. The initial retention policy should be:

- keep compact provenance and `summary.json` indefinitely
- gzip raw `stdout.log`, `stderr.log`, and `rpc.ndjson` when a wake/attempt
  closes
- retain the latest 50 wake bundles per mission
- retain the latest 200 attempt bundles per repo

Count-based retention is easier to implement and reason about than byte-based
eviction for the first pass.

## 7. Rewrite the mission prompt around conductor behavior

### Problem

The current mission prompt is short and execution-centric. It does not
explicitly teach the provider the intended conversational conductor loop.

### Proposal

Rewrite `mission.md` to teach:

1. understand the user's objective and current repo state
2. branch on `WakeReason`
3. propose a minimal first wave
4. use `post_message` for narration and proposals
5. use `ask_user` only when a blocking decision is required
6. dispatch sandboxed workers for implementation or verification
7. suspend while waiting
8. analyze success and failure on later wakes

### Sketch

```md
You are the Bakudo Mission Conductor operating on the host.

You do not edit the host repo directly.
You plan, analyze, explain, and decide what sandboxed workers should do.

Always inspect the WakeReason before acting.

- manual_resume:
  inspect the repo, Mission State, and any constraints captured at intake;
  propose a focused first wave
- user_message:
  treat the wake as steering; revise the plan or answer the user
- experiments_complete:
  read summaries, explain what changed, and decide whether to verify or continue
- experiment_failed or timeout:
  inspect failure logs, explain the failure, and decide whether to retry,
  narrow scope, or ask the user

Use `post_message` for progress and proposals.
Use `ask_user` only when you need an explicit blocking decision.
Dispatch sandboxed workers with `dispatch_swarm`.
Call `suspend` after one meaningful step.
```

### Rationale

The provider should be explicitly taught the harness model we want rather than
being expected to infer it.

## Proposed File and Type Changes

### New types

- `ExperimentWorkload`
- provider launch-planning request/response structs
- `MissionPhase`
- `MissionMessageKind`
- `MissionActivityRecord` or equivalent trace helper structs

### Likely file touches

- `crates/bakudo-daemon/src/host.rs`
- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-daemon/src/provider_runtime.rs`
- `crates/bakudo-daemon/src/task_runner.rs`
- `crates/bakudo-daemon/src/mission_store.rs`
- `crates/bakudo-core/src/provider.rs`
- `crates/bakudo-core/src/mission.rs`
- `crates/bakudo-core/src/config.rs`
- `crates/bakudo-tui/src/app.rs`
- `crates/bakudo-daemon/data/prompts/mission.md`
- `tests/runtime.rs`
- `README.md`
- `docs/current-architecture.md`

## Phased Implementation Plan

## Phase 1: Observability and trace bundles

Deliverables:

- launch plan tracing
- per-wake and per-attempt trace bundles
- fake-provider tests for prompt transport and failure modes
- retention policy enforcement

Why first:

- This reduces risk before changing mission behavior.
- It gives us better diagnostics immediately.

## Phase 2: Conductor foundation and read-only tooling

Deliverables:

- add `repo_search`, `repo_read_file`, `read_experiment_summary`,
  `read_mission_state`
- rewrite `mission.md` around `WakeReason`-aware branching
- replace the current canned planner with a thin router
- preserve one minimal local intake turn for constraints
- add `post_message`
- update TUI rendering for mission activity and wave numbers
- implement deterministic approval thresholds

Why next:

- This creates a real conductor loop without yet changing worker dispatch
  semantics.

## Phase 3: Agent-task mission experiments

Deliverables:

- `ExperimentWorkload::AgentTask`
- migration of persisted experiment JSON to the tagged workload format
- mission dispatch of real sandboxed provider workers
- success/failure analysis wakes with follow-up decisions
- persistence compatibility coverage

Why next:

- This enables the core "planning on host, work in abox" loop.

## Phase 4: Shared launch planning and end-to-end refinement

Deliverables:

- shared lower-level launch-plan builder for classic and mission provider paths
- capability probing and richer provider-specific parsing
- optional provider resume/session continuation as an optimization
- verification scout patterns
- in-depth runtime coverage

Why last:

- The provider abstraction should be drawn after the conductor path and
  `AgentTask` workloads are real.

## Test Plan

### Provider contract tests

- classic Claude stdin prompt path
- classic Codex stdin/arg path
- mission wake prompt transport path
- provider requiring inline prompt instead of stdin
- provider emitting plain text only
- provider emitting mixed output and stderr
- trace bundle retention and compression behavior

### Mission behavior tests

- starting a mission from freeform input
- preserving one intake turn for missing constraints
- first wake proposing a plan
- user approval dispatching agent-task workers
- one worker succeeds and one fails
- failure analysis wake reading logs and proposing a narrower retry
- success analysis wake dispatching a verification scout
- mission activity messages appearing in transcript
- trace bundle files written for wakes and attempts
- `WakeReason`-specific prompt behavior
- read-only tool deny-list enforcement
- persisted workload migration compatibility

### Invariants to preserve

- `MissionStore` remains the durable source of mission truth
- worktree lifecycle stays host-owned
- mission provider runtime stays wake-based
- TUI and daemon continue to communicate only through typed channels

## Risks and Mitigations

### Risk: provider adapter complexity grows quickly

Mitigation:

- keep capabilities explicit
- add fake-provider contract tests
- defer full classic/mission launch-plan convergence until phase 4

### Risk: host provider starts doing too much outside the harness

Mitigation:

- expose only typed daemon tools
- keep host mutation unavailable by default
- preserve approval gating on `host_exec`

### Risk: mission state drifts between provider memory and durable state

Mitigation:

- keep `MissionStore` authoritative
- require `update_mission_state` before suspension for durable changes
- treat provider resume as an optimization, not a source of truth

### Risk: transcript becomes noisy

Mitigation:

- use typed phases
- include wave numbers in activity events
- rate limit repeated updates
- keep low-level raw logs in trace bundles instead of spamming the chat

## Resolved Design Decisions

1. Use one conversational primitive, `post_message`, for both progress and
   proposals. Keep `ask_user` separate for blocking decisions.
2. Keep `AgentTask` inside `ExperimentSpec` in the first pass, but move
   script-only fields under the `Script` branch and add persistence migration
   coverage.
3. Preserve one minimal local intake turn for missing constraints before the
   first wake.
4. Require approval when a wave dispatches more than one worker, or when any
   worker sets `approve_execution = true`.

## Deferred Design Questions

1. Provider resume/session continuation is explicitly deferred until the base
   conductor loop and launch tracing are stable.

## Recommended First Slice

The smallest high-value implementation slice is a subset of phases 1 and 2:

1. add trace bundles
2. add `repo_search`, `repo_read_file`, `read_experiment_summary`,
   `read_mission_state`
3. rewrite `mission.md` to branch on `WakeReason`
4. replace the canned host planner with a thin router and one-turn intake
5. add `post_message` plus typed mission activity rendering

That produces a much more aligned conductor UX before introducing the larger
`AgentTask` experiment refactor or a shared provider adapter.

## Expected Outcome

After this plan is implemented, the intended user experience should look like:

```text
User: Can we come up with some good integration tests for Bakudo?

Bakudo: Before I start the mission, any hard constraints or preferences? For
example scope, provider, or runtime budget.

User: Use codex, keep it focused, and avoid long-running tests.

Bakudo: I'm reviewing the current runtime and test surface, then I'll propose a
focused first wave.

Bakudo: I propose two first steps:
1. Add a simple end-to-end integration test for a basic Bakudo command.
2. Add a dispatch-path test to validate that mission workers are launched and
   tracked correctly.
Do those sound like the right first steps?

User: yes

Bakudo: Dispatching two sandboxed workers. I'll report back as they progress.

Bakudo: One worker completed successfully. The second failed because the test
fixture did not set up the fake provider environment correctly. I'm analyzing
the failure logs now.

Bakudo: I have a narrower retry that fixes the fixture setup. I also want to
queue a verification scout once the retry lands.
```

That experience is the core target of this proposal.
