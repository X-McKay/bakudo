import assert from "node:assert/strict";
import test from "node:test";

import { buildApplyDispatchPlan } from "../../src/host/applyDispatch.js";

test("buildApplyDispatchPlan: apply_verify uses shell in an ephemeral abox dispatch", () => {
  const plan = buildApplyDispatchPlan({
    kind: "apply_verify",
    sessionId: "session-1",
    turnId: "turn-1",
    attemptId: "attempt-apply-verify",
    taskId: "attempt-apply-verify",
    intentId: "intent-verify",
    workspaceRoot: "/tmp/apply-workspace",
    prompt: "run verification",
    instructions: ["Run the staged verification command."],
    command: ["bash", "-lc", "npm test"],
  });

  assert.equal(plan.profile.sandboxLifecycle, "ephemeral");
  assert.equal(plan.profile.candidatePolicy, "discard");
  assert.equal(plan.spec.taskKind, "apply_verify");
  assert.equal(plan.spec.execution.engine, "shell");
  assert.deepEqual(plan.spec.execution.command, ["bash", "-lc", "npm test"]);
  assert.equal(plan.spec.cwd, "/tmp/apply-workspace");
});

test("buildApplyDispatchPlan: apply_resolve uses agent_cli in an ephemeral abox dispatch", () => {
  const plan = buildApplyDispatchPlan({
    kind: "apply_resolve",
    sessionId: "session-1",
    turnId: "turn-1",
    attemptId: "attempt-apply-resolve",
    taskId: "attempt-apply-resolve",
    intentId: "intent-resolve",
    workspaceRoot: "/tmp/apply-workspace",
    prompt: "resolve the staged apply conflict",
    instructions: ["Resolve the conflict and explain the change."],
  });

  assert.equal(plan.profile.sandboxLifecycle, "ephemeral");
  assert.equal(plan.profile.candidatePolicy, "discard");
  assert.equal(plan.spec.taskKind, "apply_resolve");
  assert.equal(plan.spec.execution.engine, "agent_cli");
  assert.equal(plan.spec.permissions.noAskUser, true);
});
