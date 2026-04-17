import assert from "node:assert/strict";
import test from "node:test";

import type { CompilerContext } from "../../src/host/attemptCompiler.js";
import { planAttempt } from "../../src/host/planner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext = (): CompilerContext => ({
  sessionId: "sess-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  repoRoot: "/repo",
  config: {},
});

// ---------------------------------------------------------------------------
// planAttempt
// ---------------------------------------------------------------------------

test("planAttempt returns both intent and spec", () => {
  const { intent, spec } = planAttempt("add a button", "standard", baseContext());
  assert.ok(intent);
  assert.ok(spec);
  assert.equal(typeof intent.intentId, "string");
  assert.equal(typeof spec.schemaVersion, "number");
});

test("planAttempt: intent.intentId === spec.intentId", () => {
  const { intent, spec } = planAttempt("fix bug", "standard", baseContext());
  assert.equal(intent.intentId, spec.intentId);
});

test("planAttempt: round-trip inspect_repository (plan mode)", () => {
  const { intent, spec } = planAttempt("explain the code", "plan", baseContext());
  assert.equal(intent.kind, "inspect_repository");
  assert.equal(spec.taskKind, "assistant_job");
  assert.equal(spec.mode, "plan");
});

test("planAttempt: round-trip implement_change (standard mode)", () => {
  const { intent, spec } = planAttempt("add logging", "standard", baseContext());
  assert.equal(intent.kind, "implement_change");
  assert.equal(spec.taskKind, "assistant_job");
  assert.equal(spec.mode, "build");
});

test("planAttempt: round-trip run_check", () => {
  const { intent, spec } = planAttempt("run tests", "standard", baseContext());
  assert.equal(intent.kind, "run_check");
  assert.equal(spec.taskKind, "verification_check");
  assert.equal(spec.execution.engine, "shell");
});

test("planAttempt: round-trip run_explicit_command", () => {
  const { intent, spec } = planAttempt("echo hello", "standard", baseContext(), {
    isExplicitCommand: true,
  });
  assert.equal(intent.kind, "run_explicit_command");
  assert.equal(spec.taskKind, "explicit_command");
  assert.equal(spec.execution.engine, "shell");
  assert.deepEqual(spec.execution.command, ["bash", "-lc", "echo hello"]);
});

test("planAttempt: tokenBudget forwarded through intent to spec", () => {
  const { intent, spec } = planAttempt("fix it", "standard", baseContext(), {
    tokenBudget: 40000,
  });
  assert.equal(intent.tokenBudget, 40000);
  assert.equal(spec.budget.tokenBudget, 40000);
});
