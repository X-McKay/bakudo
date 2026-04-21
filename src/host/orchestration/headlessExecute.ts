/**
 * Wave 2: Headless Execution Boundary
 *
 * Implements the `headlessExecute` function — the entry point for all
 * background / daemon-mode execution. This is intentionally separate from
 * the interactive `executeAttempt` path so the existing `SessionController`
 * and interactive CLI remain untouched (see the Headless Execution Boundary
 * constraint in `00-execution-overview.md`).
 *
 * The adversarial loop:
 *   1. Run the Worker agent on the current plan.
 *   2. If the Worker fails, return immediately (no retry).
 *   3. Run the Chaos Monkey in the same preserved sandbox.
 *   4. If the Chaos Monkey outputs "LGTM", the loop is done — success.
 *   5. Otherwise, inject the Chaos Monkey's flaw report into the plan's
 *      instructions and retry from step 1.
 *   6. After `maxAttempts` retries, give up and return failure.
 *
 * Immutability invariant: the `DispatchPlan` is NEVER mutated in place.
 * Each retry constructs a fresh plan object via object spread.
 *
 * Git Mutex: background agents that write to the repo MUST acquire the
 * `gitWriteMutex` (introduced in Wave 3). This file reserves the import
 * slot; the mutex is wired in Wave 3.
 */
import type { DispatchPlan } from "../../attemptProtocol.js";
import type { ABoxTaskRunner, TaskExecutionRecord } from "../../aboxTaskRunner.js";
import { isChaosMonkeyLgtm, runChaosMonkey } from "../../worker/chaosMonkeyRunner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HeadlessExecuteResult = {
  /** Whether the final Worker pass was considered successful. */
  success: boolean;
  /**
   * Human-readable transcript of the execution (Worker output + Chaos Monkey
   * output for each attempt).
   */
  transcript: string;
  /**
   * The git diff produced by the final successful Worker pass, or an empty
   * string if the run failed.
   */
  diff: string;
  /** Number of Worker/Chaos-Monkey loop iterations performed. */
  attempts: number;
};

