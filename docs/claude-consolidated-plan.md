# Conductor Implementation Plan (Merged)

> Archived historical design draft. The shipped runtime is described by
> `docs/current-architecture.md`; the landed target architecture is captured in
> `docs/codex-revised-plan.md`.

**Status:** Archived historical draft
**Supersedes:** `provider-conductor-implementation-plan.md`, `manus-simplified-conductor-plan.md`
**Date:** 2026-04-24
**Owner:** Bakudo maintainers

---

## Why this plan exists

Two implementation drafts landed on `main` within 24 hours of each other:

- `provider-conductor-implementation-plan.md` (infrastructure-first): trace bundles, read-only host tools, `ExperimentWorkload::AgentTask`, shared provider adapter.
- `manus-simplified-conductor-plan.md` (prompt-engineering-first): Markdown plan state, explicit `message_notify_user`/`message_ask_user`/`complete_mission` tools, thin router, typed activity events.

They solve different problems, and each one is weaker where the other is strong. This document is the merged result. It is the authoritative plan going forward; the two drafts are retained only as historical context.

## What guides this plan

Six principles, in priority order. When they conflict, the earlier one wins.

1. **Simplicity over completeness.** A smaller tool surface the Conductor can actually reason about beats a richer one it misuses. Prefer files to JSON, prefer one obvious way to do each thing.
2. **Ship in vertical slices.** Every phase leaves the product working. No half-migrated states where some missions use the old shape and some use the new.
3. **Build on what's already shipped.** PR #23 gave us a persistent `SandboxLedger`, `bakudo resume <session>`, the `bakudo-worker` envelope binary, and `bakudo doctor`. Use them; don't re-invent them.
4. **Don't draw an abstraction before the second consumer exists.** The shared launch-plan adapter is deferred until we have one.
5. **Predictable behaviour beats clever behaviour.** Approval policy, retention, dispatch rules all come from deterministic code — never from prompt heuristics alone.
6. **Observability is a feature, not a debt.** Trace bundles land in Phase 1, before we start rewriting the conductor loop.

## What we take from each draft

| Topic | Chose | Rationale |
|---|---|---|
| Plan representation | **Manus** — Markdown `mission_plan.md` | Patching JSON is where LLM agent loops break; Markdown is the natural shape for a plan. |
| Communication | **Manus** — `message_notify_user` + `message_ask_user` | Naming-carries-semantics beats enum-discrimination for LLMs. |
| Completion | **Manus** — explicit `complete_mission { summary }` | Boolean flags silently fail; summary field forces a closeout note. |
| Read-only host tools | **Conductor** — `read_experiment_summary`, `read_mission_snapshot` | Without read access, the Conductor is blind between waves. `repo_search`/`repo_read_file` deferred — see §11. |
| Worker semantics | **Conductor** — `ExperimentWorkload::{Script, AgentTask}` | The whole point of a conductor is delegating to agent-backed workers. Skipping this hollows the plan. |
| Trace artefacts | **Both** — structured dirs under `<repo-data>/traces/` + per-experiment `trace_bundle.md` | Two readers (maintainer debugging, Conductor summary) → two artefacts. |
| Intake | **Conductor** — one cheap local turn, gated | Skip when the goal already mentions scope/budget/provider. Otherwise ask once, on the host, without spending a wake. |
| Approval policy | **Conductor** — deterministic rules | Prompt heuristics drift. |
| Mission state JSON blob | **Conductor** — migrated out | Deliberate tech debt to retain compat "for now" always becomes permanent. |
| Retention | **Conductor, simplified** — count-based, no compression in v1 | Full retention policy deferred; just cap counts. |
| Shared provider adapter | **Deferred by both** — revisit post-Phase 5 | No second consumer yet. |

## Phase map at a glance

```text
Phase 1: Observability substrate          ← zero behaviour change; pure infra
Phase 2: Tool surface swap                ← the LLM-facing refactor
Phase 3: Thin host router                 ← kills the canned intake planner
Phase 4: Typed mission activity events    ← TUI transparency
Phase 5: AgentTask workers                ← the unlock (depends on 1-4)
Phase 6: Shared launch-plan adapter       ← deferred; revisit only if needed
```

