import assert from "node:assert/strict";
import test from "node:test";

import { loadSessionRecord } from "../../src/sessionStore.js";
import {
  coerceSessionReviewAction,
  coerceSessionReviewOutcome,
  deriveSessionTitle,
} from "../../src/sessionTypes.js";

test("coerceSessionReviewOutcome: mapping table", () => {
  assert.equal(coerceSessionReviewOutcome("success"), "success");
  assert.equal(coerceSessionReviewOutcome("accepted"), "success");
  assert.equal(coerceSessionReviewOutcome("accept"), "success");
  assert.equal(coerceSessionReviewOutcome("task_success"), "success");
  assert.equal(coerceSessionReviewOutcome("retry"), "retryable_failure");
  assert.equal(coerceSessionReviewOutcome("failed"), "retryable_failure");
  assert.equal(coerceSessionReviewOutcome("retryable_failure"), "retryable_failure");
  assert.equal(coerceSessionReviewOutcome("blocked"), "blocked_needs_user");
  assert.equal(coerceSessionReviewOutcome("blocked_needs_user"), "blocked_needs_user");
  assert.equal(coerceSessionReviewOutcome("ask"), "blocked_needs_user");
  assert.equal(coerceSessionReviewOutcome("policy_denied"), "policy_denied");
  assert.equal(
    coerceSessionReviewOutcome("incomplete_needs_follow_up"),
    "incomplete_needs_follow_up",
  );
  // Fallbacks
  assert.equal(coerceSessionReviewOutcome("garbage"), "retryable_failure");
  assert.equal(coerceSessionReviewOutcome(undefined), "retryable_failure");
  assert.equal(coerceSessionReviewOutcome(null), "retryable_failure");
  assert.equal(coerceSessionReviewOutcome(""), "retryable_failure");
});

test("coerceSessionReviewAction: mapping table", () => {
  assert.equal(coerceSessionReviewAction("accept"), "accept");
  assert.equal(coerceSessionReviewAction("accepted"), "accept");
  assert.equal(coerceSessionReviewAction("retry"), "retry");
  assert.equal(coerceSessionReviewAction("ask_user"), "ask_user");
  assert.equal(coerceSessionReviewAction("ask"), "ask_user");
  assert.equal(coerceSessionReviewAction("halt"), "halt");
  assert.equal(coerceSessionReviewAction("stop"), "halt");
  assert.equal(coerceSessionReviewAction("follow_up"), "follow_up");
  assert.equal(coerceSessionReviewAction("followup"), "follow_up");
  // Conservative default
  assert.equal(coerceSessionReviewAction("garbage"), "accept");
  assert.equal(coerceSessionReviewAction(undefined), "accept");
  assert.equal(coerceSessionReviewAction(null), "accept");
});

test("deriveSessionTitle: prompt under 80 chars is kept verbatim", () => {
  const title = deriveSessionTitle({
    sessionId: "s-1",
    goal: "the goal",
    turns: [{ prompt: "short prompt" }],
  });
  assert.equal(title, "short prompt");
});

test("deriveSessionTitle: long prompt truncated with ellipsis", () => {
  const longPrompt = "a".repeat(200);
  const title = deriveSessionTitle({
    sessionId: "s-1",
    goal: "g",
    turns: [{ prompt: longPrompt }],
  });
  assert.equal(title.length, 81); // 80 chars + one "…"
  assert.ok(title.endsWith("…"));
  assert.equal(title.slice(0, 80), "a".repeat(80));
});

test("deriveSessionTitle: prompt trimmed before truncation; trailing whitespace dropped", () => {
  const prompt = `${"a".repeat(78)}   ${"b".repeat(20)}`;
  const title = deriveSessionTitle({
    sessionId: "s",
    goal: "g",
    turns: [{ prompt }],
  });
  // slice(0,80) = 78*a + "  ", then trailing-whitespace-strip → 78*a + "…"
  assert.ok(title.endsWith("…"));
  assert.ok(!/\s…$/u.test(title));
});

test("deriveSessionTitle: falls back to goal when no turn prompt, then sessionId", () => {
  assert.equal(
    deriveSessionTitle({ sessionId: "s-1", goal: "fallback goal", turns: [] }),
    "fallback goal",
  );
  assert.equal(deriveSessionTitle({ sessionId: "s-1", goal: undefined, turns: [] }), "s-1");
  assert.equal(deriveSessionTitle({ sessionId: "s-1" }), "s-1");
});

test("loadSessionRecord: v2 with loose latestReview object gets coerced", () => {
  const raw = {
    schemaVersion: 2,
    sessionId: "s-loose",
    repoRoot: "/tmp/r",
    goal: "loose review",
    status: "completed",
    assumeDangerousSkipPermissions: false,
    turns: [
      {
        turnId: "turn-1",
        prompt: "prompt",
        mode: "build",
        status: "completed",
        attempts: [{ attemptId: "a-1", status: "succeeded" }],
        createdAt: "2026-04-14T12:00:00.000Z",
        updatedAt: "2026-04-14T12:05:00.000Z",
        latestReview: {
          outcome: "accepted",
          action: "accept",
          reason: "legacy ok",
        },
      },
    ],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:05:00.000Z",
  };
  const loaded = loadSessionRecord(raw);
  const review = loaded.turns[0]!.latestReview!;
  assert.equal(review.outcome, "success");
  assert.equal(review.action, "accept");
  assert.equal(review.reason, "legacy ok");
  assert.equal(review.attemptId, "a-1");
  assert.match(review.reviewId, /^review-/u);
  assert.equal(review.reviewedAt, "2026-04-14T12:05:00.000Z");
});

test("loadSessionRecord: v2 with no latestReview stays absent", () => {
  const raw = {
    schemaVersion: 2,
    sessionId: "s-no-review",
    repoRoot: "/tmp/r",
    title: "no review yet",
    goal: "no review yet",
    status: "planned",
    assumeDangerousSkipPermissions: false,
    turns: [
      {
        turnId: "turn-1",
        prompt: "no review yet",
        mode: "build",
        status: "queued",
        attempts: [],
        createdAt: "2026-04-14T12:00:00.000Z",
        updatedAt: "2026-04-14T12:00:00.000Z",
      },
    ],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };
  const loaded = loadSessionRecord(raw);
  assert.equal(loaded.title, "no review yet");
  assert.equal(loaded.turns[0]?.latestReview, undefined);
});
