# Wave 1: Data Model (DispatchPlan & ExecutionProfile)

**Goal:** Introduce the new host-owned `DispatchPlan` and `ExecutionProfile` types, and update the planner and session records to use them.

**Non-Goals:** Do not change how the worker is executed yet. The `aboxAdapter` and `executeAttempt` pipeline will still run the legacy way; they will just receive the new data shapes.

## Pre-reads & Vocabulary
- Review `2026-04-19-bakudo-abox-control-plane-spec.md` (Section: The Host-Owned Dispatch Plan).
- **DispatchPlan:** The host's full intent for an attempt (includes the worker spec, execution profile, and candidate ID).
- **ExecutionProfile:** Determines whether the sandbox is preserved or ephemeral, what backend runs it, and how it is merged.

## Dependencies
- **Requires:** Wave 0 (Correctness Floor).
- **Blocks:** Wave 2 (Worker Backend), Wave 3 (Orchestration).

## Files to Modify

1. `src/attemptProtocol.ts`
   - **Reason:** Define `ExecutionProfile` and `DispatchPlan` schemas and types.
2. `src/sessionTypes.ts`
   - **Reason:** Update `SessionAttemptRecord` to store the full `DispatchPlan` instead of just the `AttemptSpec`.
3. `src/host/planner.ts`
   - **Reason:** Make `planAttempt` return a `DispatchPlan` instead of just `{ intent, spec }`.
4. `src/host/sessionController.ts`
   - **Reason:** Update the caller of `planAttempt` to handle the new return type and persist it.
5. `src/host/executeAttempt.ts`
   - **Reason:** Update the pipeline entrypoint to accept `DispatchPlan` (but still just pass `plan.spec` to the legacy runner for now).
6. `src/host/inspectTabs.ts`
   - **Reason:** Update the provenance tab to read from `attempt.dispatchPlan.spec` instead of `attempt.attemptSpec`.

## Step-by-Step Implementation

### 1. Define the Types (`src/attemptProtocol.ts`)

Add the new types and Zod schemas below the `AttemptSpec` definitions.

```typescript
// src/attemptProtocol.ts

export type ExecutionProfile = {
  /**
   * The backend engine to use for the assistant job.
   * e.g., "codex exec --dangerously-bypass-approvals-and-sandbox"
   */
  agentBackend: string;
  /**
   * Whether the abox sandbox should be preserved as a git worktree after the run.
   */
  sandboxLifecycle: "preserved" | "ephemeral";
  /**
   * How the host should handle the resulting worktree.
   * "auto" = merge immediately if checks pass.
   * "interactive" = keep preserved, wait for user to accept/discard.
   * "none" = discard after harvesting artifacts (for read-only tasks).
   */
  mergeStrategy: "auto" | "interactive" | "none";
};

export type DispatchPlan = {
  schemaVersion: 1;
  /**
   * Unique ID for this specific candidate execution.
   * In v1 this is 1:1 with attemptId, but in future batching it represents one of N.
   */
  candidateId: string;
  /**
   * The execution policy for this plan.
   */
  profile: ExecutionProfile;
  /**
   * The worker-facing task specification.
   */
  spec: AttemptSpec;
};

// Zod schemas
export const ExecutionProfileSchema = z.object({
  agentBackend: z.string(),
  sandboxLifecycle: z.enum(["preserved", "ephemeral"]),
  mergeStrategy: z.enum(["auto", "interactive", "none"]),
}).strip();

export const DispatchPlanSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: z.string(),
  profile: ExecutionProfileSchema,
  spec: AttemptSpecSchema,
}).strip();
```

### 2. Update Session Records (`src/sessionTypes.ts`)

Replace `attemptSpec?: AttemptSpec` with `dispatchPlan?: DispatchPlan` in the `SessionAttemptRecord`.

```typescript
// src/sessionTypes.ts
export type SessionAttemptRecord = {
  attemptId: string;
  status: AttemptStatus;
  
  // Replace this:
  // attemptSpec?: AttemptSpec;
  
  // With this:
  dispatchPlan?: DispatchPlan;
  
  // ... rest of the record
};
```

*Note: Update the Zod schema `SessionAttemptRecordSchema` to match.*

### 3. Update the Planner (`src/host/planner.ts`)

Modify `planAttempt` to construct and return the `DispatchPlan`.

```typescript
// src/host/planner.ts
export type PlannerResult = {
  intent: TurnIntent;
  plan: DispatchPlan;
};

export const planAttempt = async (
  prompt: string,
  composerMode: ComposerMode,
  context: PlannerContext,
  options?: { tokenBudget?: number; retryReason?: string },
): Promise<PlannerResult> => {
  const intent = await buildTurnIntent(prompt, composerMode, context, options);
  const spec = await compileAttemptSpec(intent, context);
  
  // Build the execution profile based on the intent kind
  const isReadOnly = intent.kind === "inspect_repository" || intent.kind === "run_check";
  const isAuto = composerMode === "autopilot" || composerMode === "plan";
  
  const profile: ExecutionProfile = {
    agentBackend: "codex exec --dangerously-bypass-approvals-and-sandbox",
    sandboxLifecycle: isReadOnly ? "ephemeral" : "preserved",
    mergeStrategy: isReadOnly ? "none" : (isAuto ? "auto" : "interactive"),
  };

  const plan: DispatchPlan = {
    schemaVersion: 1,
    candidateId: spec.attemptId, // 1:1 for now
    profile,
    spec,
  };

  return { intent, plan };
};
```

### 4. Update the Callers

Update `src/host/sessionController.ts` to expect `plan` instead of `spec`:

```typescript
// src/host/sessionController.ts
// Inside createAndRunFirstTurn and appendTurnToActiveSession:
const { intent, plan } = await planAttempt(prompt, mode, context);
// ...
const attemptRecord: SessionAttemptRecord = {
  attemptId: plan.spec.attemptId,
  status: "running",
  dispatchPlan: plan, // was attemptSpec: spec
};
// ...
const executionResult = await executeAttempt(ctx, plan);
```

Update `src/host/executeAttempt.ts` to accept `DispatchPlan`:

```typescript
// src/host/executeAttempt.ts
export const executeAttempt = async (
  ctx: ExecuteAttemptContext,
  plan: DispatchPlan,
): Promise<AttemptExecutionResult> => {
  const spec = plan.spec; // Extract spec for legacy pipeline
  // ... rest of the file continues using `spec`
}
```

Update `src/host/inspectTabs.ts` to read from the new location:

```typescript
// src/host/inspectTabs.ts (in Provenance tab formatter)
const spec = attempt.dispatchPlan?.spec;
if (!spec) return; // instead of attempt.attemptSpec
```

## Test Strategy
- **Unit:** Update `sessionTypes.test.ts` and `planner.test.ts` to assert on the new `DispatchPlan` shape.
- **Golden:** Golden tests will fail because the JSON shape of the attempt record changed in the artifacts. Regenerate the fixtures by running `UPDATE_GOLDENS=1 pnpm test`.

## Acceptance Criteria
- `pnpm test:unit` passes.
- The `.bakudo/sessions/<id>/events.ndjson` file contains `dispatchPlan` objects instead of `attemptSpec` objects.

## Rollback
If data corruption occurs, revert the schema changes and restore `attemptSpec` to the `SessionAttemptRecord`.