Each phase is independently mergeable. Each one concludes with `cargo test --workspace && just check`.

---

## Phase 1 — Observability substrate

**Goal:** Land trace bundles before we rewrite the Conductor loop. Zero semantic change; pure infrastructure. Makes Phases 2-5 debuggable without adding their own diagnostics.

**Scope:** `crates/bakudo-daemon/src/{task_runner,session_controller}.rs`, `crates/bakudo-daemon/src/trace.rs` (new), `tests/runtime.rs`.

### 1.1 Directory layout

Traces live under the repo-scoped data dir (the same root as `ledger.jsonl`):

```
<repo-data>/traces/
├── missions/<mission_id>/wakes/<wake_id>/
│   ├── wake-event.json           # the WakeEvent payload at entry
│   ├── provider-launch.json      # argv, env sans secrets, stdin preview
│   ├── stdout.log                # raw provider stdout for the wake
│   ├── stderr.log                # raw provider stderr
│   ├── rpc.ndjson                # one BAKUDO_EVENT/_RESULT per line
│   └── summary.json              # status, exit code, duration, failure kind
└── attempts/<task_id>/
    ├── attempt-spec.json
    ├── provider-launch.json
    ├── stdout.log
    ├── stderr.log
    └── summary.json
```

Trace dirs are created opportunistically. Missing dirs must never cause a runtime error.

### 1.2 `TraceRecorder` abstraction

One small struct in `bakudo-daemon/src/trace.rs`:

```rust
pub struct TraceRecorder {
    base_dir: PathBuf,
}

pub enum TraceTarget<'a> {
    Wake { mission_id: &'a str, wake_id: &'a str },
    Attempt { task_id: &'a str },
}

impl TraceRecorder {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self { /* ... */ }

    pub async fn record_launch(&self, target: TraceTarget<'_>, launch: &ProviderLaunchView) -> Result<()>;
    pub async fn append_stdout(&self, target: TraceTarget<'_>, line: &str) -> Result<()>;
    pub async fn append_stderr(&self, target: TraceTarget<'_>, line: &str) -> Result<()>;
    pub async fn append_rpc(&self, target: TraceTarget<'_>, envelope: &RpcEnvelope) -> Result<()>;
    pub async fn finalize(&self, target: TraceTarget<'_>, summary: &TraceSummary) -> Result<()>;
}
```

All methods are best-effort: a write failure is logged via `tracing::warn!` but never propagated to the caller. Worker execution must not fail because disk is full.

`TraceRecorder` is plumbed through `SessionController::new` and `TaskRunnerConfig`. Both are `Arc`-wrapped because trace writes happen on hot paths.

### 1.3 `trace_bundle.md` — the Conductor-facing artefact

When a worker finalises, write a Markdown summary alongside the structured dir:

```
<repo-data>/sessions/<mission_id>/traces/<experiment_id>.md
```

This is the file `read_experiment_summary` (Phase 2) reads. Format is fixed:

```markdown
# Experiment Trace: <label>

**ID:** `<experiment_id>`
**Status:** <status>
**Exit Code:** <code>
**Duration:** <seconds>s

## Hypothesis
<free text>

## stdout (tail)
```
<last 200 lines>
```

## stderr (tail)
```
<last 200 lines>
```

## Metrics
- **<key>:** <value>
```

The `.md` is derived from the same `TraceSummary` that produces the structured dir. No double sourcing.

### 1.4 Retention (v1)

Count-based, no compression. On each `record_launch`:

- Keep the latest **50** wake bundles per mission; delete older dirs.
- Keep the latest **200** attempt bundles per repo; delete older dirs.
- Never delete anything referenced by an active mission.

Compression and byte-based eviction are deferred to a later pass.

### 1.5 Tests

| Test | What it verifies |
|---|---|
| `trace_recorder_writes_attempt_summary` | A completed attempt produces `attempt-spec.json`, `stdout.log`, `summary.json`. |
| `trace_bundle_md_roundtrip` | The `.md` derived from a `TraceSummary` contains the label, status, tail, and metrics. |
| `trace_retention_caps_wake_count` | Creating 60 wake dirs leaves exactly 50 on disk. |
| `trace_write_failure_does_not_propagate` | A readonly base dir causes `warn!` but no `Err`. |

