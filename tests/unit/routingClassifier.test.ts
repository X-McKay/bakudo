/**
 * Unit tests for RoutingClassifier.
 *
 * Since `classifyGoal` now delegates to a `MacroOrchestrationSession`, all
 * tests use a `MockMacroSession` that returns a pre-configured classification
 * without spawning a real process. This keeps tests fast, deterministic, and
 * isolated from the LLM.
 *
 * The tests verify:
 * 1. `classifyGoal` correctly returns whatever the session reports.
 * 2. `classifyGoal` defaults to "complex" when the session throws.
 * 3. `classifyGoal` defaults to "complex" when the session returns an
 *    unrecognised classification value.
 * 4. The `hasActiveObjective` flag and `text` are forwarded to the session.
 * 5. The task type sent to the session is always "classify".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyGoal,
  type GoalComplexity,
} from "../../src/host/orchestration/routingClassifier.js";
import type { MacroOrchestrationSession } from "../../src/host/orchestration/macroOrchestrationSession.js";
import type { MacroTask } from "../../src/host/orchestration/macroOrchestrationSession.js";

// ---------------------------------------------------------------------------
// Mock session factory
// ---------------------------------------------------------------------------

type LastCall = { task: string; payload: Record<string, unknown> };

/**
 * Create a mock `MacroOrchestrationSession` that resolves `send()` with a
 * pre-configured result. Captures the last call for assertion.
 */
const makeMockSession = (
  classification: string,
  shouldThrow = false,
): { session: MacroOrchestrationSession; lastCall: () => LastCall | undefined } => {
  let lastCall: LastCall | undefined;

  const session = {
    start() {},
    dispose() {},
    async send<T>(task: MacroTask): Promise<T> {
      lastCall = {
        task: task.task,
        payload: task.payload as Record<string, unknown>,
      };
      if (shouldThrow) {
        throw new Error("mock session error");
      }
      return { classification } as T;
    },
  } as unknown as MacroOrchestrationSession;

  return { session, lastCall: () => lastCall };
};

// ---------------------------------------------------------------------------
// Basic routing — session result is honoured
// ---------------------------------------------------------------------------

test("classifyGoal: returns 'simple' when session reports simple", async () => {
  const { session } = makeMockSession("simple");
  assert.equal(await classifyGoal("what is the current branch?", false, session), "simple");
});

test("classifyGoal: returns 'complex' when session reports complex", async () => {
  const { session } = makeMockSession("complex");
  assert.equal(await classifyGoal("refactor the entire session store", false, session), "complex");
});

test("classifyGoal: returns 'status_query' when session reports status_query", async () => {
  const { session } = makeMockSession("status_query");
  assert.equal(await classifyGoal("how are things going?", true, session), "status_query");
});

test("classifyGoal: returns 'steering_command' when session reports steering_command", async () => {
  const { session } = makeMockSession("steering_command");
  assert.equal(await classifyGoal("skip campaign 2", true, session), "steering_command");
});

// ---------------------------------------------------------------------------
// Error handling — safe defaults
// ---------------------------------------------------------------------------

test("classifyGoal: defaults to 'complex' when session throws", async () => {
  const { session } = makeMockSession("simple", true /* shouldThrow */);
  assert.equal(await classifyGoal("do something", false, session), "complex");
});

test("classifyGoal: defaults to 'complex' when session returns unrecognised value", async () => {
  const { session } = makeMockSession("unknown_category");
  assert.equal(await classifyGoal("do something", false, session), "complex");
});

test("classifyGoal: defaults to 'complex' when session returns empty string", async () => {
  const { session } = makeMockSession("");
  assert.equal(await classifyGoal("do something", false, session), "complex");
});

// ---------------------------------------------------------------------------
// Payload forwarding — session receives correct inputs
// ---------------------------------------------------------------------------

test("classifyGoal: forwards text to session payload", async () => {
  const { session, lastCall } = makeMockSession("simple");
  await classifyGoal("explain the reducer", false, session);
  assert.equal(lastCall()?.payload["text"], "explain the reducer");
});

test("classifyGoal: forwards hasActiveObjective=true to session payload", async () => {
  const { session, lastCall } = makeMockSession("steering_command");
  await classifyGoal("abort", true, session);
  assert.equal(lastCall()?.payload["hasActiveObjective"], true);
});

test("classifyGoal: forwards hasActiveObjective=false to session payload", async () => {
  const { session, lastCall } = makeMockSession("simple");
  await classifyGoal("explain the reducer", false, session);
  assert.equal(lastCall()?.payload["hasActiveObjective"], false);
});

test("classifyGoal: sends task type 'classify' to session", async () => {
  const { session, lastCall } = makeMockSession("simple");
  await classifyGoal("explain the reducer", false, session);
  assert.equal(lastCall()?.task, "classify");
});

// ---------------------------------------------------------------------------
// All four valid categories are accepted
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: GoalComplexity[] = [
  "simple",
  "complex",
  "status_query",
  "steering_command",
];

for (const category of VALID_CATEGORIES) {
  test(`classifyGoal: accepts '${category}' as a valid classification`, async () => {
    const { session } = makeMockSession(category);
    const result = await classifyGoal("some input", false, session);
    assert.equal(result, category);
  });
}
