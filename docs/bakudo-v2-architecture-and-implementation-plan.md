# Bakudo v2 — Architecture & Implementation Plan

> **Purpose of this document.** This is the hand-off specification for a complete rewrite of Bakudo. A fresh contributor (human or agent) should be able to read this document cold, with zero prior context on Bakudo v1, and execute the implementation. It defines the architecture, every public type, every MCP tool, the wake protocol, the storage schema, the TUI shape, the migration plan, and a phased build order with explicit acceptance criteria.
>
> **Scope.** This plan supersedes the existing TypeScript implementation in `src/`. Bakudo v2 is a Rust rewrite that wraps an existing LLM harness (Claude Code, Codex) using the Model Context Protocol (MCP) and dispatches sandboxed work via [`abox`](https://github.com/X-McKay/abox). It is **not** an incremental refactor; the legacy TS code is removed at the end of Phase 8.
>
> **Authoring context.** The design was derived after a deep comparative review of Claude Code, Codex CLI, OpenHarness, OpenCode, and the GitHub Spec Kit. The decisions encoded here are intentional and should be challenged only with reference to a concrete failure mode, not aesthetic preference.

---

## Table of Contents

1.  [Vision and Non-Goals](#1-vision-and-non-goals)
2.  [Mental Model: Supervisor / Deliberator Split](#2-mental-model-supervisor--deliberator-split)
3.  [Architectural Pillars](#3-architectural-pillars)
4.  [Workspace Layout and Crate Responsibilities](#4-workspace-layout-and-crate-responsibilities)
5.  [Domain Model (`bakudo-core`)](#5-domain-model-bakudo-core)
6.  [The MCP Tool Surface (`bakudo-mcp`)](#6-the-mcp-tool-surface-bakudo-mcp)
7.  [Provider Configuration (`bakudo-providers`)](#7-provider-configuration-bakudo-providers)
8.  [The Supervisor (`bakudo-supervisor`)](#8-the-supervisor-bakudo-supervisor)
9.  [Storage Schema (SQLite)](#9-storage-schema-sqlite)
10. [The Wake Protocol End-to-End](#10-the-wake-protocol-end-to-end)
11. [Mission and Explore Postures](#11-mission-and-explore-postures)
12. [The TUI (`bakudo-tui`)](#12-the-tui-bakudo-tui)
13. [System Prompts and Skills](#13-system-prompts-and-skills)
14. [Security and Approval Model](#14-security-and-approval-model)
15. [Observability, Logging, Provenance](#15-observability-logging-provenance)
16. [Phased Implementation Plan](#16-phased-implementation-plan)
17. [Migration from Bakudo v1](#17-migration-from-bakudo-v1)
18. [Testing Strategy](#18-testing-strategy)
19. [Open Decisions Reserved for the Implementer](#19-open-decisions-reserved-for-the-implementer)
20. [Appendix A — Example WakeEvent JSON](#20-appendix-a--example-wakeevent-json)
21. [Appendix B — Example Provider TOML files](#21-appendix-b--example-provider-toml-files)
22. [Appendix C — Default System Prompts](#22-appendix-c--default-system-prompts)

---

## 1. Vision and Non-Goals

### 1.1 What Bakudo Is

Bakudo is a **lightweight orchestration layer** that sits between a developer and an existing LLM coding harness. Its core value proposition is that it gives the harness a single tool — `dispatch_swarm` — backed by `abox` microVMs, which lets the model execute many code-changing experiments in parallel under a strict budget, while preserving live human steering.

Conceptually, Bakudo is a "primary agent" with two operating postures, **Mission** (depth-first, structured, parallel verification) and **Explore** (breadth-first, hypothesis-driven, parallel experimentation), running on top of a harness like Claude Code, with `abox` providing the sandbox substrate and the unique value-add.

### 1.2 What Bakudo Is Not

Bakudo is **not** a standalone agent loop. It does not implement its own LLM client, its own context-management strategy, or its own tool-use parser. Those are the harness's job.

Bakudo is **not** a multi-agent framework. There are no "Explorer", "Critic", or "Synthesizer" first-class entities in the host. Those are postures the single Deliberator adopts via prompt context, not separate processes.

Bakudo is **not** a CI system. Its budget is measured in seconds and abox-workers per Mission, not in build minutes per month.

### 1.3 Why a Rewrite

Bakudo v1 (TypeScript) accreted a multi-agent state machine in `objectiveController.ts`, `macroOrchestrationSession.ts`, `providerRegistry.ts`, and a daemon HTTP gateway. Roughly 23,000 lines of host-side orchestration that, on review, can be expressed in ~2,000 lines of Rust by pushing role-based logic into prompts and skills, and by relying on `abox` (already Rust, hex-architected) directly. The Node runtime is also a poor fit for an "always-on" supervisor that needs to be invisible in `htop`.

---

## 2. Mental Model: Supervisor / Deliberator Split

Bakudo v2 has exactly two cooperating processes per repository:

1.  **Supervisor** — a single static Rust binary, persistent, ~5 MB resident. Owns the TUI, the abox fleet, the SQLite state store, the wallet, the wake scheduler, and the MCP server. **Never** makes LLM calls itself.
2.  **Deliberator** — the LLM harness process (e.g., `claude`, `codex`). Spawned by the Supervisor only when reasoning is required. Connects to the Supervisor over MCP stdio. Exits when it calls the `suspend` tool or when its per-wake budget is exhausted.

The Deliberator is **stateless across wakes**. State that must persist (Blackboard, Ledger, Wallet, fleet status) lives in the Supervisor. Each wake re-injects whatever state the Deliberator needs via the `WakeEvent` payload and the MCP meta-info block.

This split is the single most important architectural decision in this document. Every other choice flows from it.

```text
                ┌─────────────────────────────────┐
                │  Bakudo Supervisor (always-on)  │
                │  ┌──────────┐  ┌─────────────┐  │
                │  │  TUI     │  │ MCP Server  │  │
                │  └──────────┘  └─────────────┘  │
                │  ┌──────────┐  ┌─────────────┐  │
                │  │ Wallet   │  │ Fleet Mgr   │──┼──► abox abox abox
                │  └──────────┘  └─────────────┘  │
                │  ┌──────────────────────────┐   │
                │  │ SQLite (.bakudo/state.db)│   │
                │  └──────────────────────────┘   │
                └────────────┬────────────────────┘
                             │ spawn / stdin / stdout
                             ▼
                ┌─────────────────────────────────┐
                │ Deliberator (Claude / Codex)    │
                │ Lives only for one wake.        │
                └─────────────────────────────────┘
```

---

## 3. Architectural Pillars

### 3.1 Parallel-by-Default

Both postures use the same primitive — `dispatch_swarm` — to fan out N abox workers. The difference is the *shape* of the batch and the *gate* applied to results:

| Posture | Batch shape | Gate |
|---|---|---|
| Mission verification | Homogeneous verifiers (`tests`, `lint`, `bench`, `typecheck`) | All-must-pass |
| Explore experiment | Heterogeneous hypotheses (alternative implementations of a goal) | Pick-the-winner |

There is **no** "spawn one worker to verify" code path. If the agent is doing useful sandboxed work, it is fanning out.

### 3.2 abox-First Execution

The default provider configuration instructs the Deliberator that any code execution, modification, package install, or shell command must be performed via the Bakudo MCP tools `abox_exec`, `abox_apply_patch`, or `dispatch_swarm`. The harness's built-in shell tool is rejected by an MCP middleware unless the requested command is on a small `safe_on_host` allowlist (read-only repo inspection only).

The broad allowlist for what's permitted *inside* an abox is owned by the abox profile (`dev-broad`, `dev-strict`), not by Bakudo. Bakudo selects a profile per Mission.

### 3.3 Two-Meter Wallet

Budgets are exactly two numbers, both hard limits:

- `wall_clock_remaining` — total real-world time the Mission may consume.
- `abox_workers_remaining` — total number of abox workers the Mission may spawn (cumulative, not concurrent).

A third *soft* cap, `concurrent_max`, protects the developer's machine from being overwhelmed and is exposed for the agent to plan its waves around. There are no token, dollar, or model-call meters in v1; those can be added in v2 if needed.

### 3.4 Declarative Providers

Harness selection, posture, abox profile, and per-wake budget are declared in TOML files in `.bakudo/providers/`. Adding a new harness or adjusting a posture's behavior is a config change, not a code change, unless the harness requires a new MCP transport.

### 3.5 Single Binary, Single Workspace

All Bakudo code lives in one Cargo workspace with multiple crates. The CLI binary launches both the Supervisor and the TUI; there is no separate `bakudod`. Type-sharing with `abox-core` is achieved by a Cargo path or git dependency.

---

## 4. Workspace Layout and Crate Responsibilities

```text
bakudo/
├── Cargo.toml                  # workspace
├── rust-toolchain.toml         # pinned to abox's toolchain
├── clippy.toml
├── deny.toml
├── justfile
├── .bakudo/                    # per-repo runtime state (gitignored except providers/)
│   ├── providers/              # versioned provider configs
│   ├── lessons/                # versioned, human-editable distilled memory
│   ├── prompts/                # versioned system prompts
│   └── state.db                # SQLite (gitignored)
└── crates/
    ├── bakudo-core/            # pure domain types, no IO, no async
    ├── bakudo-mcp/             # MCP transport + tool schema
    ├── bakudo-providers/       # TOML loader + Deliberator process spawning
    ├── bakudo-supervisor/      # the always-on logic
    ├── bakudo-tui/             # ratatui front-end
    └── bakudo-cli/             # binary entrypoint, wires everything
```

| Crate | Responsibility | May depend on |
|---|---|---|
| `bakudo-core` | Domain types: `Mission`, `Experiment`, `Wallet`, `WakeEvent`, `Blackboard`, `Posture`. Pure data + small pure functions. No `tokio`, no `reqwest`, no SQLite. | `serde`, `chrono`, `thiserror`, `uuid` |
| `bakudo-mcp` | MCP tool schemas, request/response types, stdio transport, the middleware that gates `host_exec`. | `bakudo-core`, `serde_json`, `tokio`, `tracing` |
| `bakudo-providers` | Parses provider TOML, spawns Deliberator subprocesses, owns the per-provider system-prompt assembly. | `bakudo-core`, `bakudo-mcp`, `tokio`, `toml` |
| `bakudo-supervisor` | Fleet manager (abox jobs), wake scheduler, debouncer, wallet enforcement, SQLite store, MCP server hosting, event bus. | `bakudo-core`, `bakudo-mcp`, `bakudo-providers`, `abox-core`, `rusqlite`, `tokio`, `tracing` |
| `bakudo-tui` | `ratatui` shell. Subscribes to the Supervisor's event bus over an in-process MPSC channel. Owns no domain logic. | `bakudo-core`, `ratatui`, `crossterm`, `tokio` |
| `bakudo-cli` | Binary entrypoint. Subcommands: `bakudo` (default — launches Supervisor + TUI), `bakudo run "<goal>"` (one-shot Mission), `bakudo daemon` (Supervisor only, no TUI), `bakudo status`. | All of the above |

**Hex architecture invariant:** `bakudo-core` is a leaf. `bakudo-supervisor` depends on `bakudo-core` but never the other way. The implementation of any IO concern (SQLite, MCP, harness spawning) lives in an outer crate behind a trait defined in `bakudo-core` or `bakudo-supervisor`. This makes integration testing trivial: substitute an in-memory store and a mock harness.

---

## 5. Domain Model (`bakudo-core`)

The following types are normative. Field names, types, and serialization shapes should match exactly. All types derive `Serialize`, `Deserialize`, `Debug`, `Clone`. Use `serde(rename_all = "snake_case")` on enums.

```rust
//! crates/bakudo-core/src/lib.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

// ─── Identifiers ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MissionId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExperimentId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WakeId(pub Uuid);

// ─── Posture ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Posture {
    Mission,
    Explore,
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wallet {
    /// Total real-world time the Mission may still consume.
    pub wall_clock_remaining: Duration,
    /// Total number of abox workers the Mission may still spawn.
    pub abox_workers_remaining: u32,
    /// Currently running abox workers for this Mission.
    pub abox_workers_in_flight: u32,
    /// Soft cap on simultaneous abox workers (machine protection).
    pub concurrent_max: u32,
}

impl Wallet {
    pub fn can_dispatch(&self, n: u32) -> bool {
        n <= self.abox_workers_remaining
            && (self.abox_workers_in_flight + n) <= self.concurrent_max
            && !self.wall_clock_remaining.is_zero()
    }
}

// ─── Mission ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mission {
    pub id: MissionId,
    pub goal: String,
    pub posture: Posture,
    pub provider_name: String,    // matches a file in .bakudo/providers/
    pub abox_profile: String,     // matches an abox profile name
    pub wallet: Wallet,
    pub status: MissionStatus,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    Pending,           // created, not yet woken
    AwaitingDeliberator, // queued for next wake
    Deliberating,      // Deliberator process is running right now
    Sleeping,          // experiments are running, no Deliberator alive
    Completed,
    Cancelled,
    Failed,
}

// ─── Experiment ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experiment {
    pub id: ExperimentId,
    pub mission_id: MissionId,
    pub label: String,            // e.g. "indexed-scan", "test-suite"
    pub spec: ExperimentSpec,
    pub status: ExperimentStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub summary: Option<ExperimentSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentSpec {
    /// Branch or worktree the abox should base on (usually a generated label).
    pub base_branch: String,
    /// Shell script the abox runs. May be inline or a path the abox materialises.
    pub script: ExperimentScript,
    /// Optional skill the Deliberator wants this experiment to draw from.
    pub skill: Option<String>,
    /// Free-form hypothesis or verifier description, surfaced to the Deliberator
    /// in the result summary so it can reason about what was tried.
    pub hypothesis: String,
    /// Optional metric extraction pattern; when set, the Supervisor parses
    /// the named JSON keys out of stdout and attaches them to the summary.
    pub metric_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExperimentScript {
    Inline { source: String },
    File   { path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentSummary {
    pub exit_code: i32,
    pub duration: Duration,
    pub stdout_tail: String,      // last ~4 KiB
    pub stderr_tail: String,      // last ~4 KiB
    pub metrics: serde_json::Map<String, serde_json::Value>,
    pub patch_path: Option<String>, // path to the diff produced inside the abox
}

// ─── Wake events ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WakeEvent {
    pub id: WakeId,
    pub mission_id: MissionId,
    pub reason: WakeReason,
    pub created_at: DateTime<Utc>,
    pub payload: serde_json::Value, // shape depends on reason
    pub blackboard: Blackboard,
    pub wallet: Wallet,
    pub user_inbox: Vec<UserMessage>,
    pub recent_ledger: Vec<LedgerEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    pub at: DateTime<Utc>,
    pub text: String,
    pub urgent: bool,
}

// ─── Blackboard and Ledger ───────────────────────────────────────────────────

/// The Deliberator's externalised working memory. Stored as JSON in SQLite.
/// The Supervisor never interprets the inner shape; it only round-trips it.
/// Convention: the schema is whatever the system prompt says it is, but a
/// minimal recommended layout is captured in default-blackboard.json.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Blackboard(pub serde_json::Value);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub at: DateTime<Utc>,
    pub kind: LedgerKind,
    pub summary: String,
    pub mission_id: MissionId,
    pub experiment_id: Option<ExperimentId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerKind {
    Decision,
    ExperimentSummary,
    SkillUsed,
    UserSteering,
    Lesson,
}
```

### 5.1 Default Blackboard layout

The Supervisor never imposes a Blackboard schema, but the **default system prompt** instructs the Deliberator to maintain at least these keys. Implementers should ship a `crates/bakudo-core/data/default-blackboard.json`:

```json
{
  "version": 1,
  "objective": null,
  "done_contract": {
    "metrics": [],
    "constraints": [],
    "stop_conditions": []
  },
  "hypotheses": [],
  "active_experiments": [],
  "best_known": null,
  "things_tried": [],
  "next_steps": []
}
```

---

## 6. The MCP Tool Surface (`bakudo-mcp`)

Bakudo exposes exactly the following tools to the Deliberator over MCP stdio. All other tools (file IO, search) come from the harness itself. Tool names use `snake_case`. Every response includes a `meta` sidecar described in §6.10.

### 6.1 `dispatch_swarm`

The cornerstone primitive. Schedules N experiments, debits the wallet, returns immediately with job IDs and an instruction for the Deliberator to suspend.

```json
// request
{
  "experiments": [
    {
      "label": "indexed-scan",
      "hypothesis": "adding a btree index on users.email reduces query time",
      "skill": "perf/db-index",
      "base_branch": "main",
      "script": { "kind": "inline", "source": "..." },
      "metric_keys": ["query_ms_p50", "query_ms_p99"]
    }
  ],
  "concurrency_hint": 4
}

// response
{
  "experiment_ids": ["...", "..."],
  "suspended": true,
  "reason": "experiments_dispatched",
  "wake_when": "all_complete"   // or "first_complete" | "any_failure"
}
```

**Rules.** The Supervisor MUST reject the call if the requested batch would exceed `wallet.abox_workers_remaining` or `wallet.concurrent_max`. The error is returned with the meta sidecar so the Deliberator can re-plan. The Supervisor MUST persist the experiments and the dispatch event before returning.

### 6.2 `abox_exec`

Run a single ad-hoc command in an ephemeral abox. Used by the Deliberator for one-off probes (e.g., `cargo build`, `git log -10`). Synchronous, blocking.

```json
// request
{
  "script": { "kind": "inline", "source": "cargo build --release" },
  "abox_profile": "dev-broad",        // optional, defaults to mission's profile
  "timeout_secs": 120
}

// response
{
  "exit_code": 0,
  "duration_ms": 4731,
  "stdout_tail": "...",
  "stderr_tail": "..."
}
```

Counts against `abox_workers_remaining` (one worker).

### 6.3 `abox_apply_patch`

Apply a unified diff inside an abox-backed worktree, run a verification command, return the result. This is the preferred way for the Deliberator to make code changes during a Mission.

```json
// request
{
  "patch": "diff --git a/...",
  "verify": { "kind": "inline", "source": "cargo test" },
  "abox_profile": "dev-strict"
}

// response
{
  "applied": true,
  "verify": {
    "exit_code": 0,
    "duration_ms": 8124,
    "stdout_tail": "..."
  }
}
```

### 6.4 `host_exec`

Run a command on the host. **Always prompts the user via the TUI.** Reserved for things that genuinely cannot run inside an abox: `git push`, `gh pr create`, anything touching SSH keys you do not want injected.

```json
// request
{
  "command": "git push origin HEAD",
  "reason": "publishing the winning experiment as a PR"
}

// response (after user clicks Approve in the TUI)
{
  "approved": true,
  "exit_code": 0,
  "stdout_tail": "..."
}
```

If the user denies, the call returns `{ "approved": false }` and the Deliberator must not retry the same command without a new justification.

### 6.5 `update_blackboard`

JSON-merge-patch update of the Blackboard. The Deliberator should call this before suspending so that the next wake sees its current thinking.

```json
// request
{ "patch": { "best_known": { "label": "indexed-scan", "score": 412 } } }

// response
{ "applied": true }
```

### 6.6 `record_lesson`

Persist a distilled, repo-specific learning. Lessons are written as Markdown files in `.bakudo/lessons/` so they're versionable and human-editable.

```json
// request
{
  "title": "regex parsers always fail in this repo",
  "body": "Three experiments (e-7, e-12, e-19) confirmed that the custom AST is required; regex approaches lose precision on nested macros."
}

// response
{ "path": ".bakudo/lessons/2026-04-21-regex-parsers-fail.md" }
```

### 6.7 `ask_user`

Synchronously prompt the user. The Deliberator may call this once or twice during the contract-establishment phase but is heavily discouraged from a long intake form.

```json
// request
{ "question": "Should we measure p50 latency, build time, or both?", "choices": ["p50", "build", "both"] }

// response
{ "answer": "p50" }
```

The Supervisor surfaces this in the TUI; user selection is recorded into the Ledger.

### 6.8 `cancel_experiments`

Best-effort cancellation. The Supervisor signals each abox to terminate; partial summaries are still recorded.

```json
{ "experiment_ids": ["..."], "reason": "user steered away from this approach" }
```

### 6.9 `suspend`

The Deliberator's explicit signal that it has nothing more to do this wake and the Supervisor should tear down the harness process.

```json
// request
{ "reason": "experiments_dispatched", "expected_wake": "experiments_complete" }
// no response; the Supervisor closes stdio.
```

### 6.10 The `meta` sidecar

Every response from every tool includes a `meta` object so the Deliberator never has to poll:

```json
{
  "result": { /* tool-specific */ },
  "meta": {
    "wallet": { /* current Wallet snapshot */ },
    "fleet": {
      "active": 3,
      "queued": 1,
      "completed_this_mission": 12,
      "failed_this_mission": 2
    },
    "pending_user_messages": 1,
    "posture": "explore",
    "wake_id": "..."
  }
}
```

The middleware that injects `meta` is centralised in `bakudo-mcp::middleware::MetaInjector`.

---

## 7. Provider Configuration (`bakudo-providers`)

Providers are TOML files in `.bakudo/providers/`. The Supervisor loads them on startup and on SIGHUP. Each provider declares how to launch a Deliberator process and which posture/profile it implements.

### 7.1 Schema

```toml
# .bakudo/providers/<name>.toml

# Required identifiers
name      = "claude-explore"
engine    = "claude-code"     # one of: claude-code | codex | opencode | exec
posture   = "explore"         # one of: mission | explore

# Required execution
engine_args        = ["--model", "claude-sonnet-4-5", "--mcp", "stdio:bakudo-mcp"]
abox_profile       = "dev-broad"
system_prompt_file = "prompts/explore.md"

# Optional per-wake limits (in addition to mission-level wallet)
[wake_budget]
tool_calls  = 30
wall_clock  = "5m"

# Optional environment overrides for the Deliberator process
[env]
ANTHROPIC_API_KEY_ENV_VAR = "ANTHROPIC_API_KEY"   # name of host env var to forward

# Optional resume protocol overrides
[resume]
flag             = "--resume"          # how the engine resumes a session id
session_id_file  = ".bakudo/sessions/{mission_id}.id"
```

### 7.2 Engines

The implementer must support these engines in `bakudo-providers::engine`:

- `claude-code` — invokes `claude --print --output-format stream-json --resume <session_id> --mcp <transport>`. Reads the `WakeEvent` from stdin and treats it as the user message.
- `codex` — invokes `codex run --headless --mcp <transport> --resume <session_id>`. Same wire shape.
- `opencode` — invokes `opencode --mcp <transport> --resume <session_id>`.
- `exec` — escape hatch; runs an arbitrary command. Used for testing with a mock harness.

A new engine is added by implementing the `EngineAdapter` trait:

```rust
#[async_trait::async_trait]
pub trait EngineAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    async fn spawn(&self, cfg: &ProviderConfig, wake: &WakeEvent)
        -> anyhow::Result<DeliberatorHandle>;
}
```

`DeliberatorHandle` exposes `stdin`, `stdout`, `stderr`, an `is_alive()` probe, and a `kill()` method.

---

## 8. The Supervisor (`bakudo-supervisor`)

The Supervisor is a Tokio runtime hosting several long-lived actors that communicate over `tokio::sync::mpsc` channels. The actor topology is small and stable.

### 8.1 Actors

| Actor | Owns | Listens to | Emits |
|---|---|---|---|
| `MissionRegistry` | All missions, their wallets, their statuses | `RegistryCmd` from CLI/TUI | `MissionEvent` |
| `FleetManager` | All abox child processes, debouncing of completions | `FleetCmd` | `FleetEvent` |
| `WakeScheduler` | Pending `WakeEvent`s, deduplication, debounce window | `MissionEvent`, `FleetEvent`, `UserEvent`, `TickEvent` | `WakeReady` |
| `DeliberatorRunner` | The currently spawned Deliberator process (at most one per mission concurrently) | `WakeReady` | `DeliberatorEvent` |
| `McpServer` | The stdio MCP transport bound to the running Deliberator | tool calls from harness | `ToolCall` |
| `Store` | SQLite | `StoreCmd` | `StoreAck` |
| `EventBus` | A broadcast channel for the TUI to subscribe to | all `*Event`s | broadcasted snapshots |

Actor boundaries are enforced: an actor never holds another actor's state. They communicate only via messages.

### 8.2 Wake debouncing

When a `dispatch_swarm` of N=4 finishes, the Supervisor MUST coalesce all four `FleetEvent::ExperimentFinished` events into a single `WakeReady{ reason: ExperimentsComplete, payload: [...4 summaries...] }`. The debounce window is **1.5 seconds** by default and configurable per provider in `wake_budget.debounce`.

### 8.3 Wake gating

The Deliberator may indicate, via the `dispatch_swarm` request, when it wants to be woken: `all_complete` (default), `first_complete` (race), or `any_failure` (early-cancel siblings on first failure). The `WakeScheduler` honours this.

### 8.4 Wallet enforcement

The `MissionRegistry` is the sole authority on wallet state. Before the `McpServer` accepts a `dispatch_swarm` or `abox_exec` call it MUST check `Wallet::can_dispatch(n)`; if it fails, the call is rejected with a typed error and a `BudgetWarning` wake is queued.

A wall-clock timer is set per Mission; on expiry, all in-flight experiments are cancelled and a `WakeReason::Timeout` is emitted with partial results. The Deliberator's prompt mandates that on Timeout it must write a "what I'd do with more budget" Ledger entry before completing the Mission as `Failed` or `Cancelled`.

### 8.5 Crash recovery

On startup, the Supervisor loads all `MissionStatus::Sleeping` missions from SQLite. For each, it re-attaches to live abox jobs (the FleetManager keeps PIDs in the DB) or marks orphaned jobs as `Failed`. A synthetic `WakeReason::ManualResume` event is enqueued for any Mission whose state cannot be reconciled.

---

## 9. Storage Schema (SQLite)

A single file, `.bakudo/state.db`. Migrations live in `crates/bakudo-supervisor/migrations/` and are applied on startup with `refinery` or `sqlx::migrate!`.

```sql
-- 0001_initial.sql

CREATE TABLE missions (
  id              TEXT PRIMARY KEY,                 -- UUID
  goal            TEXT NOT NULL,
  posture         TEXT NOT NULL CHECK (posture IN ('mission','explore')),
  provider_name   TEXT NOT NULL,
  abox_profile    TEXT NOT NULL,
  wallet_json     TEXT NOT NULL,                    -- serialized Wallet
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT
);

CREATE TABLE experiments (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  label           TEXT NOT NULL,
  hypothesis      TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  status          TEXT NOT NULL,
  abox_pid        INTEGER,                          -- so we can re-attach after crash
  started_at      TEXT,
  finished_at     TEXT,
  summary_json    TEXT
);
CREATE INDEX experiments_mission ON experiments(mission_id);

CREATE TABLE wake_events (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  reason          TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  processed_at    TEXT
);

CREATE TABLE blackboards (
  mission_id      TEXT PRIMARY KEY REFERENCES missions(id),
  state_json      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  experiment_id   TEXT REFERENCES experiments(id),
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  at              TEXT NOT NULL
);
CREATE INDEX ledger_mission_at ON ledger(mission_id, at DESC);

CREATE TABLE user_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  text            TEXT NOT NULL,
  urgent          INTEGER NOT NULL DEFAULT 0,
  at              TEXT NOT NULL,
  delivered_at    TEXT
);
CREATE INDEX user_messages_undelivered ON user_messages(mission_id, delivered_at);
```

---

## 10. The Wake Protocol End-to-End

A Wake is an atomic unit of LLM activity. The full lifecycle:

1. **Trigger.** Any `WakeReason` is produced by an actor. Pushed to `WakeScheduler`.
2. **Debounce.** Scheduler waits up to the debounce window for additional triggers for the same Mission and coalesces them.
3. **Materialise.** Scheduler builds a complete `WakeEvent`: pulls the current Blackboard, Wallet, last K=5 LedgerEntries, and any undelivered UserMessages. Persists the event to `wake_events`.
4. **Dispatch.** Scheduler signals `DeliberatorRunner` for that Mission.
5. **Spawn.** `DeliberatorRunner` reads the provider config, spawns the harness with the resume flag and stdin set to the JSON-encoded `WakeEvent`. Marks the Mission `Deliberating`.
6. **Tool calls.** Harness reads stdin, calls Bakudo MCP tools. Each call passes through the `MetaInjector` middleware, which appends the `meta` sidecar.
7. **Suspend.** Harness calls `suspend`. `DeliberatorRunner` waits up to a configurable grace period (default 30s) for clean exit, then SIGTERM. Marks Mission `Sleeping` (or `Completed` if the suspend payload requests it).
8. **Mark delivered.** All `user_messages` included in the wake are stamped `delivered_at`. The `wake_events` row is stamped `processed_at`.
9. **Loop.** Control returns to the Scheduler. If new triggers are pending for this Mission, immediately schedule another wake (subject to a per-Mission rate limit, default 1 wake / 5 s for `SchedulerTick`-only sources).

A wake never recurses. A tool call cannot trigger another wake within the same wake — instead, it produces a `WakeReady` that the Scheduler picks up after the current wake closes.

---

## 11. Mission and Explore Postures

The two postures share all infrastructure; they differ only in the system prompt and the implicit gate on `dispatch_swarm` results. The Deliberator declares which posture it is operating in via a Blackboard field; the Supervisor uses this to pick the right system prompt at the next wake.

### 11.1 Mission

Trigger: a specific bounded ask. The Deliberator's system prompt instructs it to:

1. Optionally ask up to 2 clarifying questions via `ask_user`.
2. Write the change locally or via `abox_apply_patch`.
3. Fan out a verification swarm via `dispatch_swarm` containing at minimum: tests, lint+format, typecheck, and (if applicable) a targeted bench.
4. On all-pass: complete the Mission. On any-fail: either fix-and-retry, or transition to Explore on the failing dimension by setting `posture: explore` on the Blackboard and calling `dispatch_swarm` with hypothesis-shaped experiments.

### 11.2 Explore

Trigger: an open-ended ask, a Mission-to-Explore transition, or a `SchedulerTick` (always-on mode). The Deliberator's system prompt instructs it to:

1. Establish a Done Contract (target metric, baseline, stop conditions) on the Blackboard. May ask up to 2 clarifying questions.
2. Run a baseline measurement experiment to validate the metric script.
3. Dispatch hypothesis swarms in waves of size ≤ `concurrent_max`, choosing batch sizes that respect the wallet.
4. After each wave, update the Blackboard's `best_known` and `things_tried`, distil any persistent learnings via `record_lesson`, and decide whether to exploit (variations on the winner) or explore (genuinely new directions).
5. Stop when the contract's `stop_conditions` fire (default: 3 consecutive waves fail to improve `best_known.score` by ≥ X%) or the wallet is exhausted.

The implementer ships default prompts in `.bakudo/prompts/mission.md` and `.bakudo/prompts/explore.md`. See Appendix C.

---

## 12. The TUI (`bakudo-tui`)

Built with `ratatui` and `crossterm`, modelled on the Codex CLI's event-driven shape (event loop separate from rendering, non-blocking input always live).

### 12.1 Layout

```text
┌─ bakudo · my-repo · Mission "optimize db queries" [explore] ────────────┐
│ Wallet: 28m left · 9/12 abox workers remaining · 3 in flight            │
├─ Fleet ─────────────────────────────────────────────────────────────────┤
│ ▶ w-01 indexed-scan        2m12s    ✓ w-04 baseline-bench   38ms       │
│ ▶ w-02 prepared-statements 1m48s    ⏸ w-05 queued                      │
│ ✗ w-03 connection-pool     failed (cargo build error)                  │
├─ Transcript ────────────────────────────────────────────────────────────┤
│ 09:14 supervisor: dispatched 4 experiments under hypothesis batch H-2  │
│ 09:14 deliberator: synthesizing results from H-1 (winner: w-04, -38%)  │
│ 09:13 user: focus on the prepared-statements path                       │
├─ Steering ──────────────────────────────────────────────────────────────┤
│ > _                                                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

Three panes (Fleet, Transcript, Steering) plus a Header with Mission summary and Wallet. Panes are individually collapsible with `Ctrl-1/2/3`. Input bar is always live; commands are dispatched on `Enter`.

### 12.2 Slash commands

The Steering bar parses leading `/` as a command:

| Command | Effect |
|---|---|
| `/mission "<goal>"` | Start a new Mission posture |
| `/explore "<goal>"` | Start a new Explore posture |
| `/budget time=30m workers=20` | Adjust the active Mission's wallet |
| `/cancel <experiment_id>` | Best-effort cancel one experiment |
| `/cancel mission` | Cancel the active Mission |
| `/pause`, `/resume` | Toggle Mission-level pause |
| `/wake` | Force a `ManualResume` wake |
| `/lessons` | Open `.bakudo/lessons/` in `$EDITOR` |
| `/quit` | Tear down Supervisor, exit |

Anything not starting with `/` is treated as a `UserMessage` and appended to the inbox (urgent if the user prefixed with `!`).

### 12.3 Approval prompts

When the Deliberator calls `host_exec`, the TUI raises a modal:

```text
┌─ Approval required ────────────────────────────────────────┐
│ Deliberator wants to run on the host:                      │
│   git push origin HEAD                                     │
│ Reason: publishing the winning experiment as a PR          │
│                                                            │
│ [a]pprove   [d]eny   [e]dit                                │
└────────────────────────────────────────────────────────────┘
```

Approvals are recorded in the Ledger.

### 12.4 Event bus

The TUI subscribes to a `tokio::sync::broadcast` channel exposed by the Supervisor. Snapshots flow at most every 100 ms; the TUI keeps a ring buffer of the last 200 transcript entries.

---

## 13. System Prompts and Skills

### 13.1 Prompts

System prompts live in `.bakudo/prompts/` and are versioned. They are not embedded in the binary so users can iterate on them without recompiling. The Supervisor reads the `system_prompt_file` from the active provider TOML and prepends it to every `WakeEvent` it sends to the harness.

The prompts MUST teach the Deliberator: the Blackboard schema; the meta sidecar contract; the `suspend` discipline (one Mission step per wake — dispatch and suspend, do not stay alive polling); the wallet rules; and the posture-specific behaviour described in §11.

Recommended starter prompts are in Appendix C; treat them as starting points to be tuned with usage.

### 13.2 Skills

Skills are directories under `.bakudo/skills/` following the same shape as Claude Code's skill format with Bakudo-specific extensions:

```text
.bakudo/skills/perf/db-index/
  SKILL.md            # when to use; assumptions; guardrails
  propose.md          # prompt fragment for hypothesis generation
  measure.sh          # optional standardised measurement script
  experiment.md       # prompt fragment for sandbox plan
  postconditions.md   # invariants the result must satisfy
```

The Deliberator finds skills via a `search_skills(query)` tool exposed by `bakudo-mcp`. The Supervisor never *executes* skills; it just hands their contents to the Deliberator on demand. This keeps the host code generic.

### 13.3 Lessons

Lessons are Markdown files in `.bakudo/lessons/`. They are written by the Deliberator via `record_lesson` and are surfaced to it on each wake via the Ledger (via L4 promotion: a nightly background task summarises lessons referenced K times into the standing system-prompt addendum).

---

## 14. Security and Approval Model

The threat model assumes:

- The Deliberator is partially trusted (it is the user's chosen LLM, but the LLM may behave incorrectly).
- abox provides hardware-level isolation; anything inside an abox profile's allowlist is considered safe.
- The host filesystem outside `.bakudo/` is **not** writable by the Deliberator without explicit `host_exec` approval.

Enforcement:

1. **MCP middleware blocks unsafe host actions.** `bakudo-mcp::middleware::HostGuard` rejects any attempt to invoke a harness-native shell tool that is not on the `safe_on_host` allowlist. Allowlist defaults: `ls`, `cat`, `git status`, `git log`, `git diff`, `rg`, `find` (read-only flags only).
2. **abox profile selection per Mission.** The provider TOML names a profile; Mission creation can override. The profile defines what is permitted *inside* the sandbox.
3. **`host_exec` always prompts.** No "remember my answer" mode in v1. Every host execution is an explicit approval recorded in the Ledger.
4. **Credential injection** is owned by abox's TLS-proxy mechanism; Bakudo only selects which profile to run.
5. **No remote execution.** The Supervisor does not expose a network port. MCP is stdio-only. A future remote-control surface, if ever built, must require mTLS and a signed nonce.

---

## 15. Observability, Logging, Provenance

- **Logs.** `tracing` with `tracing-subscriber`, JSON to `.bakudo/logs/supervisor-{date}.log`, human-readable to TUI Transcript.
- **Provenance.** The Supervisor writes an append-only NDJSON file at `.bakudo/provenance/{mission_id}.ndjson` capturing every wake, every tool call, every approval, every experiment summary. Format is forward-compatible with v1 provenance for easy diffing.
- **Metrics.** Per-Mission summary at completion: total wakes, total abox workers, total wall-clock, total approvals, best metric, lessons recorded. Written to the Ledger as a single `LedgerKind::Decision` row.
- **Status command.** `bakudo status` prints active Missions, Wallet states, in-flight experiments, and recent failures.

---

## 16. Phased Implementation Plan

This plan is sized for approximately 8 working sessions for a single experienced Rust contributor. Each phase ends with explicit acceptance criteria and a green CI gate.

### Phase 0 — Repo bootstrap (½ day)

- Create the workspace skeleton, `rust-toolchain.toml` matching abox's, `clippy.toml`, `deny.toml`, `rustfmt.toml`, `justfile` with `check`, `test`, `lint`, `fmt`, `run`.
- Add GitHub Actions: `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo nextest run --workspace`, `cargo deny check`.
- Add pre-commit hooks (`fmt`, `clippy`, `cargo deny`).
- Acceptance: empty workspace builds; CI is green.

### Phase 1 — Domain types (`bakudo-core`) (1 day)

- Implement every type in §5.
- Add round-trip serde tests for each.
- Add a small property test (`proptest`) for `Wallet::can_dispatch`.
- Acceptance: `cargo test -p bakudo-core` is green; types are documented with rustdoc examples.

### Phase 2 — SQLite store (1 day)

- Implement migration `0001_initial.sql` and a typed wrapper `bakudo-supervisor::store::Store`.
- Provide CRUD for `missions`, `experiments`, `wake_events`, `blackboards`, `ledger`, `user_messages`.
- Provide a `MemoryStore` implementing the same trait for tests.
- Acceptance: integration test creates a Mission, dispatches an experiment, persists a summary, restarts the store, reloads everything intact.

### Phase 3 — MCP server and tool surface (`bakudo-mcp`) (2 days)

- Implement stdio MCP transport.
- Implement every tool in §6 with full request/response types and JSON schemas.
- Implement the `MetaInjector` middleware and the `HostGuard` middleware.
- Build a `mock_harness` binary that exercises every tool end-to-end.
- Acceptance: `mock_harness` connects, calls every tool once, exits cleanly. All tool schemas are exported to `crates/bakudo-mcp/schemas/` for harness-side reference.

### Phase 4 — Fleet manager and abox integration (1 day)

- Implement `FleetManager` actor that owns an `abox` job table and spawns abox via either:
  - **Preferred:** direct dependency on `abox-core` from a path or git ref.
  - **Fallback:** shelling out to `abox run --json`.
- Implement debounced completion events.
- Acceptance: launching 4 trivial experiments completes with one coalesced `FleetEvent::ExperimentsBatchComplete` in ≤ debounce + max(experiment_duration).

### Phase 5 — Provider system and Deliberator runner (`bakudo-providers`) (1 day)

- Parse provider TOML.
- Implement `EngineAdapter` trait and adapters for `claude-code`, `codex`, `exec` (mock).
- Implement `DeliberatorRunner` actor: receives `WakeReady`, spawns the engine, pipes the `WakeEvent` JSON to stdin, supervises stdout, tears down on `suspend`.
- Acceptance: with the `exec` adapter pointed at the `mock_harness`, a Mission can be created, woken, dispatch a swarm, suspend, be re-woken on completion, and complete. Use a frozen WakeEvent JSON fixture.

### Phase 6 — Wake scheduler and supervisor wiring (1 day)

- Implement `WakeScheduler`, `MissionRegistry`.
- Wire the actor topology in `bakudo-supervisor::supervisor::run()`.
- Wire wallet enforcement and crash recovery (§8.4–8.5).
- Acceptance: kill the Supervisor mid-Mission with `SIGKILL`, restart, verify the in-flight experiments are reconciled and the Mission resumes via `WakeReason::ManualResume`.

### Phase 7 — TUI (`bakudo-tui`) (1.5 days)

- Implement the layout in §12.
- Subscribe to the Supervisor's broadcast bus.
- Implement slash commands and the approval modal.
- Acceptance: with the `exec` mock harness running a synthetic Mission, the TUI updates Fleet entries live, accepts steering messages, and surfaces an approval prompt on `host_exec`.

### Phase 8 — Real harness E2E and v1 deletion (1 day)

- Wire the real `claude` engine adapter; run an end-to-end "optimise this loop" Mission against a small sample repo.
- Delete `src/` from the v1 TypeScript codebase.
- Update `README.md` to describe v2 only. Move `AGENTS.md` to v2 norms.
- Acceptance: a fresh checkout of the repo, with `bakudo` in `$PATH`, can run `bakudo` in a sample repo and complete a Mission against the user's preferred harness.

### Phase 9 — Polish and observability (½ day)

- Add `bakudo status`, provenance NDJSON, structured logging.
- Add `cargo dist`-style release pipeline producing static binaries for Linux x86_64 / aarch64 and macOS arm64.
- Acceptance: `cargo dist build` produces stripped binaries < 10 MB; `bakudo status` works against a running Supervisor.

### Total

Approximately 10 working days. Phases 1–6 are foundational and must be done in order. Phase 7 (TUI) can be parallelised with Phases 5–6 by another contributor. Phases 8–9 are sequential.

---

## 17. Migration from Bakudo v1

Bakudo v2 is **not backward compatible** at the code or session-state level. The following is the explicit migration policy:

| Artefact | Action |
|---|---|
| `src/` (TypeScript) | Deleted in Phase 8. |
| `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `eslint.config.js`, `node-shims.d.ts` | Deleted in Phase 8. |
| `plans/integration/meta-orchestrator/` | Archived into `docs/historical/v1-meta-orchestrator/`. Not loaded at runtime. |
| `plans/` (other) | Reviewed item by item. Useful design notes ported to `docs/`. |
| `.claude/skills/` | Migrated into `.bakudo/skills/` with the new directory shape (§13.2). Each skill is reviewed for current relevance before porting. |
| Provenance NDJSON format | New v2 records use the same line shape where possible so historical analysis tools keep working. |
| Active Bakudo v1 sessions | Drained (allowed to complete). No automated import into v2 SQLite. |

A single one-shot script `scripts/import-v1-skills.sh` is provided to do the skill migration; everything else is intentionally manual to force a re-evaluation.

---

## 18. Testing Strategy

| Level | Tooling | What it covers |
|---|---|---|
| Unit | `cargo test` per crate | Pure types in `bakudo-core`; tool-schema serde; SQL query correctness against `MemoryStore`; provider TOML parsing. |
| Property | `proptest` | Wallet arithmetic; debouncer correctness under random event ordering; JSON merge-patch behaviour for `update_blackboard`. |
| Integration | `cargo nextest` with `tempfile` | Spawn the Supervisor with the `exec` mock harness; run a scripted Mission; assert end-state in SQLite. |
| End-to-end | Shell scripts in `scripts/e2e/` | Real `claude` / `codex` against a checked-in toy repo. Manually triggered (CI-optional). |
| Crash | Kill-restart harness in integration tests | Verifies §8.5. |

Coverage target: 80% line coverage on `bakudo-core`, 70% on `bakudo-supervisor`. Lower targets on `bakudo-tui` (UI code is hard to unit-test; rely on snapshot tests of widget rendering using `ratatui::backend::TestBackend`).

---

## 19. Open Decisions Reserved for the Implementer

These are choices intentionally left unmade so the implementer can take them based on the realities discovered during Phase 0–2:

1. **`abox-core` dependency mode.** Vendored path, git pin, or a published `crates.io` release. Lean: git pin during early development; switch to crates.io once `abox-core` reaches 0.4.
2. **`rusqlite` vs `sqlx`.** Both work. `rusqlite` is simpler and synchronous (wrap in `tokio::task::spawn_blocking`); `sqlx` is async-native. Lean: `rusqlite` for v1 simplicity.
3. **MCP crate.** As of writing there are several MCP Rust implementations of varying maturity. The implementer should pick the most actively maintained one or, if none meets the bar, implement the small subset needed (stdio transport + tool registration) inline in `bakudo-mcp` — the surface is small.
4. **Per-Mission concurrency tuning.** Default `concurrent_max = 4` is a guess. Adjust after measuring memory pressure during real runs.
5. **Lesson promotion cadence.** The "L4 promotion" idea (see §13.3) is not strictly required for v1; ship without it and add later if the Ledger grows unwieldy.
6. **Multi-repo Supervisor.** The plan assumes one Supervisor per repository. A single user-level Supervisor handling multiple repos is interesting but out of scope for v1.

---

## 20. Appendix A — Example WakeEvent JSON

```json
{
  "id": "0192a1c0-7c5f-7f00-8c2c-8e0d4f5a1b2c",
  "mission_id": "0192a1be-2b3a-7f00-8c2c-9a0e1d3b4c5d",
  "reason": "experiments_complete",
  "created_at": "2026-04-21T13:14:22Z",
  "payload": {
    "experiments": [
      {
        "id": "0192a1bf-...",
        "label": "indexed-scan",
        "status": "succeeded",
        "summary": {
          "exit_code": 0,
          "duration_ms": 21340,
          "metrics": { "query_ms_p50": 412, "query_ms_p99": 901 },
          "patch_path": "/var/abox/jobs/.../patch.diff"
        }
      },
      { "id": "0192a1bf-...", "label": "prepared-statements", "status": "failed",
        "summary": { "exit_code": 101, "duration_ms": 12110, "stderr_tail": "thread 'main' panicked..." } }
    ]
  },
  "blackboard": {
    "version": 1,
    "objective": "reduce p50 query latency by ≥30%",
    "done_contract": {
      "metrics": [{"name": "query_ms_p50", "direction": "minimize", "baseline": 660, "target": 460}],
      "constraints": ["public DB API unchanged", "all tests pass"],
      "stop_conditions": ["3 waves with <5% improvement", "wallet exhausted"]
    },
    "hypotheses": ["btree index on email", "prepared statements", "connection pool resize"],
    "active_experiments": [],
    "best_known": { "label": "baseline", "score": 660 },
    "things_tried": [],
    "next_steps": ["dispatch wave H-2"]
  },
  "wallet": {
    "wall_clock_remaining": "PT28M",
    "abox_workers_remaining": 9,
    "abox_workers_in_flight": 0,
    "concurrent_max": 4
  },
  "user_inbox": [
    { "at": "2026-04-21T13:13:55Z", "text": "focus on the prepared-statements path", "urgent": false }
  ],
  "recent_ledger": [
    { "at": "2026-04-21T13:10:11Z", "kind": "decision",
      "summary": "established Done Contract; baseline p50=660ms",
      "mission_id": "0192a1be-..." }
  ]
}
```

---

## 21. Appendix B — Example Provider TOML files

`.bakudo/providers/claude-mission.toml`:

```toml
name      = "claude-mission"
engine    = "claude-code"
posture   = "mission"

engine_args        = ["--model", "claude-sonnet-4-5", "--print",
                      "--output-format", "stream-json",
                      "--mcp", "stdio:bakudo-mcp"]
abox_profile       = "dev-strict"
system_prompt_file = "prompts/mission.md"

[wake_budget]
tool_calls = 60
wall_clock = "10m"
debounce   = "1.5s"

[resume]
flag            = "--resume"
session_id_file = ".bakudo/sessions/{mission_id}.id"
```

`.bakudo/providers/claude-explore.toml`:

```toml
name      = "claude-explore"
engine    = "claude-code"
posture   = "explore"

engine_args        = ["--model", "claude-sonnet-4-5", "--print",
                      "--output-format", "stream-json",
                      "--mcp", "stdio:bakudo-mcp"]
abox_profile       = "dev-broad"
system_prompt_file = "prompts/explore.md"

[wake_budget]
tool_calls = 30
wall_clock = "5m"
debounce   = "1.5s"

[resume]
flag            = "--resume"
session_id_file = ".bakudo/sessions/{mission_id}.id"
```

`.bakudo/providers/codex-mission.toml`:

```toml
name      = "codex-mission"
engine    = "codex"
posture   = "mission"

engine_args        = ["run", "--headless",
                      "--mcp", "stdio:bakudo-mcp"]
abox_profile       = "dev-strict"
system_prompt_file = "prompts/mission.md"

[wake_budget]
tool_calls = 60
wall_clock = "10m"
```

---

## 22. Appendix C — Default System Prompts

These are starter prompts. Tune with usage.

### `.bakudo/prompts/mission.md`

```markdown
You are the Bakudo Deliberator operating in MISSION posture.

Each time you wake, you will receive a WakeEvent JSON describing the
trigger, the Blackboard, the Wallet, and any user messages.

Your responsibilities, in order:

1. Read the WakeEvent in full. If `reason` is `user_message`, treat the
   most recent user_inbox entry as your immediate instruction.
2. Maintain the Blackboard via the `update_blackboard` tool. The
   recommended schema is described in the system addendum below.
3. Make code changes via `abox_apply_patch` (preferred) or, for very
   small probes, `abox_exec`. Do not use any harness-native shell tool
   for code execution; the host will reject it.
4. Verify changes by calling `dispatch_swarm` with a homogeneous batch
   of verifiers (tests, lint, typecheck, targeted bench). On
   all-success, mark the Mission complete in your final action by
   updating Blackboard status to "completed". On any failure, either
   fix-and-retry, or transition to EXPLORE posture by setting
   `posture: "explore"` on the Blackboard and dispatching a hypothesis
   batch on the failing dimension.
5. Respect the Wallet. Reject any plan that would exceed
   `abox_workers_remaining` or `wall_clock_remaining`. The meta sidecar
   on every tool response gives you the current wallet snapshot.
6. **One Mission step per wake.** When you have dispatched work or
   asked the user something, call `suspend` and exit. Do not stay alive
   waiting for results — the Supervisor will wake you when they arrive.
7. If `reason` is `budget_exhausted` or `timeout`, write a Ledger entry
   describing what you would have tried with more budget, then mark
   the Mission completed or failed.

When in doubt, prefer fewer, larger experiments over many small ones,
and prefer transitioning to EXPLORE over flailing in MISSION.
```

### `.bakudo/prompts/explore.md`

```markdown
You are the Bakudo Deliberator operating in EXPLORE posture.

Your job is to iteratively improve a measurable objective using
parallel `dispatch_swarm` experiments under a strict Wallet.

Each wake:

1. Read the WakeEvent. The Blackboard's `done_contract` defines what
   "improvement" means.
2. If the Blackboard has no `done_contract`, your first task is to
   establish one. You may call `ask_user` at most twice for
   clarification. Then write a measurement script (or pick one from a
   skill) and run it once via `abox_exec` to record a baseline.
3. Generate hypotheses. Use `search_skills` to find relevant
   recipes. Aim for 3–5 distinct directions per wave. Record each in
   the Blackboard's `hypotheses` and `things_tried` arrays.
4. Dispatch a wave via `dispatch_swarm`. Do not exceed the Wallet.
   Prefer a wave size that uses ≤ `concurrent_max` workers and ≤ 50%
   of `abox_workers_remaining`.
5. Call `suspend`. The Supervisor will wake you when the wave
   completes (or partially, depending on the `wake_when` you set).
6. On wake, read the experiment summaries. Update `best_known` if any
   beat it. If a clear winner emerges, decide whether to **exploit**
   (variations on the winner) or **explore** (genuinely new direction).
   Distil persistent learnings via `record_lesson`.
7. Stop when the Blackboard's `stop_conditions` fire or the Wallet
   is exhausted. Write a final Ledger entry summarising what was tried
   and what the best known result is.

Always update the Blackboard before suspending so your future self can
pick up the thread.
```

---

## 23. Glossary

- **abox.** The microVM-backed sandboxing tool that Bakudo dispatches work into. Owned by a separate repository.
- **Blackboard.** The Deliberator's externalised working memory; a JSON document stored per Mission.
- **Deliberator.** The ephemeral LLM-harness process spawned by Bakudo to do reasoning.
- **Done Contract.** The agreed-on success criteria for an Explore Mission, captured on the Blackboard.
- **Ledger.** Append-only summaries of decisions, experiment outcomes, and lessons.
- **Lesson.** A distilled, persistent learning written to `.bakudo/lessons/` as Markdown.
- **Mission.** A user-initiated unit of work, of a specific posture.
- **MCP.** The Model Context Protocol; how the harness talks to Bakudo.
- **Posture.** Either `mission` (depth-first verification) or `explore` (breadth-first hypothesis testing).
- **Provider.** A TOML config selecting an engine, an abox profile, and a posture.
- **Skill.** A reusable, Markdown-based recipe directory the Deliberator can pull in to guide hypothesis generation, measurement, or experiment shape.
- **Supervisor.** The persistent Rust daemon that owns state and the abox fleet.
- **Wake.** One bounded unit of LLM activity, triggered by a `WakeReason`.
- **Wallet.** The two-meter budget (wall-clock + abox workers) enforced per Mission.