**Deliverable:** Observability is live for existing missions with no semantic changes. Maintainer can diagnose provider contract issues immediately.

---

## Phase 2 — Tool surface swap

**Goal:** Replace the JSON-patch mission-state tool and introduce the Manus-style communication primitives and completion tool. Keep the host-side read tools the Conductor needs to reason between waves.

**Scope:** `crates/bakudo-daemon/src/session_controller.rs`, `crates/bakudo-daemon/data/prompts/{mission,explore}.md`, `tests/runtime.rs`.

### 2.1 Tool surface after this phase

| Tool | Status | Shape |
|---|---|---|
| `read_plan` | **new** | `() → { content: String }` |
| `update_plan` | **new** | `{ content: String } → { written: true }` |
| `message_notify_user` | **new** | `{ message: String } → { delivered: true }` |
| `message_ask_user` | **rename** of `ask_user` | unchanged semantics |
| `complete_mission` | **new** | `{ summary: String } → { completed: true }` — transitions mission to `Completed` |
| `read_experiment_summary` | **new** | `{ experiment_id: String } → { found: bool, content?: String }` |
| `read_mission_snapshot` | **new** | `() → { plan: String, active_experiments: [{id,label,status}], ledger_tail: [LedgerEntry] }` |
| `dispatch_swarm` | keep | unchanged |
| `suspend` | **modify** | remove the `complete` flag |
| `abox_exec`, `abox_apply_patch`, `host_exec`, `record_lesson`, `cancel_experiments` | keep | unchanged |
| `update_mission_state` | **remove** | breaking change; no compat bridge |

### 2.2 Why `read_mission_snapshot` (and not `repo_search`/`repo_read_file`)

The Conductor needs to be able to say, on wake N+1, "what does the plan look like right now, and what happened on the last wave?" That's `read_plan` + `read_experiment_summary`. But it also needs to know, in one call: *what experiments are currently in flight, and what are the last N ledger entries?* Hence `read_mission_snapshot`.

`repo_search` and `repo_read_file` were in the Conductor draft and are explicitly **deferred** to a follow-up. Rationale:

- They require a daemon-enforced deny-list, path canonicalisation, symlink hardening, and byte/line caps. That's real security engineering.
- The Conductor can already dispatch a small exploration worker via `dispatch_swarm` when it needs to read files.
- We'll add them only if logged prompts show the Conductor repeatedly asking users to describe the repo.

### 2.3 Markdown plan file

One file per mission:

```
<repo-data>/sessions/<mission_id>/mission_plan.md
```

Created by `start_mission` with a seed template. `read_plan` returns the file or a default-empty stub if the file is missing. `update_plan` overwrites the file atomically (write-temp-then-rename) and appends a `LedgerEntry` of kind `Decision` with summary `"plan updated (<N> chars)"`.

The file is treated as opaque Markdown. The daemon does not parse it.

### 2.4 `MissionState` JSON blob removal

Remove the `MissionState` field from the `missions` SQLite row and from `WakeEvent`. Add a SQLite migration to drop the column. The Conductor no longer receives structured state in its wake payload — it calls `read_plan` on every wake (explicitly instructed by the prompt).

**This is a breaking change with no compat bridge.** Any mission persisted before this phase will get an empty plan on next resume; the Conductor's prompt instructs it to re-plan from the goal + ledger on `manual_resume` wakes.

### 2.5 `complete_mission`

Transitions the active mission to `MissionStatus::Completed`, appends a `Decision` ledger entry (`"mission complete: <summary>"`), emits `SessionEvent::MissionActivity(MissionCompleted{...})` (from Phase 4, stubbed earlier as `SessionEvent::Info` — see §4 for the upgrade), and sets `suspend: true` on the outcome.

`suspend` loses its `complete` flag. A `suspend` call can never terminate a mission; only `complete_mission` can.

### 2.6 Prompt rewrite

`mission.md` and `explore.md` are rewritten in the Manus XML-tag style. The loop each prompt enforces is:

