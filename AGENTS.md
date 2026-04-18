# bakudo Agent Conventions

## State Mutation Rules

All state mutations in the host runtime MUST use functional updaters:

```ts
// Always:
dispatch({ type: "set_mode", mode: "plan" });
// or for direct state:
deps.appState = reduceHost(deps.appState, action);
```

```ts
// Never:
deps.appState.composer.mode = "plan";
deps.appState = { ...deps.appState, status: "running" };
```

Rationale: concurrent-safe, replayable, testable. See Phase 2 spec
(2026-04-15 second-pass, Functional State Updates).

### Audit checklist

When modifying `src/host/**`:

1. Every `deps.appState = ...` assignment MUST use `reduceHost(deps.appState, action)`.
2. Never assign to a nested property of `appState` directly.
3. `deps.transcript.push(...)` is allowed — transcript is an append-only mutable log.
4. The reducer (`src/host/reducer.ts`) MUST remain a pure function: no side effects, always returns a new object via spread.

## Phase 3 Dispatch Pipeline

User prompts flow through: `intentClassifier` -> `attemptCompiler` -> `executeAttempt` -> `reviewAttemptResult`.

- **Intent classifier** (`src/host/intentClassifier.ts`): deterministic, no LLM. Four kinds: `implement_change`, `inspect_repository`, `run_check`, `run_explicit_command`.
- **Attempt compiler** (`src/host/attemptCompiler.ts`): produces `AttemptSpec` (schema v3) with permissions, budget, acceptance checks.
- **Planner** (`src/host/planner.ts`): single entry point `planAttempt(prompt, mode, context)`.
- **Executor** (`src/host/executeAttempt.ts`): dispatches to abox, persists `attemptSpec` on `SessionAttemptRecord`.
- **Reviewer** (`src/reviewer.ts`): `reviewAttemptResult` uses structured `checkResults` for accept/reject.

Legacy path (`createTaskSpec` -> `executeTask`) is deprecated (Phase 6 removal). `WorkerTaskSpec` is deprecated in favor of `AttemptSpec`.

### Permission invariant

Deny always wins. Even in autopilot mode, a `deny` rule overrides any `allow`. See `evaluatePermission` in `src/host/permissionEvaluator.ts`.

## Phase 4 Host Surfaces

Phase 4 adds four user-visible host-owned surfaces, all durable:

1. **Approvals** (`src/host/approvalProducer.ts`, `src/host/dialogLauncher.ts`): every
   approval — interactive, hook-sourced, or deny-rule short-circuit — writes an
   `ApprovalRecord` to `<storage>/<session>/approvals.ndjson` plus
   `host.approval_requested` + `host.approval_resolved` envelopes. `allow always`
   appends a `PermissionRule` to `<repo>/.bakudo/approvals.jsonl` that survives
   across sessions. The interactive prompt uses promise-based launchers via
   `launchApprovalDialog` — see the A4.1 brief.
2. **Provenance** (`src/host/provenance.ts`, `src/host/provenanceProducer.ts`):
   every dispatch writes a `ProvenanceRecord` to `<storage>/<session>/provenance.ndjson`
   with agent profile, attempt spec, dispatch command, env allowlist, and exit
   details. The `/inspect provenance` tab surfaces it.
3. **Retry lineage** (`src/host/transitionStore.ts`, `src/sessionTypes.ts`):
   attempts and turns link through `TurnTransition` entries so
   `/inspect summary` and `/timeline` render the complete retry chain.
4. **Follow-up actions** (`src/host/followUpActions.ts`): the reviewer's
   `accept|retry|ask_user|halt|follow_up` recommendation is explicitly host-owned;
   `/retry` and `/halt` give the user the final say.

Rule of thumb: if a fact needs to survive past the current process, it lives in a
record under `<storage>/<session>/` (per-session) or under `<repo>/.bakudo/`
(workspace-durable). Raw log parsing is never the fallback.
