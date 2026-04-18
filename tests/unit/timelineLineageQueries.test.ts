import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore } from "../../src/sessionStore.js";
import {
  appendTurnTransition,
  type TurnTransition,
  type TurnTransitionReason,
} from "../../src/host/transitionStore.js";
import { listTurnLineage, loadAttemptLineage } from "../../src/host/timeline.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-lineage-"));

let transitionCounter = 0;
const seedTransition = async (
  rootDir: string,
  sessionId: string,
  turnId: string,
  reason: TurnTransitionReason,
  chainId: string,
  depth: number,
): Promise<TurnTransition> => {
  transitionCounter += 1;
  const transition: TurnTransition = {
    transitionId: `tr-${transitionCounter}`,
    sessionId,
    turnId,
    fromStatus: "queued",
    toStatus: "running",
    reason,
    chainId,
    depth,
    timestamp: new Date(2026, 3, 15, 12, 0, transitionCounter).toISOString(),
  };
  await appendTurnTransition(rootDir, sessionId, transition);
  return transition;
};

const seedChainedSession = async (rootDir: string, sessionId: string): Promise<void> => {
  const store = new SessionStore(rootDir);
  await store.createSession({
    sessionId,
    goal: "lineage test",
    repoRoot: "/tmp",
    assumeDangerousSkipPermissions: false,
    status: "running",
    turns: [
      {
        turnId: "turn-1",
        prompt: "do a thing",
        mode: "build",
        status: "running",
        attempts: [
          { attemptId: "attempt-1", status: "failed" },
          {
            attemptId: "attempt-2",
            status: "failed",
            parentAttemptId: "attempt-1",
            retryReason: "tests failed, retrying",
          },
          {
            attemptId: "attempt-3",
            status: "succeeded",
            parentAttemptId: "attempt-2",
            retryReason: "retrying as user requested",
          },
        ],
        createdAt: "2026-04-15T12:00:00.000Z",
        updatedAt: "2026-04-15T12:00:30.000Z",
      },
      {
        turnId: "turn-2",
        prompt: "follow up",
        mode: "build",
        status: "queued",
        attempts: [{ attemptId: "attempt-20", status: "queued" }],
        createdAt: "2026-04-15T12:01:00.000Z",
        updatedAt: "2026-04-15T12:01:00.000Z",
      },
    ],
  });
};

// ---------------------------------------------------------------------------
// loadAttemptLineage
// ---------------------------------------------------------------------------

test("loadAttemptLineage returns null for missing session", async () => {
  const rootDir = await createTempRoot();
  try {
    const lineage = await loadAttemptLineage(rootDir, "session-missing", "turn-1", "attempt-1");
    assert.equal(lineage, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadAttemptLineage returns null for missing turn", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-lq-missing-turn";
    await seedChainedSession(rootDir, sessionId);
    const lineage = await loadAttemptLineage(rootDir, sessionId, "turn-nope", "attempt-1");
    assert.equal(lineage, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadAttemptLineage returns null for missing attempt", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-lq-missing-attempt";
    await seedChainedSession(rootDir, sessionId);
    const lineage = await loadAttemptLineage(rootDir, sessionId, "turn-1", "attempt-nope");
    assert.equal(lineage, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadAttemptLineage round-trip: persist session+transitions, load, assert shape", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-lq-roundtrip";
    await seedChainedSession(rootDir, sessionId);
    const chainId = "chain-rt";
    await seedTransition(rootDir, sessionId, "turn-1", "next_turn", chainId, 0);
    await seedTransition(rootDir, sessionId, "turn-1", "host_retry", chainId, 1);
    await seedTransition(rootDir, sessionId, "turn-1", "user_retry", chainId, 2);

    const first = await loadAttemptLineage(rootDir, sessionId, "turn-1", "attempt-1");
    assert.ok(first);
    assert.equal(first.attemptId, "attempt-1");
    assert.equal(first.depth, 0);
    assert.equal(first.chainId, chainId);
    assert.equal(first.retryInitiator, undefined);
    assert.equal(first.transition, undefined);

    const second = await loadAttemptLineage(rootDir, sessionId, "turn-1", "attempt-2");
    assert.ok(second);
    assert.equal(second.attemptId, "attempt-2");
    assert.equal(second.parentAttemptId, "attempt-1");
    assert.equal(second.retryReason, "tests failed, retrying");
    assert.equal(second.chainId, chainId);
    assert.equal(second.depth, 1);
    assert.equal(second.retryInitiator, "host");
    assert.ok(second.transition);
    assert.equal(second.transition?.reason, "host_retry");

    const third = await loadAttemptLineage(rootDir, sessionId, "turn-1", "attempt-3");
    assert.ok(third);
    assert.equal(third.parentAttemptId, "attempt-2");
    assert.equal(third.retryReason, "retrying as user requested");
    assert.equal(third.depth, 2);
    assert.equal(third.retryInitiator, "user");
    assert.equal(third.transition?.reason, "user_retry");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listTurnLineage
// ---------------------------------------------------------------------------

test("listTurnLineage returns [] for missing session", async () => {
  const rootDir = await createTempRoot();
  try {
    const lineages = await listTurnLineage(rootDir, "session-none", "turn-1");
    assert.deepEqual(lineages, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listTurnLineage returns [] for missing turn", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-lq-list-missing";
    await seedChainedSession(rootDir, sessionId);
    const lineages = await listTurnLineage(rootDir, sessionId, "turn-nope");
    assert.deepEqual(lineages, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listTurnLineage returns lineage for every attempt on a turn, in order", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-lq-list-all";
    await seedChainedSession(rootDir, sessionId);
    const chainId = "chain-list";
    await seedTransition(rootDir, sessionId, "turn-1", "next_turn", chainId, 0);
    await seedTransition(rootDir, sessionId, "turn-1", "host_retry", chainId, 1);
    await seedTransition(rootDir, sessionId, "turn-1", "user_retry", chainId, 2);

    const lineages = await listTurnLineage(rootDir, sessionId, "turn-1");
    assert.equal(lineages.length, 3);
    assert.deepEqual(
      lineages.map((entry) => entry.attemptId),
      ["attempt-1", "attempt-2", "attempt-3"],
    );
    assert.deepEqual(
      lineages.map((entry) => entry.depth),
      [0, 1, 2],
    );
    assert.equal(lineages[0]?.retryInitiator, undefined);
    assert.equal(lineages[1]?.retryInitiator, "host");
    assert.equal(lineages[2]?.retryInitiator, "user");
    for (const lineage of lineages) {
      assert.equal(lineage.chainId, chainId);
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listTurnLineage ignores transitions belonging to other turns", async () => {
  // Regression: the turn filter in timeline.ts must drop transitions that
  // happen to share the session but target a different turn.
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-lq-turn-filter";
    await seedChainedSession(rootDir, sessionId);
    // turn-2's next_turn transition
    await seedTransition(rootDir, sessionId, "turn-2", "next_turn", "chain-turn-2", 0);

    const lineages = await listTurnLineage(rootDir, sessionId, "turn-1");
    assert.equal(lineages.length, 3);
    // Without a turn-1 transition at all, each attempt's chainId falls back
    // to chain-<attemptId> (for the first) or chain-<attemptId> (for
    // orphaned retries) rather than leaking chain-turn-2.
    for (const lineage of lineages) {
      assert.notEqual(lineage.chainId, "chain-turn-2");
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