```
1. read_plan
2. for each completed experiment in the wake:
     read_experiment_summary
3. update_plan (always; even if just to record that nothing changed)
4. message_notify_user (describe intent for this wake)
5. EITHER dispatch_swarm  OR  complete_mission
6. suspend
```

`message_ask_user` is only used when the Conductor is genuinely blocked; the prompt says this explicitly.

### 2.7 Tests

| Test | What it verifies |
|---|---|
| `conductor_reads_initial_plan` | First wake sees the seed plan written by `start_mission`. |
| `conductor_updates_plan_appends_ledger` | `update_plan` overwrites the file and writes one `Decision` entry. |
| `notify_user_emits_info_event_no_block` | `message_notify_user` never sets `suspend: true`. |
| `ask_user_blocks_until_answer` | `message_ask_user` suspends until `AnswerUserQuestion` arrives. |
| `complete_mission_transitions_status` | `complete_mission` sets `MissionStatus::Completed`. |
| `suspend_complete_flag_is_ignored` | Passing `complete: true` to `suspend` is a deserialization error or silent no-op (codify which). |
| `read_experiment_summary_not_found` | Returns `{found: false}` when the trace bundle doesn't exist. |
| `read_mission_snapshot_contains_active_experiments` | Includes experiments with status `Running` or `Queued`. |
| `update_mission_state_tool_removed` | Calling the old tool name returns `ToolNotFound`. |

---

## Phase 3 — Thin host router

**Goal:** Replace `HostRuntime::handle_input`'s canned stage machine with a router that either starts a mission or steers an active one. Keep one optional intake turn for constraint capture.

**Scope:** `crates/bakudo-daemon/src/host.rs`, `session_controller.rs::handle_host_input`.

### 3.1 `HostAction` (new shape)

```rust
pub enum HostAction {
    /// No active mission — start one with this goal.
    StartMission { goal: String, posture: Posture, constraints: Option<String> },

    /// Active mission exists — forward user input as steering.
    SteerMission { text: String, urgent: bool },

    /// No active mission; goal is ambiguous about scope. Ask once before starting.
    AskForConstraints { goal: String },

    /// Local reply without waking the provider (e.g. "what's your status?").
    Reply(String),
}
```

`LaunchPlan`, `PlannedMission`, `DispatchedMissionTask`, `MissionMode`, `staged_plan`, and the `is_yes_like`/`is_no_like` helpers are deleted.

### 3.2 The intake gate

Between the Manus plan (zero turns) and the Conductor plan (always one turn), we gate:

```rust
fn needs_constraint_intake(goal: &str) -> bool {
    let s = goal.to_ascii_lowercase();
    let hints = [
        "using", "with", "without", "under", "budget", "scope",
        "provider", "model", "in <", " minutes", " hours",
        "don't", "do not", "avoid", "only", "just"
    ];
    !hints.iter().any(|h| s.contains(h)) && goal.split_whitespace().count() <= 12
}
```

If the goal is short and contains no constraint hints, we ask once ("any constraints or preferences for `<goal>`?") before starting the mission. Otherwise we start immediately.

The next user message after `AskForConstraints` is treated as the constraints blob and passed into `StartMission.constraints`. Missions created with constraints have them injected into the seed `mission_plan.md` as a `## Constraints` section.

### 3.3 Posture inference

```rust
fn infer_posture(goal: &str) -> Posture {
    let s = goal.to_ascii_lowercase();
    let explore_hints = [
        "investigate", "review", "analyze", "understand",
        "explore", "research", "find out", "why ", "what is", "how does"
    ];
    if explore_hints.iter().any(|h| s.contains(h)) {
        Posture::Explore
    } else {
        Posture::Mission
    }
}
```

Explicit per the Conductor draft. Trivially overridable later.

### 3.4 Tests

