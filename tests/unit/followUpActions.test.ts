import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyFollowUpAction } from "../../src/host/followUpActions.js";
import { emitTurnTransition, listTurnTransitions } from "../../src/host/transitionStore.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { SessionAttemptRecord, SessionTurnRecord } from "../../src/sessionTypes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-followup-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

type SeedInput = {
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  turnStatus?: SessionTurnRecord["status"];
  attemptStatus?: SessionAttemptRecord["status"];
  /**
   * When true, also emit a `next_turn` transition so the retry path finds
   * an existing chain to extend. The tests that want to assert chain
   * continuity use this; the tests that exercise the tolerant fallback
   * (no prior transition) leave it off.
   */
  seedTransition?: boolean;
};

/**
 * Create a minimal session with one turn and one attempt so the follow-up
 * paths have something to extend. Returns the store so callers can re-read.
 */
const seedSession = async (input: SeedInput): Promise<SessionStore> => {
  const store = new SessionStore(input.storageRoot);
  const now = new Date().toISOString();
  const turn: SessionTurnRecord = {
    turnId: input.turnId,
    prompt: "test prompt",
    mode: "build",
    status: input.turnStatus ?? "reviewing",
    attempts: [
      {
        attemptId: input.attemptId,
        status: input.attemptStatus ?? "failed",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await store.createSession({
    sessionId: input.sessionId,
    goal: "test goal",
    repoRoot: "/tmp/fake-repo",
    status: "running",
    turns: [turn],
  });
  if (input.seedTransition === true) {
    await emitTurnTransition({
      storageRoot: input.storageRoot,
      sessionId: input.sessionId,
      turnId: input.turnId,
      fromStatus: "queued",
      toStatus: "queued",
      reason: "next_turn",
    });
  }
  return store;
};

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

test("retry: emits host_retry transition extending prior chain and records new attempt", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-retry";
    const turnId = "turn-1";
    const sourceAttemptId = "attempt-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: sourceAttemptId,
      seedTransition: true,
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId,
      storageRoot,
      action: { kind: "retry" },
    });

    assert.ok(result.transition, "expected transition on retry path");
    assert.equal(result.transition?.reason, "host_retry");
    assert.equal(result.transition?.depth, 1);
    assert.equal(result.transition?.toStatus, "queued");
    assert.ok(result.newAttemptId, "expected newAttemptId on retry path");
    assert.match(result.message, /Retry queued/u);

    const session = await store.loadSession(sessionId);
    assert.ok(session);
    const turn = session.turns.find((t) => t.turnId === turnId);
    assert.ok(turn);
    const newAttempt = turn.attempts.find((a) => a.attemptId === result.newAttemptId);
    assert.ok(newAttempt);
    assert.equal(newAttempt.parentAttemptId, sourceAttemptId);
    assert.equal(newAttempt.retryReason, "host retry requested");
    assert.equal(newAttempt.status, "queued");
  });
});

test("retry: without a prior transition starts a fresh chain at depth 0", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-retry-no-prior";
    const turnId = "turn-1";
    await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "retry" },
    });

    assert.ok(result.transition);
    assert.equal(result.transition?.depth, 0);
    assert.match(result.transition?.chainId ?? "", /^chain-/u);
  });
});

// ---------------------------------------------------------------------------
// retry_refine
// ---------------------------------------------------------------------------

test("retry_refine: emits host_retry_refine transition and carries refinement in retryReason", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-refine";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
      seedTransition: true,
    });
    const refinement = "retry this time with --verbose";

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "retry_refine", refinement },
    });

    assert.equal(result.transition?.reason, "host_retry_refine");
    assert.ok(result.newAttemptId);
    assert.match(result.message, /verbose/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    const newAttempt = turn?.attempts.find((a) => a.attemptId === result.newAttemptId);
    assert.equal(newAttempt?.retryReason, refinement);
    assert.equal(newAttempt?.parentAttemptId, "attempt-1");
  });
});

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

test("ask_user: returns a question-bearing message and emits NO transition", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-ask";
    const turnId = "turn-1";
    await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const question = "Which branch should I target?";
    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "ask_user", question },
    });

    assert.equal(result.transition, undefined);
    assert.equal(result.newAttemptId, undefined);
    assert.match(result.message, new RegExp(question, "u"));
    assert.match(result.message, /Paused:/u);

    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 0, "ask_user must not emit a transition");
  });
});

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

test("accept: updates turn status to completed and emits NO transition", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "accept" },
    });

    assert.equal(result.transition, undefined);
    assert.equal(result.newAttemptId, undefined);
    assert.match(result.message, /accepted/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    assert.equal(turn?.status, "completed");

    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 0, "accept must not emit a transition");
  });
});

test("accept: idempotent — calling twice is safe and the second call is a no-op", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-idempotent";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const first = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "accept" },
    });
    const second = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "accept" },
    });

    assert.match(first.message, /accepted/u);
    assert.match(second.message, /already accepted/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    assert.equal(turn?.status, "completed");
    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 0, "accept must never emit a transition — even on retry");
  });
});

// ---------------------------------------------------------------------------
// halt
// ---------------------------------------------------------------------------

test("halt: emits user_halt transition and updates turn status to cancelled", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-halt";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
      turnStatus: "running",
      seedTransition: true,
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "halt" },
    });

    assert.ok(result.transition, "expected transition on halt path");
    assert.equal(result.transition?.reason, "user_halt");
    assert.equal(result.transition?.toStatus, "cancelled");
    assert.equal(result.transition?.depth, 1, "halt extends the prior chain");
    assert.match(result.message, /halted/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    assert.equal(turn?.status, "cancelled");

    const log = await listTurnTransitions(storageRoot, sessionId);
    // 1 seeded next_turn + 1 user_halt.
    assert.equal(log.length, 2);
  });
});

test("halt: idempotent — second call is a no-op and does not emit a second transition", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-halt-idempotent";
    const turnId = "turn-1";
    await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
      turnStatus: "running",
    });

    const first = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "halt" },
    });
    const second = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "halt" },
    });

    assert.ok(first.transition);
    assert.match(first.message, /halted/u);
    assert.equal(second.transition, undefined);
    assert.match(second.message, /already halted/u);

    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 1, "only the first halt emits a transition");
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test("applyFollowUpAction throws for unknown session", async () => {
  await withTempRoot(async (storageRoot) => {
    await assert.rejects(
      applyFollowUpAction({
        sessionId: "missing",
        turnId: "turn-1",
        sourceAttemptId: "attempt-1",
        storageRoot,
        action: { kind: "accept" },
      }),
      /unknown session/u,
    );
  });
});

test("applyFollowUpAction throws for unknown turn within an existing session", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-missing-turn";
    await seedSession({
      storageRoot,
      sessionId,
      turnId: "turn-1",
      attemptId: "attempt-1",
    });
    await assert.rejects(
      applyFollowUpAction({
        sessionId,
        turnId: "turn-999",
        sourceAttemptId: "attempt-1",
        storageRoot,
        action: { kind: "retry" },
      }),
      /unknown turn/u,
    );
  });
});
