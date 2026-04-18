import assert from "node:assert/strict";
import test from "node:test";

import { type AttemptLineage, deriveAttemptLineage } from "../../src/host/attemptLineage.js";
import type { TurnTransition, TurnTransitionReason } from "../../src/host/transitionStore.js";
import type { SessionAttemptRecord } from "../../src/sessionTypes.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const buildAttempt = (overrides: Partial<SessionAttemptRecord> = {}): SessionAttemptRecord => ({
  attemptId: "attempt-1",
  status: "succeeded",
  ...overrides,
});

let transitionCounter = 0;
const buildTransition = (overrides: Partial<TurnTransition> = {}): TurnTransition => {
  transitionCounter += 1;
  return {
    transitionId: `transition-${transitionCounter}`,
    sessionId: "session-x",
    turnId: "turn-1",
    fromStatus: "queued",
    toStatus: "running",
    reason: "next_turn",
    chainId: "chain-test",
    depth: 0,
    timestamp: new Date(2026, 3, 14, 12, 0, transitionCounter).toISOString(),
    ...overrides,
  };
};

const nextTurnTransition = (overrides: Partial<TurnTransition> = {}): TurnTransition =>
  buildTransition({ reason: "next_turn", depth: 0, ...overrides });

const retryTransition = (
  reason: TurnTransitionReason,
  depth: number,
  chainId = "chain-test",
  overrides: Partial<TurnTransition> = {},
): TurnTransition => buildTransition({ reason, depth, chainId, ...overrides });

// ---------------------------------------------------------------------------
// First-attempt shape
// ---------------------------------------------------------------------------

test("first attempt, no transitions: depth 0, synthetic chainId, no initiator", () => {
  const attempt = buildAttempt({ attemptId: "attempt-1", status: "running" });
  const lineage = deriveAttemptLineage(attempt, []);
  const expected: AttemptLineage = {
    attemptId: "attempt-1",
    chainId: "chain-attempt-1",
    depth: 0,
  };
  assert.deepEqual(lineage, expected);
  assert.equal(lineage.retryInitiator, undefined);
  assert.equal(lineage.transition, undefined);
  assert.equal(lineage.parentAttemptId, undefined);
});

test("first attempt reuses chainId from an existing next_turn transition on the turn", () => {
  const attempt = buildAttempt({ attemptId: "attempt-1" });
  const chainId = "chain-existing";
  const lineage = deriveAttemptLineage(attempt, [nextTurnTransition({ chainId })]);
  assert.equal(lineage.chainId, chainId);
  assert.equal(lineage.depth, 0);
  assert.equal(lineage.retryInitiator, undefined);
  assert.equal(lineage.transition, undefined);
});

// ---------------------------------------------------------------------------
// Retry initiator classification
// ---------------------------------------------------------------------------

test('retry with reason "user_retry" sets retryInitiator = "user"', () => {
  const attempt = buildAttempt({
    attemptId: "attempt-2",
    parentAttemptId: "attempt-1",
    status: "running",
  });
  const transitions = [
    nextTurnTransition({ chainId: "chain-u" }),
    retryTransition("user_retry", 1, "chain-u"),
  ];
  const lineage = deriveAttemptLineage(attempt, transitions);
  assert.equal(lineage.retryInitiator, "user");
  assert.equal(lineage.chainId, "chain-u");
  assert.equal(lineage.depth, 1);
  assert.equal(lineage.parentAttemptId, "attempt-1");
  assert.ok(lineage.transition);
  assert.equal(lineage.transition?.reason, "user_retry");
});

test('retry with reason "host_retry" sets retryInitiator = "host"', () => {
  const attempt = buildAttempt({
    attemptId: "attempt-2",
    parentAttemptId: "attempt-1",
  });
  const transitions = [
    nextTurnTransition({ chainId: "chain-h" }),
    retryTransition("host_retry", 1, "chain-h"),
  ];
  const lineage = deriveAttemptLineage(attempt, transitions);
  assert.equal(lineage.retryInitiator, "host");
  assert.equal(lineage.depth, 1);
});

test('retry with reason "approval_denied_retry" sets retryInitiator = "host"', () => {
  const attempt = buildAttempt({
    attemptId: "attempt-2",
    parentAttemptId: "attempt-1",
  });
  const transitions = [
    nextTurnTransition({ chainId: "chain-ad" }),
    retryTransition("approval_denied_retry", 1, "chain-ad"),
  ];
  const lineage = deriveAttemptLineage(attempt, transitions);
  assert.equal(lineage.retryInitiator, "host");
  assert.equal(lineage.chainId, "chain-ad");
  assert.equal(lineage.depth, 1);
});

test('retry with reason "recovery_required" sets retryInitiator = "host"', () => {
  const attempt = buildAttempt({
    attemptId: "attempt-2",
    parentAttemptId: "attempt-1",
  });
  const transitions = [
    nextTurnTransition({ chainId: "chain-rc" }),
    retryTransition("recovery_required", 1, "chain-rc"),
  ];
  const lineage = deriveAttemptLineage(attempt, transitions);
  assert.equal(lineage.retryInitiator, "host");
});

