import test from "node:test";
import assert from "node:assert/strict";

import { classifyReviewedOutcome } from "../../src/resultClassifier.js";
import { reviewTaskResult } from "../../src/reviewer.js";

const baseResult = {
  schemaVersion: 1,
  taskId: "task-1",
  sessionId: "session-1",
  finishedAt: "2026-04-13T00:00:00.000Z",
  summary: "task finished",
} as const;

test("reviewTaskResult classifies success and accepts it", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "succeeded",
    exitCode: 0,
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.action, "accept");
  assert.equal(result.retryable, false);
  assert.equal(result.needsUser, false);
});

test("reviewTaskResult classifies retryable failures", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "failed",
    exitCode: 124,
    summary: "command timed out",
  });

  assert.equal(result.outcome, "retryable_failure");
  assert.equal(result.action, "retry");
  assert.equal(result.retryable, true);
});

test("reviewTaskResult classifies blocked work as needing the user", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "blocked",
    exitCode: 1,
    summary: "blocked waiting for approval",
  });

  assert.equal(result.outcome, "blocked_needs_user");
  assert.equal(result.action, "ask_user");
  assert.equal(result.needsUser, true);
});

test("reviewTaskResult classifies policy denials via hints or evidence", () => {
  const hinted = reviewTaskResult({
    ...baseResult,
    status: "failed",
    exitCode: 1,
    summary: "operation refused",
  }, { policyDenied: true });

  assert.equal(hinted.outcome, "policy_denied");
  assert.equal(hinted.action, "halt");
  assert.equal(hinted.retryable, false);

  const evidenceBased = classifyReviewedOutcome({
    ...baseResult,
    status: "failed",
    exitCode: 1,
    summary: "denied by policy",
  });

  assert.equal(evidenceBased.outcome, "policy_denied");
});

test("reviewTaskResult classifies incomplete work as follow-up", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "needs_review",
    exitCode: 127,
    summary: "command not found",
  });

  assert.equal(result.outcome, "incomplete_needs_follow_up");
  assert.equal(result.action, "follow_up");
  assert.equal(result.retryable, false);
  assert.equal(result.needsUser, false);
});
