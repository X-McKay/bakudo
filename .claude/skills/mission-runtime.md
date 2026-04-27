# Skill: Mission Runtime in Bakudo

## Trigger

When asked to modify the wake-based mission runtime, mission MCP tools,
Mission State persistence, provider wake execution, or host approval flow.

## Scope

The mission runtime lives primarily in:

- `crates/bakudo-daemon/src/session_controller.rs`
- `crates/bakudo-daemon/src/mission_store.rs`
- `crates/bakudo-daemon/src/provider_runtime.rs`
- `crates/bakudo-core/src/mission.rs`
- `tests/runtime.rs`
- `docs/current-architecture.md`

## Key Invariants

1. The host layer stays in place, but it is a thin router rather than a staged
   planner. Freeform user input is routed through the host/session path first
   so the runtime can answer status locally, start a clear objective
   immediately, or persist steering as a `UserMessage`.

2. The deliberator is stateless across wakes. Durable state belongs in the
   supervisor side:
   - `MissionStore` persists `Mission`, `Experiment`, `WakeEvent`,
     `MissionState`, `UserMessage`, active waves, and ledger entries.
   - `mission_plan.md` lives under the repo-scoped data root.
   - Wake and attempt traces live under `<repo-data>/traces/`.
   - Append-only provenance is written to
     `.bakudo/provenance/<mission-id>.ndjson`.

3. The mission tool surface is fixed unless the product contract changes:
   `read_plan`, `update_plan`, `notify_user`, `ask_user`,
   `complete_mission`, `read_experiment_summary`, `dispatch_swarm`,
   `abox_exec`, `host_exec`, `cancel_experiments`,
   `update_mission_state`, `record_lesson`, and `suspend`. Repo mutations
   are produced by `dispatch_swarm` workers and merged by the host's
   candidate-policy path; the conductor has no patch-apply tool.

   `dispatch_swarm` experiment items stay typed: use top-level
   `{"kind":"script","script":...}` for script workers and
   `{"kind":"agent_task","prompt":"..."}` for provider-backed workers.
   Do not wrap those fields inside a nested `workload` object and do not
   JSON-encode experiment objects as strings.

   Script workers default to `sandbox_lifecycle = "ephemeral"` and
   `candidate_policy = "discard"`. If later mission steps must see the
   resulting repo changes on `main`, either use an agent worker or explicitly
   set `sandbox_lifecycle = "preserved"` plus
   `candidate_policy = "auto_apply"` on the script experiment.

   `abox_exec` is for short verification probes inside the sandbox: pass a
   plain shell string for `script`, not a tagged script object.

4. `MissionState` remains the compact durable execution state, but
   `mission_plan.md` is the conductor-facing planning artifact. Do not
   reintroduce older state aliases or migration paths.

5. Provider wake execution comes from `ProviderCatalog` and
   `.bakudo/providers/*.toml` plus `.bakudo/prompts/*.md`, not the classic
   `ProviderRegistry` path.

   The wake bootstrap prompt is passed as the provider's prompt argument. It
   includes the shipped mission prompt plus the current `WakeEvent` JSON.
   Mission tools are exposed through a wake-local HTTP MCP server, not a
   custom stdio JSON-RPC loop.

6. `wake_budget`, `concurrency_hint`, and active-wave refill behavior are part
   of the runtime contract. Per-wake limits and restart-safe wave scheduling
   must be enforced by the supervisor, not left to prompts.

7. Worker outputs remain host-owned after execution. Agent workers can produce
   preserved worktrees, but merge/apply/discard decisions still happen on the
   host side.

   Mission deliberators and mission-native agent workers now default to the
   provider's low-friction execution mode when the provider config enables it.
   A dispatched worker can still opt out by setting `allow_all_tools = false`.

## Process

1. Read the current mission flow in `docs/current-architecture.md`.
2. Inspect the affected mission runtime files before editing.
3. Preserve existing wake semantics, wallet enforcement, and host approvals.
4. Add or update coverage in `tests/runtime.rs` for any runtime behavior change.
5. Run:
   ```bash
   cargo test --workspace
   cargo clippy --workspace --all-targets -- -D warnings
   ```
