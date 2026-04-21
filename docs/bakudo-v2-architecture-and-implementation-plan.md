# Bakudo v2: Architecture & Implementation Plan

## 1. Vision & Core Principles

Bakudo v2 is a Rust-native orchestration layer that wraps an existing LLM harness (like Claude Code or Codex) to provide parallel-by-default execution using `abox` sandboxes. It shifts Bakudo from a complex, hardcoded multi-agent state machine into a lightweight **Supervisor** that manages budgets, fleets, and state, while delegating all cognitive work to the **Deliberator** (the ephemeral harness process).

### Core Principles
1. **Model 3 Split:** The Supervisor is a tiny, persistent Rust daemon. The Deliberator is an ephemeral harness process spawned only when thinking is required.
2. **Parallel-by-Default:** Both Mission (verification fan-out) and Explore (hypothesis fan-out) postures rely on `dispatch_swarm`.
3. **abox-First:** 95%+ of code execution happens in ephemeral `abox` instances via MCP tools, drastically reducing human approval prompts on the host.
4. **Two-Meter Wallet:** Budgets are strictly enforced on `wall_clock_remaining` and `abox_workers_remaining`.
5. **Declarative Providers:** Harnesses are configured via TOML, binding an engine (e.g., `claude-code`) to an abox profile and a posture.

---

## 2. Architecture & Data Model

### 2.1 Workspace Layout
The project will be a single Rust workspace (ideally pulling `abox-core` types).

```text
bakudo/
├── Cargo.toml
└── crates/
    ├── bakudo-core/       # Domain types (Mission, Wallet, WakeEvent, Blackboard). No IO.
    ├── bakudo-supervisor/ # Daemon: fleet management, SQLite store, scheduler, MCP server.
    ├── bakudo-tui/        # ratatui shell (Codex-style).
    ├── bakudo-providers/  # Harness adapters (Claude Code, Codex) via TOML config.
    ├── bakudo-mcp/        # MCP tool definitions and stdio transport.
    └── bakudo-cli/        # Entrypoint (launches supervisor + TUI).
```

### 2.2 Core Types (`bakudo-core`)

```rust
pub struct Wallet {
    pub wall_clock_remaining: Duration,
    pub abox_workers_remaining: u32,
    pub abox_workers_in_flight: u32,
    pub concurrent_max: u32,
}

pub enum WakeReason {
    UserMessage,
    ExperimentsComplete,
    ExperimentFailed,
    BudgetWarning,
    BudgetExhausted,
    SchedulerTick,
    Timeout,
    ManualResume,
}

pub struct WakeEvent {
    pub reason: WakeReason,
    pub payload: serde_json::Value,
    pub blackboard: serde_json::Value,
    pub wallet: Wallet,
    pub user_inbox: Vec<String>,
}
```

### 2.3 Storage Layer
Use **SQLite** (`rusqlite` or `sqlx`) at `.bakudo/state.db`.
Schema:
- `missions` (id, status, wallet_state, created_at)
- `experiments` (id, mission_id, abox_job_id, status, result_summary)
- `wake_events` (id, mission_id, payload, processed)
- `blackboards` (mission_id, json_state)

---

## 3. The Execution Loop

1. **User Input:** User types a goal in the TUI.
2. **Wake:** Supervisor reads `.bakudo/providers/default.toml`, spawns the Deliberator (e.g., `claude --mcp stdio:bakudo-mcp`).
3. **Plan:** Deliberator reads the Blackboard and Wallet (injected via MCP meta-info).
4. **Dispatch:** Deliberator calls `dispatch_swarm(hypotheses)` via MCP.
5. **Suspend:** Supervisor starts `abox` workers, returns `{"status": "suspended"}`. Deliberator exits.
6. **Idle:** Supervisor monitors `abox`. TUI shows spinning worker icons.
7. **Wake:** Workers finish. Supervisor debounces events and spawns Deliberator with `WakeEvent::ExperimentsComplete`.
8. **Synthesize:** Deliberator reviews results, updates Blackboard, and either completes the Mission or dispatches again.

---

## 4. MCP Tool Surface

The Supervisor exposes these tools to the Deliberator:

1. **`dispatch_swarm`**: Accepts a list of execution specs (script + hypothesis). Returns job IDs and a `suspend` instruction.
2. **`update_blackboard`**: Patches the JSON state.
3. **`abox_exec` / `abox_apply_patch`**: Runs commands in a single ephemeral sandbox (for planning/setup).
4. **`host_exec`**: Runs commands on the host. **Requires human approval** in the TUI.
5. **`ask_user`**: Prompts the user for clarification.
6. **`record_lesson`**: Appends a distilled learning to `.bakudo/lessons/`.

---

## 5. Phased Implementation Plan

This plan is designed for a fresh session to execute iteratively.

### Phase 1: Foundation & Core Types
**Goal:** Set up the Rust workspace and domain models.
1. Initialize Cargo workspace with `bakudo-core`, `bakudo-supervisor`, `bakudo-cli`.
2. Define `Wallet`, `WakeEvent`, `WakeReason`, and `Blackboard` in `bakudo-core`.
3. Add SQLite setup to `bakudo-supervisor` with basic schema creation.
*Acceptance:* `cargo check` passes; `bakudo-cli` can create an empty `.bakudo/state.db`.

### Phase 2: MCP Server & abox Integration
**Goal:** Build the MCP transport and connect it to `abox`.
1. Create `bakudo-mcp` crate. Implement stdio transport.
2. Define the `dispatch_swarm` and `abox_exec` tools.
3. Integrate `abox-core` (or shell out to `abox run` if vendoring is blocked) to execute tasks.
*Acceptance:* A mock client can connect to the MCP server over stdio and trigger an `abox` job.

### Phase 3: The Supervisor & Wake Loop
**Goal:** Implement the Model 3 lifecycle.
1. Build the fleet manager in `bakudo-supervisor` to track active `abox` jobs.
2. Implement debouncing: when jobs finish, aggregate them into a single `WakeEvent`.
3. Create `bakudo-providers` to parse TOML configs and spawn the Deliberator subprocess (e.g., `claude --resume`).
*Acceptance:* Supervisor can start 3 parallel jobs, wait for them, and print the aggregated `WakeEvent` to stdout.

### Phase 4: The Codex-Style TUI
**Goal:** Build the interactive shell.
1. Create `bakudo-tui` using `ratatui` and `crossterm`.
2. Implement 3 panes: Blackboard (top), Fleet Status (middle), Transcript (bottom), plus an Input Bar.
3. Connect the TUI to the Supervisor's event bus via MPSC channels.
*Acceptance:* TUI renders correctly, shows dummy active workers, and accepts text input without blocking.

### Phase 5: Integration & Prompts
**Goal:** Tie it all together with actual LLM harnesses.
1. Write the `Mission` and `Explore` system prompts.
2. Configure `.bakudo/providers/claude-mission.toml`.
3. Wire the `bakudo-cli` to launch the Supervisor in the background and the TUI in the foreground.
*Acceptance:* End-to-end run: User types "optimize this", Bakudo spawns Claude, Claude calls `dispatch_swarm`, TUI shows workers, Claude wakes and synthesizes.

### Phase 6: Cleanup & Migration
**Goal:** Remove old TS code.
1. Delete `src/gateway.ts`, `src/objectiveController.ts`, `src/providerRegistry.ts`.
2. Port any necessary skill catalogs to `.bakudo/skills/`.
3. Update `README.md` and `AGENTS.md`.
