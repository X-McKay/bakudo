# Wave 2: Chaos Monkey Evaluator

**Goal:** Implement the adversarial testing loop. Modify the execution pipeline so that when a Worker agent finishes successfully, a "Chaos Monkey" agent is spawned in the exact same sandbox to try and break the Worker's implementation.

**Non-Goals:** Do not build the Daemon or the long-running Objective model yet. This wave focuses entirely on making `executeAttempt` a multi-step adversarial loop instead of a single shot.

## Rationale
Currently, `bakudo` evaluates success by running `npm test` or asking an LLM "does this look right?". The Chaos Monkey takes this further: it actively tries to write *new* failing tests or exploit edge cases. By running it inside the same `abox` microVM, we guarantee it has access to the exact code state the Worker just produced, but it operates with a strictly adversarial prompt.

## Dependencies
- **Requires:** Wave 1 (Provider Registry) — so we can easily declare the Chaos Monkey as a specific provider type.
- **Blocks:** Wave 3 (Daemon Gateway).

## Files to Modify

1. `src/host/providerRegistry.ts`
   - **Reason:** Register the Chaos Monkey provider with its specific system prompt and required policies.
2. `src/host/executeAttempt.ts`
   - **Reason:** Refactor the linear execution flow into a `while` loop (Worker -> Chaos Monkey -> Worker) up to a max retry limit.
3. `src/worker/chaosMonkeyRunner.ts` (New File)
   - **Reason:** Implement the specific runner logic that injects the adversarial prompt.

## Step-by-Step Implementation

### 1. Register the Chaos Monkey
In `src/host/providerRegistry.ts`:

```typescript
providerRegistry.register({
  id: "chaos-monkey",
  name: "Adversarial Evaluator",
  command: ["claude", "--print-responses"], // Can be any capable LLM
  requiredPolicies: ["anthropic-api"],
});
```

### 2. Create the Chaos Monkey Runner
Create `src/worker/chaosMonkeyRunner.ts`:

```typescript
import { reservedGuestOutputDirForAttempt } from "../attemptPath.js";
import type { AttemptSpec } from "../attemptProtocol.js";
import { providerRegistry } from "../host/providerRegistry.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

const CHAOS_PROMPT = `
You are the Chaos Monkey. Your job is to break the code that was just written.
Review the recent git diff. Find edge cases, security flaws, or missing logic.
Write a failing test case that proves the flaw. 
If you cannot find any flaws, output exactly: "LGTM".
Do NOT fix the code. Only write tests that fail.
`;

export const runChaosMonkey = (
  spec: AttemptSpec,
): TaskRunnerCommand => {
  const provider = providerRegistry.get("chaos-monkey");
  const guestOutputDir = reservedGuestOutputDirForAttempt(spec.attemptId);

  return {
    command: provider.command,
    stdin: CHAOS_PROMPT,
    env: {
      BAKUDO_GUEST_OUTPUT_DIR: guestOutputDir,
    },
  };
};
```

### 3. Implement the Adversarial Loop
We will NOT mutate the existing `executeAttempt` signature, as it is deeply tied to the interactive CLI. Instead, we introduce the concept of the `headlessExecute` loop (which will be fully formalized as the Daemon's entry point in Wave 3). For now, implement the loop as a new internal function in `src/host/orchestration/headlessExecute.ts` that orchestrates the Worker and Chaos Monkey sequentially.

Crucially, when the Chaos Monkey breaks the code, we MUST NOT mutate the `DispatchPlan` in place. We construct a fresh, immutable plan for the retry.

```typescript
import { runChaosMonkey } from "../../worker/chaosMonkeyRunner.js";
// ... import existing runner primitives

export const headlessExecute = async (
  initialPlan: DispatchPlan,
  repoPath?: string,
): Promise<{ success: boolean, transcript: string, diff: string }> => {
  let attempts = 0;
  const maxAttempts = 3;
  let currentPlan = initialPlan;

  while (attempts < maxAttempts) {
    // 1. Run the Worker (using the existing runner logic, bypassing interactive session store)
    const workerResult = await runHeadlessWorker(currentPlan, repoPath);
    if (!workerResult.success) {
      return workerResult; // Worker failed its own build/tests
    }

    // 2. Run the Chaos Monkey in the same preserved sandbox
    const monkeyResult = await runAdversarialEval(currentPlan, repoPath);
    
    // 3. Evaluate Monkey output
    if (monkeyResult.output.includes("LGTM")) {
      return { success: true, transcript: workerResult.transcript, diff: workerResult.diff };
    }

    // 4. Monkey broke it. Rebuild the plan immutably for the next loop.
    currentPlan = {
      ...currentPlan,
      spec: {
        ...currentPlan.spec,
        instructions: [
          ...currentPlan.spec.instructions,
          `The Chaos Monkey found a flaw and wrote a failing test:\n${monkeyResult.output}\nFix the code so the test passes.`
        ]
      }
    };
    attempts++;
  }

  return { success: false, transcript: "...", diff: "..." }; // Exhausted retries
};
```

## Testing
- **Local LLM Test:** Run `executeAttempt` with a simple task (e.g., "Write a function that divides two numbers"). The Chaos Monkey should immediately point out the divide-by-zero edge case and force the Worker to fix it before `executeAttempt` returns.

## Cleanup
- Ensure the old single-shot `executeAttempt` logic is fully replaced by the loop.

## Acceptance Criteria
- A successful Worker attempt is automatically followed by a Chaos Monkey attempt in the same sandbox.
- If the Chaos Monkey writes a failing test, the Worker is re-prompted to fix it.
- The loop terminates when the Chaos Monkey outputs "LGTM" or `maxAttempts` is reached.
