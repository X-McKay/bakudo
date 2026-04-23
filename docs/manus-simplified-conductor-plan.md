# Manus-Simplified Provider-Conductor Implementation Plan

**Status:** Draft  
**Supersedes:** `provider-conductor-implementation-plan.md`  
**Informed by:** Manus agent system prompt analysis and prior review of the original plan

---

## Table of Contents

1. [Background and Motivation](#1-background-and-motivation)
2. [Design Principles Borrowed from Manus](#2-design-principles-borrowed-from-manus)
3. [The Simplified Conductor Loop](#3-the-simplified-conductor-loop)
4. [Revised Tool Surface](#4-revised-tool-surface)
5. [Phase 1 — Markdown Plan and Communication Tools](#5-phase-1--markdown-plan-and-communication-tools)
6. [Phase 2 — Trace Bundles and Explicit Completion](#6-phase-2--trace-bundles-and-explicit-completion)
7. [Phase 3 — Thin Host Router](#7-phase-3--thin-host-router)
8. [Phase 4 — Typed Mission Activity Events](#8-phase-4--typed-mission-activity-events)
9. [Prompt Rewrite](#9-prompt-rewrite)
10. [Test Plan](#10-test-plan)
11. [Migration and Compatibility Notes](#11-migration-and-compatibility-notes)
12. [Non-Goals](#12-non-goals)

---

## 1. Background and Motivation

The original `provider-conductor-implementation-plan.md` correctly diagnosed the problems with the current `HostRuntime` canned planner and proposed a seven-phase conductor loop. However, the Manus agent system prompt demonstrates that a highly capable agent loop needs almost nothing except:

- A clear event-stream model.
- A single-tool-per-iteration discipline.
- A clean split between non-blocking narration and blocking questions.
- A simple Markdown file for plan tracking rather than a JSON state object.

The original plan's seven-phase loop was correct in its intent but over-specified in its mechanism. This plan replaces it with a simpler, more robust design that borrows the Manus communication and planning patterns wholesale, while keeping the `abox`-mediated execution boundary that makes Bakudo unique and secure.

The key insight is: **borrow Manus's communication and planning patterns; replace its execution tools with `abox`-mediated equivalents.**

---

## 2. Design Principles Borrowed from Manus

### 2.1 Markdown Planning over JSON State Patching

The current `update_mission_state` tool asks the LLM to construct a JSON merge patch against a structured object. This is the most LLM-hostile operation in the tool surface. Manus uses a simple Markdown checklist (`todo.md`) that the agent reads, updates, and rewrites.

For Bakudo, a `mission_plan.md` file stored in `.bakudo/sessions/<mission-id>/` will replace the JSON state blob. The file is:

- Trivially human-readable in the TUI.
- Far easier for the LLM to reason about.
- Naturally versioned (the file is overwritten on each `update_plan` call, and the provenance log captures the full history).
- Suitable for plan re-evaluation (the LLM can rewrite the entire file when the goal changes).

### 2.2 Explicit Communication Tool Naming

Manus's naming makes the blocking semantics obvious in the tool name itself. The current `ask_user` tool is renamed to `message_ask_user`, and a new `message_notify_user` tool is introduced for non-blocking narration. This is not merely cosmetic — it directly reduces the probability of the LLM using the blocking tool when narration is sufficient.

### 2.3 Trace Bundles over Raw DB Reads

Instead of giving the Conductor access to raw SQLite experiment records, each completed worker generates a `trace_bundle.md` file. The `read_experiment_summary` tool reads this file and returns its content. This ensures:

- The LLM sees exactly the relevant output.
- The context window is not wasted on structured data the LLM must re-parse.
- The trace bundle can be tuned independently of the DB schema.

### 2.4 Explicit Mission Completion

The current `suspend(complete=true)` pattern forces the LLM to make a judgment call via a boolean flag, which can silently go wrong. A dedicated `complete_mission` tool, requiring a `summary` argument, makes the completion path explicit and forces a human-readable completion note.

---

## 3. The Simplified Conductor Loop

The Conductor operates on a simple wake-driven loop. On every wake, it executes the following logic (enforced via the system prompt, not hardcoded Rust branching):

```
1. ANALYZE   — Read WakeReason and mission_plan.md.
2. INVESTIGATE — Use read_experiment_summary if wake contains experiment results.
3. PLAN      — Call update_plan to update mission_plan.md with new findings or next steps.
4. COMMUNICATE — Call message_notify_user to narrate intent.
               Call message_ask_user ONLY if genuinely blocked.
5. DISPATCH  — Call dispatch_swarm to delegate work to sandboxed workers.
6. SUSPEND   — Call suspend to sleep while workers execute.
7. COMPLETE  — Call complete_mission when the goal is achieved.
```

This is a direct translation of the Manus agent loop into Bakudo's wake model. The LLM will naturally behave differently when it sees `experiments_complete` vs `user_message` without needing explicit case-by-case Rust branching.

---

## 4. Revised Tool Surface

The following table shows the complete tool surface after this refactor, compared to the current state.

| Current Tool | New Tool | Change | Notes |
|---|---|---|---|
| `update_mission_state` | `read_plan` / `update_plan` | **Replace** | JSON patch → Markdown file |
| `ask_user` | `message_ask_user` | **Rename** | Blocking question to user |
| *(none)* | `message_notify_user` | **Add** | Non-blocking narration |
| *(none)* | `read_experiment_summary` | **Add** | Reads trace bundle for an experiment |
| `suspend` | `suspend` | **Modify** | Remove `complete` flag |
| *(none)* | `complete_mission` | **Add** | Explicit mission completion with summary |
| `dispatch_swarm` | `dispatch_swarm` | **Keep** | No change |
| `abox_exec` | `abox_exec` | **Keep** | No change |
| `abox_apply_patch` | `abox_apply_patch` | **Keep** | No change |
| `host_exec` | `host_exec` | **Keep** | No change |
| `record_lesson` | `record_lesson` | **Keep** | No change |
| `cancel_experiments` | `cancel_experiments` | **Keep** | No change |

---

## 5. Phase 1 — Markdown Plan and Communication Tools

**Goal:** Migrate core state tracking from JSON to Markdown and introduce the explicit communication tools.

**Scope:** `session_controller.rs`, `mission_store.rs`, `app.rs`, `tests/runtime.rs`

### 5.1 Remove JSON State

**File:** `crates/bakudo-daemon/src/session_controller.rs`

Delete the following:

```rust
// DELETE this struct
#[derive(Debug, serde::Deserialize)]
struct MissionStatePatchArgs {
    patch: Value,
}

// DELETE this match arm in handle_tool_call()
"update_mission_state" => {
    self.tool_update_mission_state(mission, wake, call.arguments)
        .await?
}

// DELETE this entire function
async fn tool_update_mission_state(...) -> Result<ToolCallOutcome> { ... }
```

Also remove the `update_mission_state` entry from `tool_list_value()`.

The `initial_mission_state()` function and the `MissionState` type in `bakudo-core` are **not** deleted in this phase — they are still used by the `WakeEvent` payload. They will be addressed in Phase 3.

### 5.2 Introduce the Markdown Plan File

**File:** `crates/bakudo-daemon/src/session_controller.rs`

The plan file lives at: `<repo_data_dir>/sessions/<mission_id>/mission_plan.md`

Add a helper to `MissionCore`:

```rust
fn plan_path(&self, mission_id: MissionId) -> PathBuf {
    self.config
        .resolved_repo_data_dir_from_str(self.session.repo_root.as_deref())
        .join("sessions")
        .join(mission_id.to_string())
        .join("mission_plan.md")
}
```

Modify `start_mission` in `MissionCore` to create the initial plan file after persisting the mission:

```rust
// After upsert_mission() succeeds:
let plan_path = self.plan_path(mission.id);
if let Some(parent) = plan_path.parent() {
    tokio::fs::create_dir_all(parent).await?;
}
let initial_plan = format!(
    "# Mission Plan\n\n**Goal:** {goal}\n\n## Steps\n\n- [ ] (Initial planning step — update this on first wake)\n",
    goal = mission.goal
);
tokio::fs::write(&plan_path, initial_plan).await?;
```

### 5.3 Implement `read_plan` and `update_plan` Tools

**File:** `crates/bakudo-daemon/src/session_controller.rs`

Add the argument structs:

```rust
#[derive(Debug, serde::Deserialize)]
struct UpdatePlanArgs {
    /// The full new content of mission_plan.md. Overwrites the existing file.
    content: String,
}
```

`read_plan` takes no arguments. Add the tool implementations:

```rust
async fn tool_read_plan(
    &self,
    mission: &Mission,
    _wake: &WakeEvent,
    _arguments: Value,
) -> Result<ToolCallOutcome> {
    let path = self.plan_path(mission.id);
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            "# Mission Plan\n\n(No plan written yet.)\n".to_string()
        }
        Err(e) => return Err(e.into()),
    };
    Ok(ToolCallOutcome {
        payload: json!({ "content": content }),
        suspend: false,
        mission_status: None,
    })
}

async fn tool_update_plan(
    &self,
    mission: &Mission,
    _wake: &WakeEvent,
    arguments: Value,
) -> Result<ToolCallOutcome> {
    let args: UpdatePlanArgs = serde_json::from_value(arguments)?;
    let path = self.plan_path(mission.id);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, &args.content).await?;
    self.mission_store
        .append_ledger(&LedgerEntry {
            at: Utc::now(),
            kind: LedgerKind::Decision,
            summary: format!("plan updated ({} chars)", args.content.len()),
            mission_id: mission.id,
            experiment_id: None,
        })
        .await?;
    Ok(ToolCallOutcome {
        payload: json!({ "written": true }),
        suspend: false,
        mission_status: None,
    })
}
```

Add both tools to the `handle_tool_call` match arm and to `tool_list_value()`:

```rust
// In handle_tool_call():
"read_plan" => self.tool_read_plan(mission, wake, call.arguments).await?,
"update_plan" => self.tool_update_plan(mission, wake, call.arguments).await?,

// In tool_list_value():
json!({"name": "read_plan", "description": "Read the current mission_plan.md file."}),
json!({"name": "update_plan", "description": "Overwrite mission_plan.md with new content. Pass the full new Markdown text."}),
```

### 5.4 Rename `ask_user` and Introduce `message_notify_user`

**File:** `crates/bakudo-daemon/src/session_controller.rs`

Rename the existing `tool_ask_user` function to `tool_message_ask_user`. Update the match arm:

```rust
// Before:
"ask_user" => self.tool_ask_user(mission, wake, call.arguments).await?,

// After:
"message_ask_user" => self.tool_message_ask_user(mission, wake, call.arguments).await?,
```

Update `tool_list_value()`:

```rust
// Before:
json!({"name": "ask_user", "description": "Prompt the user for a decision."}),

// After:
json!({"name": "message_ask_user", "description": "Block the current wake and prompt the user for a decision. Use ONLY when genuinely blocked."}),
```

Add the `message_notify_user` tool. This is a non-blocking narration tool that emits a `SessionEvent::Info` and appends a ledger entry:

```rust
#[derive(Debug, serde::Deserialize)]
struct NotifyUserArgs {
    /// The message to display to the user in the transcript.
    message: String,
}

async fn tool_message_notify_user(
    &self,
    mission: &Mission,
    _wake: &WakeEvent,
    arguments: Value,
) -> Result<ToolCallOutcome> {
    let args: NotifyUserArgs = serde_json::from_value(arguments)?;
    let _ = self
        .event_tx
        .send(SessionEvent::Info(format!(
            "[mission {}] {}",
            mission.id, args.message
        )))
        .await;
    self.mission_store
        .append_ledger(&LedgerEntry {
            at: Utc::now(),
            kind: LedgerKind::Decision,
            summary: format!("notify_user: {}", &args.message.chars().take(120).collect::<String>()),
            mission_id: mission.id,
            experiment_id: None,
        })
        .await?;
    Ok(ToolCallOutcome {
        payload: json!({ "delivered": true }),
        suspend: false,
        mission_status: None,
    })
}
```

Add to `handle_tool_call` and `tool_list_value()`:

```rust
// In handle_tool_call():
"message_notify_user" => self.tool_message_notify_user(mission, wake, call.arguments).await?,

// In tool_list_value():
json!({"name": "message_notify_user", "description": "Send a non-blocking narration message to the user. Use for progress updates and announcements."}),
```

### 5.5 TUI Updates

**File:** `crates/bakudo-tui/src/app.rs`

The `AskUserArgs` struct name in the TUI is not directly coupled to the tool name, so no TUI struct changes are needed. However, the welcome message in `App::new()` still describes the old host UX ("clarify, stage a plan, then dispatch workers"). Update it to describe the new conversational conductor model:

```rust
// Replace the welcome message text with:
"Welcome to Bakudo. Start a mission with /mission <goal> or just describe what you want to accomplish."
```

---

## 6. Phase 2 — Trace Bundles and Explicit Completion

**Goal:** Improve how the Conductor reads worker results and finalize the mission lifecycle.

**Scope:** `session_controller.rs`, `task_runner.rs`, `tests/runtime.rs`

### 6.1 Trace Bundle Generation

When a worker completes, generate a `trace_bundle.md` file alongside the existing run summary. This file is designed to be read by the Conductor's `read_experiment_summary` tool.

**File:** `crates/bakudo-daemon/src/session_controller.rs` (in `run_experiment`, after the worker finishes)

Add a helper function:

```rust
fn write_trace_bundle(
    data_dir: &Path,
    experiment: &Experiment,
    summary: &ExperimentSummary,
) -> Result<()> {
    let bundle_dir = data_dir.join("sessions").join(experiment.mission_id.to_string()).join("traces");
    std::fs::create_dir_all(&bundle_dir)?;
    let path = bundle_dir.join(format!("{}.md", experiment.id));

    let status_str = format!("{:?}", experiment.status);
    let exit_code = summary.exit_code;
    let duration_secs = summary.duration.as_secs();

    let mut content = format!(
        "# Experiment Trace: {label}\n\n\
         **ID:** `{id}`  \n\
         **Status:** {status}  \n\
         **Exit Code:** {exit_code}  \n\
         **Duration:** {duration_secs}s  \n\n\
         ## Hypothesis\n\n{hypothesis}\n\n",
        label = experiment.label,
        id = experiment.id,
        status = status_str,
        exit_code = exit_code,
        duration_secs = duration_secs,
        hypothesis = experiment.spec.hypothesis,
    );

    if !summary.stdout_tail.is_empty() {
        content.push_str("## stdout (tail)\n\n```\n");
        content.push_str(&summary.stdout_tail);
        content.push_str("\n```\n\n");
    }

    if !summary.stderr_tail.is_empty() {
        content.push_str("## stderr (tail)\n\n```\n");
        content.push_str(&summary.stderr_tail);
        content.push_str("\n```\n\n");
    }

    if !summary.metrics.is_empty() {
        content.push_str("## Metrics\n\n");
        for (key, value) in &summary.metrics {
            content.push_str(&format!("- **{key}:** {value}\n"));
        }
        content.push('\n');
    }

    std::fs::write(path, content)?;
    Ok(())
}
```

Call this function in `run_experiment()` after `upsert_experiment()` succeeds with a terminal status:

```rust
if let Some(summary) = &experiment.summary {
    if let Err(e) = write_trace_bundle(&self.repo_data_dir(), &experiment, summary) {
        warn!("Failed to write trace bundle for {}: {e}", experiment.id);
    }
}
```

### 6.2 Implement `read_experiment_summary` Tool

**File:** `crates/bakudo-daemon/src/session_controller.rs`

```rust
#[derive(Debug, serde::Deserialize)]
struct ReadExperimentSummaryArgs {
    /// The experiment ID to read the trace bundle for.
    experiment_id: String,
}

async fn tool_read_experiment_summary(
    &self,
    mission: &Mission,
    _wake: &WakeEvent,
    arguments: Value,
) -> Result<ToolCallOutcome> {
    let args: ReadExperimentSummaryArgs = serde_json::from_value(arguments)?;
    let bundle_dir = self
        .repo_data_dir()
        .join("sessions")
        .join(mission.id.to_string())
        .join("traces");
    let path = bundle_dir.join(format!("{}.md", args.experiment_id));
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ToolCallOutcome {
                payload: json!({
                    "found": false,
                    "error": "Trace bundle not found. The experiment may still be running."
                }),
                suspend: false,
                mission_status: None,
            });
        }
        Err(e) => return Err(e.into()),
    };
    Ok(ToolCallOutcome {
        payload: json!({ "found": true, "content": content }),
        suspend: false,
        mission_status: None,
    })
}
```

Add to `handle_tool_call` and `tool_list_value()`:

```rust
// In handle_tool_call():
"read_experiment_summary" => {
    self.tool_read_experiment_summary(mission, wake, call.arguments).await?
}

// In tool_list_value():
json!({"name": "read_experiment_summary", "description": "Read the trace bundle for a completed experiment. Returns the stdout, stderr, metrics, and status."}),
```

### 6.3 Introduce `complete_mission`

**File:** `crates/bakudo-daemon/src/session_controller.rs`

Add the argument struct:

```rust
#[derive(Debug, serde::Deserialize)]
struct CompleteMissionArgs {
    /// A human-readable summary of what was accomplished.
    summary: String,
}
```

Add the tool implementation:

```rust
async fn tool_complete_mission(
    &self,
    mission: &Mission,
    _wake: &WakeEvent,
    arguments: Value,
) -> Result<ToolCallOutcome> {
    let args: CompleteMissionArgs = serde_json::from_value(arguments)?;
    self.mission_store
        .append_ledger(&LedgerEntry {
            at: Utc::now(),
            kind: LedgerKind::Decision,
            summary: format!("mission complete: {}", args.summary),
            mission_id: mission.id,
            experiment_id: None,
        })
        .await?;
    let _ = self
        .event_tx
        .send(SessionEvent::Info(format!(
            "[mission {}] Complete: {}",
            mission.id, args.summary
        )))
        .await;
    Ok(ToolCallOutcome {
        payload: json!({ "completed": true, "summary": args.summary }),
        suspend: true,
        mission_status: Some(MissionStatus::Completed),
    })
}
```

Add to `handle_tool_call` and `tool_list_value()`:

```rust
// In handle_tool_call():
"complete_mission" => self.tool_complete_mission(mission, wake, call.arguments).await?,

// In tool_list_value():
json!({"name": "complete_mission", "description": "Mark the mission as complete and provide a summary of what was accomplished. This ends the current wake and transitions the mission to Completed status."}),
```

### 6.4 Modify `suspend` to Remove `complete` Flag

**File:** `crates/bakudo-daemon/src/session_controller.rs`

```rust
// Before:
#[derive(Debug, serde::Deserialize)]
struct SuspendArgs {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    expected_wake: Option<String>,
    #[serde(default)]
    complete: bool,  // ← REMOVE THIS
}

// After:
#[derive(Debug, serde::Deserialize)]
struct SuspendArgs {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    expected_wake: Option<String>,
}
```

Update `tool_suspend`:

```rust
async fn tool_suspend(
    &self,
    _mission: &Mission,
    _wake: &WakeEvent,
    arguments: Value,
) -> Result<ToolCallOutcome> {
    let args: SuspendArgs = serde_json::from_value(arguments)?;
    Ok(ToolCallOutcome {
        payload: json!({
            "reason": args.reason,
            "expected_wake": args.expected_wake,
            "suspended": true,
        }),
        suspend: true,
        mission_status: None,  // ← No longer sets Completed; use complete_mission for that.
    })
}
```

---

## 7. Phase 3 — Thin Host Router

**Goal:** Replace the complex `HostRuntime` with a thin router that immediately transitions conversational input into the mission loop.

**Scope:** `host.rs`, `session_controller.rs`, `tests/runtime.rs`

### 7.1 Deprecate `HostRuntime` Planning Logic

The `HostRuntime` in `crates/bakudo-daemon/src/host.rs` currently implements a multi-turn staged planner (objective → success criteria → constraints → plan → confirm → dispatch). This entire staging flow is removed.

The new `HostRuntime` is a thin router with a single responsibility: determine whether the input is a steering message for an active mission, or the start of a new one.

**New `HostAction` enum:**

```rust
pub enum HostAction {
    /// Start a new mission immediately with this goal.
    StartMission { goal: String },
    /// Enqueue a steering message for the active mission.
    SteerMission { text: String, urgent: bool },
    /// No active mission and input is ambiguous — ask for clarification.
    Reply(String),
}
```

Note: `LaunchPlan` is removed. `StartMission` replaces it.

**New `handle_input` logic:**

```rust
pub fn handle_input(&self, text: &str, snapshot: &HostSnapshot) -> HostAction {
    let has_active_mission = snapshot.has_active_mission;
    if has_active_mission {
        // All input routes to the active mission as steering.
        let urgent = is_urgent(text);
        HostAction::SteerMission { text: text.to_string(), urgent }
    } else {
        // No active mission — start one immediately.
        HostAction::StartMission { goal: text.to_string() }
    }
}
```

The `HostSnapshot` struct gains a `has_active_mission: bool` field, populated from `MissionRuntimeState::active_mission_id` in `handle_host_input`.

### 7.2 Update `handle_host_input` in `SessionController`

**File:** `crates/bakudo-daemon/src/session_controller.rs`

```rust
async fn handle_host_input(&mut self, text: String) {
    let has_active_mission = {
        let state = self.runtime_state.lock().await;
        state.active_mission_id.is_some()
    };
    let snapshot = HostSnapshot {
        entries: self.ledger.all().await,
        provider_id: self.current_provider.clone(),
        model: self.current_model.clone(),
        base_branch: self.config.base_branch.clone(),
        has_active_mission,
    };
    match self.host.handle_input(&text, &snapshot) {
        HostAction::Reply(message) => {
            let _ = self.event_tx.send(SessionEvent::Info(message)).await;
        }
        HostAction::SteerMission { text, urgent } => {
            self.enqueue_active_mission_message(text, urgent);
        }
        HostAction::StartMission { goal } => {
            // Infer posture from goal text; default to Mission.
            let posture = infer_posture(&goal);
            self.start_mission(posture, goal, None, None);
        }
    }
}
```

Add a simple `infer_posture` helper:

```rust
fn infer_posture(goal: &str) -> Posture {
    let normalized = goal.trim().to_ascii_lowercase();
    let explore_hints = ["investigate", "review", "analyze", "understand", "explore", "research", "find out", "why ", "what is", "how does"];
    if explore_hints.iter().any(|hint| normalized.contains(hint)) {
        Posture::Explore
    } else {
        Posture::Mission
    }
}
```

### 7.3 Telemetry Migration

The `HostRuntime` currently provides `note_task_started`, `note_runner_event`, `note_task_finished`, and `maybe_render_completion_note`. These are used in `dispatch_task_with_policies` to render progress for classic (non-mission) tasks.

These methods are **retained** in the simplified `HostRuntime` for classic task dispatch. They are not part of the mission conductor path. No migration is needed in this phase.

### 7.4 Remove Staging State

The following fields and methods are removed from `HostRuntime`:

- `staged_plan: Mutex<Option<PlannedMission>>`
- `build_plan()`
- `launch_announcement()`
- `looks_investigative()`
- `is_status_query()`
- `is_yes_like()`
- `is_no_like()`
- `mark_plan_dispatched()`

The `PlannedMission`, `DispatchedMissionTask`, and `MissionMode` types are removed from `host.rs`.

The `launch_plan()` method in `SessionController` is removed. The `HostAction::LaunchPlan` variant is removed.

---

## 8. Phase 4 — Typed Mission Activity Events

**Goal:** Replace generic `Info` strings from the mission conductor with structured, typed events for the TUI.

**Scope:** `session_controller.rs`, `app.rs`

### 8.1 Define `MissionActivity`

**File:** `crates/bakudo-daemon/src/session_controller.rs` (or a new `mission_activity.rs`)

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub enum MissionActivity {
    /// The Conductor updated the mission plan.
    PlanUpdated { mission_id: String, char_count: usize },
    /// The Conductor dispatched a wave of workers.
    WaveDispatched { mission_id: String, count: usize, labels: Vec<String> },
    /// A worker completed.
    WorkerFinished { mission_id: String, experiment_id: String, label: String, succeeded: bool },
    /// The Conductor sent a narration message.
    ConductorNotified { mission_id: String, message: String },
    /// The mission completed.
    MissionCompleted { mission_id: String, summary: String },
}
```

### 8.2 Update `SessionEvent`

**File:** `crates/bakudo-daemon/src/session_controller.rs`

Add a new variant:

```rust
pub enum SessionEvent {
    // ... existing variants ...
    /// A typed activity event from the mission conductor.
    MissionActivity(MissionActivity),
}
```

The existing `Info` variant is retained for non-mission informational messages.

### 8.3 Emit Typed Events from Tools

Update the relevant tool implementations to emit `MissionActivity` events alongside (or instead of) generic `Info` events:

- `tool_update_plan` → emit `MissionActivity::PlanUpdated`
- `tool_dispatch_swarm` → emit `MissionActivity::WaveDispatched`
- `run_experiment` (on completion) → emit `MissionActivity::WorkerFinished`
- `tool_message_notify_user` → emit `MissionActivity::ConductorNotified`
- `tool_complete_mission` → emit `MissionActivity::MissionCompleted`

### 8.4 TUI Rendering

**File:** `crates/bakudo-tui/src/app.rs`

Add handling for `SessionEvent::MissionActivity` in the event loop. Render each variant as a distinct transcript entry with appropriate formatting:

```rust
SessionEvent::MissionActivity(activity) => {
    let text = match &activity {
        MissionActivity::PlanUpdated { .. } => "Plan updated.".to_string(),
        MissionActivity::WaveDispatched { count, labels, .. } => {
            format!("Dispatching {} worker(s): {}", count, labels.join(", "))
        }
        MissionActivity::WorkerFinished { label, succeeded, .. } => {
            let status = if *succeeded { "succeeded" } else { "failed" };
            format!("Worker '{label}' {status}.")
        }
        MissionActivity::ConductorNotified { message, .. } => message.clone(),
        MissionActivity::MissionCompleted { summary, .. } => {
            format!("Mission complete: {summary}")
        }
    };
    self.push_transcript(ChatMessage {
        role: MessageRole::AgentOutput,
        text,
    });
}
```

---

## 9. Prompt Rewrite

The system prompts in `crates/bakudo-daemon/data/prompts/` are rewritten using the XML-tagged module pattern from Manus. This pattern separates concerns cleanly within a single prompt file.

### 9.1 `mission.md`

```markdown
<security_boundary>
You operate as the Bakudo Mission Conductor. You have NO direct access to the filesystem, shell, or network. All code execution happens inside isolated `abox` sandboxes via `dispatch_swarm`, `abox_exec`, or `abox_apply_patch`. You cannot modify the host repository directly.
</security_boundary>

<agent_loop>
On every wake, execute exactly these steps in order:
1. Call `read_plan` to load the current mission_plan.md.
2. If the wake contains experiment results, call `read_experiment_summary` for each.
3. Call `update_plan` to update the plan with new findings or next steps.
4. Call `message_notify_user` to narrate your intent for this wake.
5. Call `dispatch_swarm` to delegate work, OR call `complete_mission` if the goal is met.
6. Call `suspend` to sleep while workers execute.

You MUST call `message_ask_user` ONLY if you are genuinely blocked and need a user decision. Do not ask for confirmation of obvious next steps.
</agent_loop>

<wake_handling>
- `experiments_complete`: Use `read_experiment_summary` to inspect results before deciding next steps.
- `experiment_failed`: Inspect the failure, update the plan, and decide whether to retry or pivot.
- `user_message`: Treat the user's input as steering. Update the plan to reflect it.
- `budget_warning`: Acknowledge in the plan. Prioritise the highest-value remaining steps.
- `budget_exhausted`: Call `complete_mission` with a summary of what was accomplished so far.
- `manual_resume`: Re-read the plan and continue from where you left off.
</wake_handling>

<planning>
The mission_plan.md file is your primary state. Keep it current. A good plan has:
- A clear goal statement.
- A checklist of steps with [ ] for pending and [x] for completed.
- A "Findings" section updated after each wave of experiments.
- A "Next Steps" section that reflects the current decision.
</planning>
```

### 9.2 `explore.md`

```markdown
<security_boundary>
You operate as the Bakudo Exploration Conductor. You have NO direct access to the filesystem, shell, or network. All investigation happens inside isolated `abox` sandboxes via `dispatch_swarm` or `abox_exec`. You cannot modify the host repository directly.
</security_boundary>

<agent_loop>
On every wake, execute exactly these steps in order:
1. Call `read_plan` to load the current mission_plan.md.
2. If the wake contains experiment results, call `read_experiment_summary` for each.
3. Call `update_plan` to record findings and update hypotheses.
4. Call `message_notify_user` to narrate what you found and what you will try next.
5. Call `dispatch_swarm` to test the next hypothesis, OR call `complete_mission` if the done contract is satisfied.
6. Call `suspend` to sleep while workers execute.
</agent_loop>

<wake_handling>
- `experiments_complete`: Record findings in the plan. Update `best_known` and `things_tried`. Decide next hypothesis.
- `experiment_failed`: Record the failure. Pivot to a different approach.
- `user_message`: Treat as new steering. Update the done contract if the user has changed the goal.
- `budget_warning`: Prioritise the most informative remaining hypothesis.
- `budget_exhausted`: Call `complete_mission` with a summary of the best known answer.
</wake_handling>

<planning>
The mission_plan.md for an exploration mission should include:
- The question being investigated.
- The done contract (what "answered" looks like).
- A "Hypotheses" section with [ ] for untested and [x] for tested.
- A "Findings" section updated after each wave.
- A "Best Known Answer" section, updated whenever a better answer is found.
</planning>
```

---

## 10. Test Plan

All new tests are added to `tests/runtime.rs`, which already has the `write_mock_deliberator_script()` helper and the exec-provider harness.

### 10.1 Phase 1 Tests

| Test Name | What It Verifies |
|---|---|
| `conductor_reads_initial_plan` | On first wake, `read_plan` returns the initial plan file created by `start_mission`. |
| `conductor_updates_plan` | `update_plan` overwrites the file and appends a ledger entry. |
| `conductor_notify_user_emits_info_event` | `message_notify_user` emits a `SessionEvent::Info` with the correct message. |
| `conductor_ask_user_blocks_and_resolves` | `message_ask_user` blocks until `AnswerUserQuestion` is sent, then returns the answer. |

### 10.2 Phase 2 Tests

| Test Name | What It Verifies |
|---|---|
| `trace_bundle_written_on_experiment_success` | After a worker succeeds, a `trace_bundle.md` exists in the expected path. |
| `trace_bundle_written_on_experiment_failure` | After a worker fails, a `trace_bundle.md` exists with the correct exit code. |
| `read_experiment_summary_returns_bundle` | `read_experiment_summary` returns the correct content for a completed experiment. |
| `read_experiment_summary_not_found` | Returns `found: false` for a non-existent experiment ID. |
| `complete_mission_transitions_to_completed` | `complete_mission` sets `MissionStatus::Completed` and emits the correct event. |
| `suspend_no_longer_accepts_complete_flag` | `suspend` with `complete: true` in the JSON does not set `Completed` status. |

### 10.3 Phase 3 Tests

| Test Name | What It Verifies |
|---|---|
| `host_input_starts_mission_when_none_active` | `HostInput` with no active mission calls `start_mission`. |
| `host_input_steers_active_mission` | `HostInput` with an active mission enqueues a user message. |
| `infer_posture_explore_for_investigate` | `infer_posture("investigate the memory leak")` returns `Posture::Explore`. |
| `infer_posture_mission_for_implement` | `infer_posture("implement the new caching layer")` returns `Posture::Mission`. |

### 10.4 Phase 4 Tests

| Test Name | What It Verifies |
|---|---|
| `mission_activity_plan_updated_emitted` | `update_plan` emits a `SessionEvent::MissionActivity(PlanUpdated {...})`. |
| `mission_activity_wave_dispatched_emitted` | `dispatch_swarm` emits a `SessionEvent::MissionActivity(WaveDispatched {...})`. |
| `mission_activity_worker_finished_emitted` | Worker completion emits `SessionEvent::MissionActivity(WorkerFinished {...})`. |
| `mission_activity_completed_emitted` | `complete_mission` emits `SessionEvent::MissionActivity(MissionCompleted {...})`. |

---

## 11. Migration and Compatibility Notes

### 11.1 Existing Missions

Active missions in the SQLite store will not have a `mission_plan.md` file. The `read_plan` tool handles this gracefully by returning a default "No plan written yet" response when the file is not found. The Conductor's prompt instructs it to create an initial plan on the first wake after a `manual_resume`, which is the wake reason used for recovered missions.

### 11.2 `MissionState` JSON Blob

The `MissionState` JSON blob in the SQLite `missions` table is **not removed** in this refactor. It continues to be included in `WakeEvent` payloads as a compatibility field. It will be deprecated in a future cleanup pass once all active missions have migrated to the Markdown plan.

### 11.3 `initial_mission_state()` Function

The `initial_mission_state()` function in `session_controller.rs` is retained but its output is no longer the primary state representation. It populates the `WakeEvent.mission_state` field for backward compatibility.

### 11.4 Tool Name Changes and Provider Compatibility

The tool renames (`ask_user` → `message_ask_user`) are breaking changes for any provider TOML that references the old tool names in its prompt. The prompt files in `data/prompts/` are updated in Phase 1. Any repo-local provider TOMLs (`.bakudo/providers/`) must also be updated before upgrading.

---

## 12. Non-Goals

The following items are explicitly out of scope for this refactor:

- **`AgentTask` experiments:** The `ExperimentSpec` type and the worker execution pipeline are not changed. Workers continue to run scripts, not LLM agents.
- **Multi-mission support:** The `active_mission_id` single-mission constraint is not relaxed.
- **Budget policy changes:** The `Wallet` and `WakeReason::BudgetWarning`/`BudgetExhausted` logic is not changed, only surfaced in the new prompt.
- **TUI redesign:** The shelf, approval modal, and question modal are not redesigned. Only the transcript rendering and welcome copy are updated.
- **`abox` protocol changes:** The worker execution contract (`BAKUDO_SPEC_PATH`, `BAKUDO_PROMPT`, etc.) is not changed.