| Test | What it verifies |
|---|---|
| `router_starts_mission_when_idle_with_constraint_hints` | "Fix the failing tests without touching CI" → `StartMission`. |
| `router_asks_for_constraints_when_goal_is_short` | "Fix the tests" → `AskForConstraints`. |
| `router_steers_active_mission` | Any input with an active mission → `SteerMission`. |
| `router_answers_local_status_query` | "what's the status?" → `Reply` without waking. |
| `infer_posture_investigate_returns_explore` | `investigate` in goal → `Posture::Explore`. |
| `constraint_intake_writes_to_plan_seed` | After `AskForConstraints` + reply, `mission_plan.md` contains a `## Constraints` section. |

---

## Phase 4 — Typed mission activity events

**Goal:** Replace `SessionEvent::Info(String)` from the mission path with typed variants the TUI can render distinctly.

**Scope:** `crates/bakudo-daemon/src/session_controller.rs`, `crates/bakudo-tui/src/{app,ui}.rs`.

### 4.1 `MissionActivity`

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub enum MissionActivity {
    PlanUpdated { mission_id: String, wave: u32, char_count: usize },
    WaveDispatched { mission_id: String, wave: u32, labels: Vec<String> },
    WorkerFinished { mission_id: String, wave: u32, experiment_id: String, label: String, succeeded: bool },
    ConductorNotified { mission_id: String, wave: u32, message: String },
    MissionCompleted { mission_id: String, wave: u32, summary: String },
    AwaitingApproval { mission_id: String, wave: u32, pending: Vec<String> },
}
```

`wave` is the 1-indexed wave number tracked by `SessionController`; it increments on each successful `dispatch_swarm`. This is the field the Conductor plan called out and is worth the complexity.

### 4.2 `SessionEvent::MissionActivity` variant added

`SessionEvent::Info` is kept for non-mission informational messages (host router replies, config changes). Mission path uses the typed variant exclusively.

### 4.3 TUI rendering

Transcript renders each variant with distinct role, icon, and color via the existing `MessageRole` surface:

- `PlanUpdated` → dim "·" + "plan updated ({chars} chars)".
- `WaveDispatched` → bold "▸" + "wave N: dispatching: label1, label2".
- `WorkerFinished` → "✓" green or "✗" red + "wave N: {label} {succeeded|failed}".
- `ConductorNotified` → role::AgentOutput.
- `MissionCompleted` → bold green + summary.
- `AwaitingApproval` → amber + "wave N: approval required for: …".

The shelf panel gains a "wave" column, populated from the most recent `WaveDispatched`/`WorkerFinished` per mission.

### 4.4 Tests

Rendering regression via existing `ratatui::TestBackend` pattern. Four new assertions, one per variant, that the rendered buffer contains the expected text fragment.

---

## Phase 5 — `AgentTask` workers (the unlock)

**Goal:** Allow `dispatch_swarm` to launch real agent-backed workers — not just scripts — inside `abox`. This is the phase where Bakudo actually becomes a host-side conductor of sandboxed agents.

**Scope:** `crates/bakudo-core/src/mission.rs` (ExperimentSpec), `bakudo-daemon/src/{task_runner,session_controller}.rs`, `bakudo-worker/src/main.rs` (already present; minor extensions), `tests/runtime.rs`, SQLite migration.

### 5.1 `ExperimentWorkload` tagged union

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskContextPolicy {
    #[default]
    PromptOnly,
    PromptAndPlan,
    PromptAndPlanAndLedger,
}
```

`ExperimentSpec` becomes:

```rust
pub struct ExperimentSpec {
    pub base_branch: String,
    pub skill: Option<String>,
    pub hypothesis: String,
    pub workload: ExperimentWorkload,
}
```

### 5.2 SQLite migration

One forward-only migration that maps existing script-only rows to `ExperimentWorkload::Script`. Rows with a non-null `agent_task_*` column shape (there are none in production) round-trip correctly. Migration is tested by asserting `cargo test` passes on a pre-Phase-5 SQLite file checked in under `tests/fixtures/`.

### 5.3 AgentTask execution path

`run_experiment` branches on workload:

- `Script` — current pipeline, unchanged.
- `AgentTask` — builds an `AttemptSpec` and invokes `run_attempt` (the same code the headless `bakudo run` uses). The worker command is `bakudo-worker <provider-argv...>`, using the binary from PR #23. The attempt's `BAKUDO_PROMPT` env var carries the agent prompt. `context_policy` controls whether the plan and/or ledger tail are injected as additional env vars (`BAKUDO_PLAN`, `BAKUDO_LEDGER_TAIL`).

