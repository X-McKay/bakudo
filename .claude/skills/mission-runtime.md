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

1. The restored conversational host layer stays in place. Freeform user input
   is routed through the host/session path before the mission runtime decides
   whether to answer locally, persist a `UserMessage`, or wake the deliberator.

2. The deliberator is stateless across wakes. Durable state belongs in the
   supervisor side:
   - `MissionStore` persists `Mission`, `Experiment`, `WakeEvent`,
     `MissionState`, `UserMessage`, active waves, and ledger entries.
   - Wake snapshots are written under the repo-scoped data root.
   - Append-only provenance is written to
     `.bakudo/provenance/<mission-id>.ndjson`.

3. The mission tool surface is fixed unless the product contract changes:
   `dispatch_swarm`, `abox_exec`, `abox_apply_patch`, `host_exec`,
   `update_mission_state`, `record_lesson`, `ask_user`,
   `cancel_experiments`, and `suspend`.
   Every tool response carries the `meta` sidecar.

4. Use `Mission State` terminology everywhere in current runtime code, docs,
   prompts, comments, and tests. Do not reintroduce `blackboard` aliases or
   migration paths.

5. Provider wake execution comes from `ProviderCatalog` and
   `.bakudo/providers/*.toml` plus `.bakudo/prompts/*.md`, not the classic
   `ProviderRegistry` path.

6. `wake_budget` is part of the runtime contract. Per-wake wall-clock and
   tool-call limits must be enforced by the supervisor, not left to prompts.

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