test('retry with reason "protocol_mismatch_recovery" sets retryInitiator = "host"', () => {
  const attempt = buildAttempt({
    attemptId: "attempt-2",
    parentAttemptId: "attempt-1",
  });
  const transitions = [
    nextTurnTransition({ chainId: "chain-pm" }),
    retryTransition("protocol_mismatch_recovery", 1, "chain-pm"),
  ];
  const lineage = deriveAttemptLineage(attempt, transitions);
  assert.equal(lineage.retryInitiator, "host");
});

// ---------------------------------------------------------------------------
// Multi-step chain: depth increments across attempts when caller slices
// transitions to match each attempt's position.
// ---------------------------------------------------------------------------

test("multi-step chain: depth increments correctly across successive attempts", () => {
  const chainId = "chain-multi";

  // Transitions that would exist in the log after 3 attempts (1 initial + 2 retries).
  const transitionForAttempt1 = [nextTurnTransition({ chainId })];
  const transitionForAttempt2 = [
    ...transitionForAttempt1,
    retryTransition("host_retry", 1, chainId),
  ];
  const transitionForAttempt3 = [
    ...transitionForAttempt2,
    retryTransition("user_retry", 2, chainId),
  ];

  const attempt1 = buildAttempt({ attemptId: "attempt-1" });
  const attempt2 = buildAttempt({ attemptId: "attempt-2", parentAttemptId: "attempt-1" });
  const attempt3 = buildAttempt({ attemptId: "attempt-3", parentAttemptId: "attempt-2" });

  const lineage1 = deriveAttemptLineage(attempt1, transitionForAttempt1);
  const lineage2 = deriveAttemptLineage(attempt2, transitionForAttempt2);
  const lineage3 = deriveAttemptLineage(attempt3, transitionForAttempt3);

  assert.equal(lineage1.depth, 0);
  assert.equal(lineage1.chainId, chainId);
  assert.equal(lineage1.retryInitiator, undefined);

  assert.equal(lineage2.depth, 1);
  assert.equal(lineage2.chainId, chainId);
  assert.equal(lineage2.retryInitiator, "host");

  assert.equal(lineage3.depth, 2);
  assert.equal(lineage3.chainId, chainId);
  assert.equal(lineage3.retryInitiator, "user");
});

// ---------------------------------------------------------------------------
// parentAttemptId + retryReason surface through
// ---------------------------------------------------------------------------

test("attempt with parentAttemptId and retryReason surfaces both on AttemptLineage", () => {
  const attempt = buildAttempt({
    attemptId: "attempt-2",
    parentAttemptId: "attempt-1",
    retryReason: "tests failed, retrying with verbose",
  });
  const transitions = [
    nextTurnTransition({ chainId: "chain-r" }),
    retryTransition("host_retry", 1, "chain-r"),
  ];
  const lineage = deriveAttemptLineage(attempt, transitions);
  assert.equal(lineage.parentAttemptId, "attempt-1");
  assert.equal(lineage.retryReason, "tests failed, retrying with verbose");
  assert.equal(lineage.chainId, "chain-r");
  assert.equal(lineage.depth, 1);
  assert.equal(lineage.retryInitiator, "host");
});

test("first attempt carrying a retryReason (stray but tolerated) passes the reason through", () => {
  const attempt = buildAttempt({
    attemptId: "attempt-1",
    retryReason: "ignored-on-first-attempt-but-not-dropped",
  });
  const lineage = deriveAttemptLineage(attempt, []);
  assert.equal(lineage.retryReason, "ignored-on-first-attempt-but-not-dropped");
  assert.equal(lineage.parentAttemptId, undefined);
  assert.equal(lineage.depth, 0);
});

// ---------------------------------------------------------------------------
// Fallback: missing transition for a turn
// ---------------------------------------------------------------------------

test("missing transition for a turn: fallback to chain-<attemptId>, depth 0, no initiator", () => {
  const attempt = buildAttempt({ attemptId: "attempt-xyz" });
  const lineage = deriveAttemptLineage(attempt, []);
  assert.equal(lineage.chainId, "chain-attempt-xyz");
  assert.equal(lineage.depth, 0);
  assert.equal(lineage.retryInitiator, undefined);
  assert.equal(lineage.transition, undefined);
});

test("retry attempt with an empty transitions list falls back to synthetic chainId", () => {
  // Tolerant read of a partially-migrated session where the attempt record
  // claims a parent but the transitions log is absent/empty.
  const attempt = buildAttempt({
    attemptId: "attempt-orphan",
    parentAttemptId: "attempt-prior",
    retryReason: "salvaged",
  });
  const lineage = deriveAttemptLineage(attempt, []);
  assert.equal(lineage.chainId, "chain-attempt-orphan");
  assert.equal(lineage.depth, 0);
  assert.equal(lineage.parentAttemptId, "attempt-prior");
  assert.equal(lineage.retryReason, "salvaged");
  assert.equal(lineage.retryInitiator, undefined);
  assert.equal(lineage.transition, undefined);
});