The worker's existing `BAKUDO_RESULT` envelope is what `read_experiment_summary` (via `trace_bundle.md`) surfaces to the Conductor on the next wake.

### 5.4 Deterministic approval policy

Before dispatch:

- If **any** worker in the wave has `approve_execution: true`, the full wave requires approval.
- If the wave has **>1** worker, the full wave requires approval.
- Otherwise, the daemon dispatches directly and emits `MissionActivity::WaveDispatched`.

Approval is still the existing `SessionEvent::PendingApproval` flow; this phase only codifies the trigger. When approval is required, the daemon emits `MissionActivity::AwaitingApproval` and suspends the wake until the user responds via the TUI modal or `bakudo approve <wave-id>`.

### 5.5 Tests

| Test | What it verifies |
|---|---|
| `experiment_workload_script_roundtrips_in_sqlite` | Backward compat. |
| `experiment_workload_agent_task_roundtrips` | Forward shape. |
| `agent_task_launches_bakudo_worker` | Fake abox captures `bakudo-worker` in argv. |
| `agent_task_context_policy_prompt_and_plan_injects_env` | `BAKUDO_PLAN` env var is present. |
| `dispatch_single_script_needs_no_approval` | Direct dispatch. |
| `dispatch_two_scripts_requires_approval` | Emits `AwaitingApproval`. |
| `dispatch_single_agent_task_with_approve_flag_requires_approval` | Approval gate fires on the flag alone. |
| `worker_result_envelope_feeds_trace_bundle` | The `.md` contains the `BAKUDO_RESULT.summary` line. |

---

## Phase 6 — Shared launch-plan adapter (deferred)

**Not landing in this plan.** Revisit only if:

1. The classic `ProviderRegistry` path and the Phase-5 `AgentTask` path start diverging in provider CLI handling, **or**
2. A second provider requires substantially different invocation shape (e.g. websocket transport).

Without either trigger, we're drawing an abstraction before the second consumer exists.

If we do revisit, the Conductor draft's `ProviderLaunchPlan`/`ProviderAdapter` shape is the starting point.

---

## Non-goals (in scope of this plan, explicitly not touched)

- **`repo_search`/`repo_read_file`** host tools — deferred behind a logged-prompt signal.
- **Retention compression / gzip** — count-based eviction only in v1.
- **Multi-mission** — single active mission per session.
- **Provider resume / session continuation** — optimisation, not correctness.
- **TUI redesign** — shelf and modals unchanged; only transcript-side rendering updated in Phase 4.
- **Budget / wallet policy** — unchanged.

## Open questions (to resolve before Phase 2 lands)

1. **`suspend.complete` removal behaviour.** If the LLM passes `{complete: true}` to `suspend` after Phase 2, do we error or silently ignore? Current preference: silent ignore with a `warn!` log; the LLM will get corrected when it fails to transition and calls `complete_mission` on the next wake.
2. **Plan file size cap.** We don't enforce one now. If abuse patterns emerge (e.g. Conductor writing a 1 MB plan), add a ~100 KB cap on `update_plan`.
3. **Ledger tail length in `read_mission_snapshot`.** Default 20 entries; may need tuning.

## Dependencies on prior work (PR #23)

Anchoring on what already shipped:

- `SandboxLedger::with_persistence` is the ledger backing `manual_resume` wakes. No new schema.
- `bakudo-worker` is the carrier for `AgentTask` in Phase 5. Its envelope protocol (`BAKUDO_EVENT`, `BAKUDO_RESULT`) is what `trace_bundle.md` reads.
- `bakudo doctor` is unchanged but gets a new line in its output post-Phase 5: `bakudo-worker [ok|miss]`.
- `/diff <task-id>` remains the worktree inspection command; Phase 2's `read_experiment_summary` is its Conductor-facing analogue.

## Ordering guarantees

