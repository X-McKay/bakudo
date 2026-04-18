import assert from "node:assert/strict";
import test from "node:test";

import type { TaskResult } from "../../src/protocol.js";
import { classifyReviewedOutcome } from "../../src/resultClassifier.js";
import { reviewTaskResult } from "../../src/reviewer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseResult = {
  schemaVersion: 1,
  taskId: "task-1",
  sessionId: "session-1",
  finishedAt: "2026-04-15T00:00:00.000Z",
  summary: "task finished",
} as const;

const buildResult = (overrides: Partial<TaskResult>): TaskResult =>
  ({
    ...baseResult,
    status: "succeeded",
    ...overrides,
  }) as TaskResult;

// ---------------------------------------------------------------------------
// All three confidence levels
// ---------------------------------------------------------------------------

test("classifyReviewedOutcome: success defaults to high confidence", () => {
  const classification = classifyReviewedOutcome(buildResult({ status: "succeeded", exitCode: 0 }));
  assert.equal(classification.outcome, "success");
  assert.equal(classification.confidence, "high");
});

test("classifyReviewedOutcome: failure defaults to medium confidence", () => {
  const classification = classifyReviewedOutcome(
    buildResult({ status: "failed", exitCode: 1, summary: "boom" }),
  );
  assert.equal(classification.outcome, "retryable_failure");
  assert.equal(classification.confidence, "medium");
});

test("classifyReviewedOutcome: explicit hints.confidence wins over defaults", () => {
  const classification = classifyReviewedOutcome(
    buildResult({ status: "succeeded", exitCode: 0 }),
    { confidence: "low" },
  );
  assert.equal(classification.outcome, "success");
  assert.equal(classification.confidence, "low");
});

test("classifyReviewedOutcome: policy_denied defaults to medium when no hint supplied", () => {
  const classification = classifyReviewedOutcome(
    buildResult({ status: "failed", exitCode: 1, summary: "denied by policy" }),
  );
  assert.equal(classification.outcome, "policy_denied");
  assert.equal(classification.confidence, "medium");
});

test("classifyReviewedOutcome: blocked_needs_user defaults to medium and can be overridden", () => {
  const bare = classifyReviewedOutcome(
    buildResult({ status: "blocked", exitCode: 1, summary: "waiting for approval" }),
  );
  assert.equal(bare.outcome, "blocked_needs_user");
  assert.equal(bare.confidence, "medium");

  const overridden = classifyReviewedOutcome(
    buildResult({ status: "blocked", exitCode: 1, summary: "waiting for approval" }),
    { confidence: "low" },
  );
  assert.equal(overridden.confidence, "low");
});

test("classifyReviewedOutcome: incomplete_needs_follow_up gets the medium default", () => {
  const classification = classifyReviewedOutcome(
    buildResult({ status: "needs_review", exitCode: 127, summary: "command not found" }),
  );
  assert.equal(classification.outcome, "incomplete_needs_follow_up");
  assert.equal(classification.confidence, "medium");
});

// ---------------------------------------------------------------------------
// Backward compatibility: no hints means existing callers still compile and
// run. The classifier must continue to accept its legacy zero-arg and
// one-arg forms.
// ---------------------------------------------------------------------------

test("classifyReviewedOutcome: legacy callers that omit hints still get a valid confidence", () => {
  const noHints = classifyReviewedOutcome(buildResult({ status: "succeeded", exitCode: 0 }));
  assert.ok(["low", "medium", "high"].includes(noHints.confidence));
});

test("reviewTaskResult: surfaces a confidence field even without PR5 inputs", () => {
  const reviewed = reviewTaskResult(buildResult({ status: "succeeded", exitCode: 0 }));
  assert.equal(reviewed.confidence, "high");
});

test("reviewTaskResult: retryable failure surfaces a medium confidence", () => {
  const reviewed = reviewTaskResult(
    buildResult({ status: "failed", exitCode: 124, summary: "timed out" }),
  );
  assert.equal(reviewed.outcome, "retryable_failure");
  assert.equal(reviewed.confidence, "medium");
});
