# Wave 2: Worker Backend (codex exec & Reserved Output)

**Goal:** Shift `assistant_job` from the hardcoded `claude --print` runner to a dynamic runner that reads `profile.agentBackend`, executes the agent, and points it to a reserved guest output directory for artifacts.

**Non-Goals:** Do not change how the host persists artifacts or discovers the worktree yet. This wave only changes what the *worker* executes inside the sandbox.

## Pre-reads & Vocabulary
- Review `2026-04-19-bakudo-abox-control-plane-spec.md` (Section: Q2 & The `assistant_job` Runner).
- **Reserved Output Directory:** The guest directory where the backend agent should write its patch, changed files, and merge result. The host will later (in Wave 4) harvest this directory.

## Dependencies
- **Requires:** Wave 1 (Data Model). The runner needs access to `profile.agentBackend`.
- **Blocks:** None directly, but strongly recommended before Wave 4 (Review Decoupling).

## Files to Modify

1. `src/worker/taskKinds.ts`
   - **Reason:** Update `TaskRunner` signature to accept `ExecutionProfile` alongside `AttemptSpec`.
2. `src/worker/assistantJobRunner.ts`
   - **Reason:** Rewrite to use `profile.agentBackend` and set the `BAKUDO_GUEST_OUTPUT_DIR` environment variable.
3. `src/workerRuntime.ts`
   - **Reason:** Pass `profile` down to `dispatchTaskKind` when resolving the command.

## Step-by-Step Implementation

### 1. Update Task Runner Signature (`src/worker/taskKinds.ts`)

Modify `TaskRunner` to accept the profile.

```typescript
// src/worker/taskKinds.ts
import type { AttemptSpec, ExecutionProfile } from "../attemptProtocol.js";

export type TaskRunner = (spec: AttemptSpec, profile: ExecutionProfile) => TaskRunnerCommand;

export const dispatchTaskKind = (
  spec: AttemptSpec,
  profile: ExecutionProfile,
): TaskRunnerCommand => {
  const runner = taskRunners[spec.taskKind];
  return runner(spec, profile);
};
```

### 2. Rewrite `assistantJobRunner.ts`

Replace the hardcoded `claude --print` logic with a parser that splits `profile.agentBackend` into a command and arguments.

```typescript
// src/worker/assistantJobRunner.ts
import type { AttemptSpec, ExecutionProfile } from "../attemptProtocol.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * `assistant_job` runner.
 *
 * Executes the backend specified in `profile.agentBackend` (e.g.,
 * "codex exec --dangerously-bypass-approvals-and-sandbox").
 * The bounded prompt is passed via stdin.
 */
export const runAssistantJob = (
  spec: AttemptSpec,
  profile: ExecutionProfile,
): TaskRunnerCommand => {
  // 1. Parse the backend string into executable + args
  const parts = profile.agentBackend.split(" ").filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error("Invalid agentBackend: empty string");
  }
  const [executable, ...baseArgs] = parts;
  
  // 2. Define the reserved guest output directory for artifacts
  const guestOutputDir = "/tmp/bakudo-artifacts";
  
  // 3. Build the bounded prompt
  const boundedPrompt = [spec.prompt, ...spec.instructions].join("\n\n");
  
  // 4. Return the command with the required environment variable
  return {
    command: [executable, ...baseArgs],
    stdin: boundedPrompt,
    env: {
      BAKUDO_GUEST_OUTPUT_DIR: guestOutputDir,
    },
  };
};
```

*Note: Update `checkRunner.ts` and `commandRunner.ts` to accept the new signature, even if they ignore the `profile` parameter.*

### 3. Thread the Profile in `workerRuntime.ts`

Modify `resolveCommand` to extract the profile from the incoming spec wrapper. The worker protocol needs to be updated to pass the `DispatchPlan` (or at least the profile) alongside the spec.

```typescript
// src/workerRuntime.ts

// Update WorkerTaskSpec to include the profile (or just use DispatchPlan directly if you've fully replaced the worker protocol)
export type WorkerTaskSpec = {
  // ... existing fields ...
  attemptSpec?: AttemptSpec;
  executionProfile?: ExecutionProfile;
};

// In resolveCommand:
const resolveCommand = (spec: WorkerTaskSpec, shell: string): ResolvedCommand => {
  const raw = spec as Record<string, unknown>;
  if (typeof raw.taskKind === "string") {
    const as = (isObject(raw.attemptSpec) ? raw.attemptSpec : raw) as AttemptSpec;
    
    // Fallback profile if the host hasn't been updated yet
    const defaultProfile: ExecutionProfile = {
      agentBackend: "codex exec --dangerously-bypass-approvals-and-sandbox",
      sandboxLifecycle: "ephemeral",
      mergeStrategy: "none",
    };
    
    const profile = (isObject(raw.executionProfile) ? raw.executionProfile : defaultProfile) as ExecutionProfile;
    
    const cmd = dispatchTaskKind(as, profile);
    const [exe = shell, ...args] = cmd.command;
    return {
      spawnArgs: [exe, args],
      goalLabel: cmd.command.join(" "),
      // ...
    };
  }
  // ...
};
```

*Important: You must also update `src/host/aboxAdapter.ts` or `executeAttempt.ts` to encode the `executionProfile` into the worker payload when calling `runInStreamLive`.*

## Test Strategy
- **Unit:** Write a new test for `assistantJobRunner.test.ts` verifying that `profile.agentBackend` is correctly parsed into `command` arrays and that `BAKUDO_GUEST_OUTPUT_DIR` is set in the `env` field.
- **Integration:** None required for this wave, as the worker changes are internal to the guest.

## Acceptance Criteria
- `pnpm test:unit` passes.
- `assistantJobRunner` no longer contains the string `"claude"`.

## Rollback
Revert `assistantJobRunner.ts` to hardcode `claude --print` and remove the `ExecutionProfile` parameter from `TaskRunner`.