- Phase 1 **must** merge before Phase 2. Phase 2 uses `trace_bundle.md` as `read_experiment_summary`'s read source.
- Phases 2, 3, 4 are independent after Phase 1 and may be parallelised across maintainers.
- Phase 5 **must** come after Phases 2 (needs `read_experiment_summary`) and 4 (emits typed activity events).
- Phase 6 is unscheduled.

## Definition of done

For every phase:

1. `just check` passes (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`).
2. All new tests in the phase's test table exist and pass.
3. `docs/current-architecture.md` is updated to reflect the new surface.
4. `CHANGELOG.md` has an entry describing user-visible changes.
5. Phases 2 and 5 additionally require a manual smoke test against a real `abox` sandbox with at least one provider installed.

---

## Appendix A — Rejected alternatives

### A.1 Keep `update_mission_state` behind a feature flag

Tempting to avoid a breaking change, but: the JSON-patch surface was the single worst piece of LLM-facing ergonomics in the existing design. Shipping it dual-tracked with the Markdown plan would double the prompt-engineering surface and invite the Conductor to freelance between the two. Removed cleanly.

### A.2 `post_message { kind: "progress"|"proposal" }` instead of two tools

The Conductor draft argued for one conversational primitive with an enum discriminator. Passed over because enum-discriminated tool surfaces consistently underperform distinct-named tools in LLM tool-use benchmarks. The tool *name* is the clearest signal of semantics; burying it in a `kind` field costs tokens and loses specificity.

### A.3 No intake turn (Manus's original position)

Rejected. The cheap local question "any constraints?" costs zero tokens from the provider and prevents one full wake round-trip that would otherwise fire `message_ask_user` on the first wake for short goals. The gate in §3.2 keeps it opt-out: detailed goals skip the intake.

### A.4 Ship `repo_search` / `repo_read_file` in Phase 2

Rejected for v1. The read-policy surface is genuinely non-trivial (path canonicalisation, `.git/` and credential deny-listing, symlink traversal, byte caps) and the Conductor can already spawn a worker to do targeted reads. We revisit only if logs show it repeatedly asking the user to describe repo layout.

### A.5 Full trace-bundle compression and byte-based retention

Deferred. Count-based eviction is obvious and right ~80% of the time. We'll add compression when we have real disk-usage data, not before.

---

## Appendix B — File touches summary

| File | Phase | Change |
|---|---|---|
| `crates/bakudo-daemon/src/trace.rs` | 1 | **new** |
| `crates/bakudo-daemon/src/task_runner.rs` | 1, 5 | trace plumbing; AgentTask branch |
| `crates/bakudo-daemon/src/session_controller.rs` | 1, 2, 4, 5 | every phase |
| `crates/bakudo-daemon/src/host.rs` | 3 | router rewrite |
| `crates/bakudo-daemon/data/prompts/mission.md` | 2 | prompt rewrite |
| `crates/bakudo-daemon/data/prompts/explore.md` | 2 | prompt rewrite |
| `crates/bakudo-core/src/mission.rs` | 2, 5 | remove MissionState; add ExperimentWorkload |
| `crates/bakudo-core/src/migrations/` | 2, 5 | two SQLite migrations |
| `crates/bakudo-tui/src/app.rs` | 4 | MissionActivity handling |
| `crates/bakudo-tui/src/ui.rs` | 4 | typed rendering |
| `crates/bakudo-worker/src/main.rs` | 5 | minor — expose context env vars |
| `tests/runtime.rs` | every | every phase adds tests |
| `docs/current-architecture.md` | every | rolling update |
| `CHANGELOG.md` | every | rolling update |

---

## Appendix C — Terminology

- **Conductor** — the host-side provider (Claude/Codex/etc.) that plans missions via `mission_plan.md` and orchestrates waves of workers.
- **Worker** — an agent-backed or script-backed process running *inside* an `abox` sandbox, executing one step of the mission.
- **Wave** — a batch of workers dispatched together via a single `dispatch_swarm` call.
- **Trace bundle** — the `.md` summary (Conductor-facing) or the structured directory (maintainer-facing) of an experiment or wake.
- **Wake** — one execution of the Conductor loop, driven by a `WakeEvent` (experiment complete, user message, budget warning, etc.).
