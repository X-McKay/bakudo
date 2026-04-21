/**
 * Wave 2: Chaos Monkey Evaluator unit tests.
 *
 * Tests the chaosMonkeyRunner, the isChaosMonkeyLgtm helper, and the
 * headlessExecute adversarial loop with a mock ABoxTaskRunner.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAOS_MONKEY_PROMPT,
  isChaosMonkeyLgtm,
  runChaosMonkey,
} from "../../src/worker/chaosMonkeyRunner.js";
import { headlessExecute } from "../../src/host/orchestration/headlessExecute.js";
import type { DispatchPlan, AttemptSpec } from "../../src/attemptProtocol.js";
import type { ABoxTaskRunner, TaskExecutionRecord } from "../../src/aboxTaskRunner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseSpec = (): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "implement divide(a, b) function",
  instructions: [],
  cwd: "/tmp",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 120, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
});

const basePlan = (): DispatchPlan => ({
  schemaVersion: 1,
  candidateId: "attempt-1",
  profile: {
    providerId: "codex",
    sandboxLifecycle: "preserved",
    candidatePolicy: "discard",
  },
  spec: baseSpec(),
});

const makeRecord = (stdout: string, ok = true): TaskExecutionRecord => ({
  events: [],
  ok,
  rawOutput: stdout,
  workerErrors: [],
  result: {
    schemaVersion: 1 as const,
    taskId: "task-1",
    sessionId: "session-1",
    status: ok ? "succeeded" : "failed",
    summary: ok ? "done" : "failed",
    exitCode: ok ? 0 : 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    exitSignal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    assumeDangerousSkipPermissions: false,
    command: "codex exec",
    cwd: "/workspace",
    shell: "/bin/sh",
    timeoutSeconds: 120,
  },
});

// ---------------------------------------------------------------------------
// chaosMonkeyRunner: runChaosMonkey
// ---------------------------------------------------------------------------

test("chaosMonkeyRunner: returns chaos-monkey provider command", () => {
  const spec = baseSpec();
  const result = runChaosMonkey(spec);
  assert.equal(result.command[0], "claude");
  assert.ok(result.command.includes("--print-responses"));
});

test("chaosMonkeyRunner: injects adversarial prompt via stdin", () => {
  const spec = baseSpec();
  const result = runChaosMonkey(spec);
  assert.ok(result.stdin?.includes("Chaos Monkey"), "stdin should contain adversarial prompt");
  assert.ok(result.stdin?.includes("LGTM"), "stdin should mention LGTM contract");
});

test("chaosMonkeyRunner: sets BAKUDO_CHAOS_MONKEY env var", () => {
  const spec = baseSpec();
  const result = runChaosMonkey(spec);
  assert.equal(result.env?.BAKUDO_CHAOS_MONKEY, "1");
});

test("chaosMonkeyRunner: sets BAKUDO_GUEST_OUTPUT_DIR env var", () => {
  const spec = baseSpec();
  const result = runChaosMonkey(spec);
  assert.ok(
    result.env?.BAKUDO_GUEST_OUTPUT_DIR?.includes("attempt-1"),
    "BAKUDO_GUEST_OUTPUT_DIR should reference the attempt ID",
  );
});

test("chaosMonkeyRunner: CHAOS_MONKEY_PROMPT is non-empty", () => {
  assert.ok(CHAOS_MONKEY_PROMPT.length > 0);
  assert.ok(CHAOS_MONKEY_PROMPT.includes("git diff"), "prompt should instruct git diff review");
  assert.ok(CHAOS_MONKEY_PROMPT.includes("LGTM"), "prompt should define LGTM contract");
});

// ---------------------------------------------------------------------------
// isChaosMonkeyLgtm
// ---------------------------------------------------------------------------

test("isChaosMonkeyLgtm: returns true for exact LGTM", () => {
  assert.equal(isChaosMonkeyLgtm("LGTM"), true);
});

test("isChaosMonkeyLgtm: returns true for LGTM with surrounding text", () => {
  assert.equal(isChaosMonkeyLgtm("After careful review: LGTM\n"), true);
});

test("isChaosMonkeyLgtm: returns false for lowercase lgtm", () => {
  assert.equal(isChaosMonkeyLgtm("lgtm"), false);
});

test("isChaosMonkeyLgtm: returns false for flaw report", () => {
  assert.equal(
    isChaosMonkeyLgtm("Found a divide-by-zero flaw:\n```ts\ntest('divide by zero', () => {\n```"),
    false,
  );
});

test("isChaosMonkeyLgtm: returns false for empty string", () => {
  assert.equal(isChaosMonkeyLgtm(""), false);
});

// ---------------------------------------------------------------------------
// headlessExecute: adversarial loop
// ---------------------------------------------------------------------------

test("headlessExecute: returns success when Chaos Monkey outputs LGTM on first attempt", async () => {
  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => {
      callCount++;
      // First call = Worker (succeeds), second call = Chaos Monkey (LGTM)
      return makeRecord(callCount === 1 ? "function divide(a, b) { return a / b; }" : "LGTM");
    },
  } as unknown as ABoxTaskRunner;

  const result = await headlessExecute(basePlan(), mockRunner);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 1);
  assert.equal(callCount, 2); // Worker + Chaos Monkey
});

test("headlessExecute: retries when Chaos Monkey finds a flaw", async () => {
  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => {
      callCount++;
      // Attempt 1: Worker ok, Monkey finds flaw
      // Attempt 2: Worker ok, Monkey LGTM
      if (callCount === 1) return makeRecord("initial implementation");
      if (callCount === 2) return makeRecord("Found flaw: divide by zero");
      if (callCount === 3) return makeRecord("fixed implementation");
      return makeRecord("LGTM");
    },
  } as unknown as ABoxTaskRunner;

  const result = await headlessExecute(basePlan(), mockRunner);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.equal(callCount, 4); // 2x (Worker + Chaos Monkey)
});

test("headlessExecute: injects flaw report into next plan instructions", async () => {
  const capturedSpecs: AttemptSpec[] = [];
  let callCount = 0;
  const mockRunner = {
    runAttempt: async (spec: AttemptSpec) => {
      capturedSpecs.push(spec);
      callCount++;
      if (callCount === 1) return makeRecord("initial implementation");
      if (callCount === 2) return makeRecord("Found flaw: missing null check");
      if (callCount === 3) return makeRecord("fixed implementation");
      return makeRecord("LGTM");
    },
  } as unknown as ABoxTaskRunner;

  await headlessExecute(basePlan(), mockRunner);
  // The second Worker call (index 2) should have the flaw report in instructions
  const secondWorkerSpec = capturedSpecs[2];
  assert.ok(secondWorkerSpec !== undefined);
  assert.ok(
    secondWorkerSpec.instructions.some((i) => i.includes("Chaos Monkey found a flaw")),
    "second Worker call should include flaw report in instructions",
  );
});

test("headlessExecute: returns failure when Worker fails", async () => {
  const mockRunner = {
    runAttempt: async () => makeRecord("compilation error", false),
  } as unknown as ABoxTaskRunner;

  const result = await headlessExecute(basePlan(), mockRunner);
  assert.equal(result.success, false);
  assert.equal(result.attempts, 1);
});

test("headlessExecute: exhausts retries and returns failure", async () => {
  const mockRunner = {
    runAttempt: async () => makeRecord("Found flaw: always fails"),
  } as unknown as ABoxTaskRunner;

  const result = await headlessExecute(basePlan(), mockRunner, { maxAttempts: 2 });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 2);
});

test("headlessExecute: respects maxAttempts option", async () => {
  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => {
      callCount++;
      return makeRecord("Found flaw: always fails");
    },
  } as unknown as ABoxTaskRunner;

  await headlessExecute(basePlan(), mockRunner, { maxAttempts: 1 });
  // With maxAttempts=1: 1 Worker + 1 Chaos Monkey = 2 calls
  assert.equal(callCount, 2);
});

test("headlessExecute: transcript includes worker and monkey output", async () => {
  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => {
      callCount++;
      return makeRecord(callCount === 1 ? "worker output here" : "LGTM");
    },
  } as unknown as ABoxTaskRunner;

  const result = await headlessExecute(basePlan(), mockRunner);
  assert.ok(result.transcript.includes("worker output here"), "transcript should include worker output");
  assert.ok(result.transcript.includes("LGTM"), "transcript should include monkey output");
});

test("headlessExecute: never mutates the original plan", async () => {
  const plan = basePlan();
  const originalInstructionsLength = plan.spec.instructions.length;
  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => {
      callCount++;
      if (callCount === 1) return makeRecord("initial");
      if (callCount === 2) return makeRecord("Found flaw: test");
      if (callCount === 3) return makeRecord("fixed");
      return makeRecord("LGTM");
    },
  } as unknown as ABoxTaskRunner;

  await headlessExecute(plan, mockRunner);
  // The original plan should not have been mutated
  assert.equal(plan.spec.instructions.length, originalInstructionsLength);
});
