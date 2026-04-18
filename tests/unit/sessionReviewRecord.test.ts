import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SessionStore, loadSessionRecord } from "../../src/sessionStore.js";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  coerceSessionReviewAction,
  coerceSessionReviewOutcome,
  deriveSessionTitle,
} from "../../src/sessionTypes.js";

// Built test lives at `dist/tests/unit/<this>.js`; three URL segments up → repo root.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const createTempRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "bakudo-review-record-"));

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

test("loadSessionRecord: v1 with metadata reviewedOutcome+reviewedAction synthesizes latestReview", () => {
  const raw = {
    schemaVersion: 1,
    sessionId: "session-legacy-review",
    goal: "legacy",
    status: "failed",
    assumeDangerousSkipPermissions: true,
    tasks: [
      {
        taskId: "task-1",
        status: "failed",
        lastMessage: "task failed",
        metadata: {
          sandboxTaskId: "abox-legacy-1",
          aboxCommand: ["abox", "--repo", "/tmp", "run", "--task", "t", "--", "echo", "hi"],
          reviewedOutcome: "retryable_failure",
          reviewedAction: "retry",
        },
      },
    ],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };
  const loaded = loadSessionRecord(raw);
  assert.equal(loaded.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
  assert.equal(loaded.title, "legacy");
  const turn = loaded.turns[0]!;
  assert.ok(turn.latestReview, "expected latestReview to be synthesized from metadata");
  assert.equal(turn.latestReview?.outcome, "retryable_failure");
  assert.equal(turn.latestReview?.action, "retry");
  assert.equal(turn.latestReview?.attemptId, "task-1");
  assert.match(turn.latestReview?.reviewId ?? "", /^review-/u);
  assert.equal(turn.latestReview?.reason, "task failed");
  // dispatchCommand hoisted from metadata.aboxCommand
  const attempt = turn.attempts[0]!;
  assert.deepEqual(attempt.dispatchCommand, [
    "abox",
    "--repo",
    "/tmp",
    "run",
    "--task",
    "t",
    "--",
    "echo",
    "hi",
  ]);
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

test("round-trip: v1-with-review → v2 load → save → reload preserves latestReview + dispatchCommand", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionDir = join(rootDir, "session-rt-review");
    await mkdir(sessionDir, { recursive: true });
    const v1 = {
      schemaVersion: 1,
      sessionId: "session-rt-review",
      goal: "round trip with review",
      status: "failed",
      assumeDangerousSkipPermissions: false,
      tasks: [
        {
          taskId: "task-1",
          status: "failed",
          lastMessage: "boom",
          metadata: {
            sandboxTaskId: "abox-rt-1",
            aboxCommand: ["abox", "run", "--task", "t", "--", "false"],
            reviewedOutcome: "failed",
            reviewedAction: "retry",
          },
        },
      ],
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:05:00.000Z",
    };
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(v1, null, 2), "utf8");

    const store = new SessionStore(rootDir);
    const firstLoad = await store.loadSession("session-rt-review");
    assert.ok(firstLoad);
    const reviewFirst = firstLoad.turns[0]!.latestReview;
    assert.ok(reviewFirst);
    const savedReviewId = reviewFirst.reviewId;

    await store.saveSession(firstLoad);
    const reloaded = await store.loadSession("session-rt-review");
    assert.ok(reloaded);
    const reviewSecond = reloaded.turns[0]!.latestReview!;
    assert.equal(reviewSecond.outcome, "retryable_failure");
    assert.equal(reviewSecond.action, "retry");
    // Stable reviewId across save/reload (no re-generation)
    assert.equal(reviewSecond.reviewId, savedReviewId);
    assert.equal(reviewSecond.attemptId, "task-1");
    const attempt = reloaded.turns[0]!.attempts[0]!;
    assert.deepEqual(attempt.dispatchCommand, ["abox", "run", "--task", "t", "--", "false"]);
    assert.equal(reloaded.title, "round trip with review");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("real on-disk v1 session in .bakudo/sessions/ loads cleanly with title + latestReview", async (t) => {
  const store = new SessionStore(join(REPO_ROOT, ".bakudo", "sessions"));
  const loaded = await store.loadSession("session-1776168453757-67162ef3");
  if (!loaded) {
    t.skip("real v1 session fixture not present (expected on clean checkouts)");
    return;
  }
  assert.equal(loaded.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
  assert.equal(typeof loaded.title, "string");
  assert.ok(loaded.title.length > 0);
  const turn = loaded.turns[0]!;
  assert.ok(turn.latestReview, "expected real session to have synthesized latestReview");
  assert.equal(turn.latestReview?.outcome, "retryable_failure");
  assert.equal(turn.latestReview?.action, "retry");
});