export type HeadlessRunnerOptions = {
  /** Maximum number of Worker + Chaos Monkey loop iterations. Default: 3. */
  maxAttempts?: number;
  /**
   * Optional shell override forwarded to the runner (e.g. `/bin/bash`).
   * Defaults to the runner's own default.
   */
  shell?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a single Worker pass via the provided {@link ABoxTaskRunner}.
 * Returns the raw execution record so the caller can inspect `ok` and
 * extract the stdout transcript.
 */
const runHeadlessWorker = async (
  plan: DispatchPlan,
  runner: ABoxTaskRunner,
  options: HeadlessRunnerOptions,
): Promise<TaskExecutionRecord> => {
  return runner.runAttempt(
    plan.spec,
    {
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      timeoutSeconds: plan.spec.budget.timeoutSeconds,
      maxOutputBytes: plan.spec.budget.maxOutputBytes,
      heartbeatIntervalMs: plan.spec.budget.heartbeatIntervalMs,
    },
    {},
    plan.profile,
  );
};

/**
 * Run the Chaos Monkey adversarial evaluator via the provided
 * {@link ABoxTaskRunner}. The Chaos Monkey uses the same preserved sandbox
 * as the Worker so it sees the exact file state the Worker left behind.
 *
 * The Chaos Monkey spec is derived from the Worker spec but with:
 * - `taskKind` set to `"assistant_job"` (the monkey is an LLM agent)
 * - `execution.engine` set to `"agent_cli"`
 * - A chaos-monkey `providerId` in the profile
 */
const runAdversarialEval = async (
  plan: DispatchPlan,
  runner: ABoxTaskRunner,
  options: HeadlessRunnerOptions,
): Promise<TaskExecutionRecord> => {
  // Build the Chaos Monkey command to get the adversarial prompt.
  const monkeyCommand = runChaosMonkey(plan.spec);

  // Construct a chaos-monkey spec derived from the worker spec.
  const monkeySpec = {
    ...plan.spec,
    taskKind: "assistant_job" as const,
    execution: { engine: "agent_cli" as const },
    prompt: monkeyCommand.stdin ?? "",
    instructions: [],
  };

  // The Chaos Monkey runs in the same preserved sandbox as the Worker.
  const monkeyProfile = {
    providerId: "chaos-monkey",
    sandboxLifecycle: "preserved" as const,
    candidatePolicy: "discard" as const,
  };

  return runner.runAttempt(
    monkeySpec,
    {
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      timeoutSeconds: plan.spec.budget.timeoutSeconds,
      maxOutputBytes: plan.spec.budget.maxOutputBytes,
      heartbeatIntervalMs: plan.spec.budget.heartbeatIntervalMs,
    },
    {},
    monkeyProfile,
  );
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Execute a {@link DispatchPlan} through the adversarial Worker → Chaos Monkey
 * loop without touching the interactive session store or the `SessionController`.
 *
 * This is the Headless Execution Boundary entry point (Wave 2). It will be
 * extended in Wave 3 to acquire the `gitWriteMutex` before any write-capable
 * pass.
 *
 * @param initialPlan  The plan to execute. Never mutated.
 * @param runner       The {@link ABoxTaskRunner} to use for dispatch.
 * @param options      Optional overrides (maxAttempts, shell).
 */
export const headlessExecute = async (
  initialPlan: DispatchPlan,
  runner: ABoxTaskRunner,
  options: HeadlessRunnerOptions = {},
): Promise<HeadlessExecuteResult> => {
  const maxAttempts = options.maxAttempts ?? 3;
  let currentPlan = initialPlan;
  let transcriptParts: string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // -----------------------------------------------------------------------
    // Step 1: Run the Worker
    // -----------------------------------------------------------------------
    const workerRecord = await runHeadlessWorker(currentPlan, runner, options);
    const workerOutput = workerRecord.result.stdout + workerRecord.result.stderr;
    transcriptParts.push(`[attempt ${attempt + 1}] worker:\n${workerOutput}`);

    if (!workerRecord.ok) {
      // Worker failed its own build/tests — no point running the Chaos Monkey.
      return {
        success: false,
        transcript: transcriptParts.join("\n\n"),
        diff: "",
        attempts: attempt + 1,
      };
    }

    // -----------------------------------------------------------------------
    // Step 2: Run the Chaos Monkey in the same preserved sandbox
    // -----------------------------------------------------------------------
    const monkeyRecord = await runAdversarialEval(currentPlan, runner, options);
    const monkeyOutput = monkeyRecord.result.stdout + monkeyRecord.result.stderr;
    transcriptParts.push(`[attempt ${attempt + 1}] chaos-monkey:\n${monkeyOutput}`);

    // -----------------------------------------------------------------------
    // Step 3: Evaluate Monkey output
    // -----------------------------------------------------------------------
    if (isChaosMonkeyLgtm(monkeyOutput)) {
      // Chaos Monkey found no flaws — the implementation is clean.
      return {
        success: true,
        transcript: transcriptParts.join("\n\n"),
        diff: workerRecord.result.stdout, // best-effort diff proxy
        attempts: attempt + 1,
      };
    }

    // -----------------------------------------------------------------------
    // Step 4: Monkey found a flaw. Rebuild the plan immutably for the retry.
    // -----------------------------------------------------------------------
    if (attempt < maxAttempts - 1) {
      currentPlan = {
        ...currentPlan,
        spec: {
          ...currentPlan.spec,
          instructions: [
            ...currentPlan.spec.instructions,
            `The Chaos Monkey found a flaw and wrote a failing test:\n${monkeyOutput}\nFix the code so the test passes.`,
          ],
        },
      };
    }
  }

  // Exhausted all retries without a clean Chaos Monkey pass.
  return {
    success: false,
    transcript: transcriptParts.join("\n\n"),
    diff: "",
    attempts: maxAttempts,
  };
};
