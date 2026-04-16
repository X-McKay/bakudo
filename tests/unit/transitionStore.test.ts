import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendTurnTransition,
  createChainId,
  emitTurnTransition,
  findLatestTurnTransition,
  listTurnTransitions,
  transitionsFilePath,
  type TurnTransition,
} from "../../src/host/transitionStore.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-transitions-"));

const sampleTransition = (overrides: Partial<TurnTransition> = {}): TurnTransition => ({
  transitionId: "transition-test-1",
  sessionId: "session-x",
  turnId: "turn-1",
  fromStatus: "queued",
  toStatus: "queued",
  reason: "next_turn",
  chainId: "chain-test-1",
  depth: 0,
  timestamp: "2026-04-14T12:00:00.000Z",
  ...overrides,
});

test("transitionsFilePath builds <session>/transitions.ndjson under the storage root", async () => {
  const rootDir = await createTempRoot();
  try {
    const filePath = transitionsFilePath(rootDir, "session-a");
    assert.ok(filePath.endsWith(join("session-a", "transitions.ndjson")));
    assert.ok(filePath.startsWith(rootDir));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listTurnTransitions returns [] when the file does not exist", async () => {
  const rootDir = await createTempRoot();
  try {
    const transitions = await listTurnTransitions(rootDir, "session-never-touched");
    assert.deepEqual(transitions, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendTurnTransition creates the session directory and writes one NDJSON line", async () => {
  const rootDir = await createTempRoot();
  try {
    const transition = sampleTransition();
    await appendTurnTransition(rootDir, "session-append", transition);
    const filePath = transitionsFilePath(rootDir, "session-append");
    const contents = await readFile(filePath, "utf8");
    assert.equal(contents.split("\n").filter((line) => line.length > 0).length, 1);
    assert.deepEqual(JSON.parse(contents.trim()), transition);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendTurnTransition appends without overwriting", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-multi";
    await appendTurnTransition(rootDir, sessionId, sampleTransition({ transitionId: "t-1" }));
    await appendTurnTransition(rootDir, sessionId, sampleTransition({ transitionId: "t-2" }));
    await appendTurnTransition(rootDir, sessionId, sampleTransition({ transitionId: "t-3" }));
    const transitions = await listTurnTransitions(rootDir, sessionId);
    assert.equal(transitions.length, 3);
    assert.deepEqual(
      transitions.map((entry) => entry.transitionId),
      ["t-1", "t-2", "t-3"],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listTurnTransitions round-trips through write/read preserving all fields", async () => {
  const rootDir = await createTempRoot();
  try {
    const transition = sampleTransition({
      turnId: "turn-2",
      fromStatus: "reviewing",
      toStatus: "running",
      reason: "user_retry",
      chainId: "chain-round-trip",
      depth: 3,
    });
    await appendTurnTransition(rootDir, "session-rt", transition);
    const [first] = await listTurnTransitions(rootDir, "session-rt");
    assert.deepEqual(first, transition);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("findLatestTurnTransition returns the most recent transition for the named turn", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-find";
    await appendTurnTransition(
      rootDir,
      sessionId,
      sampleTransition({
        turnId: "turn-1",
        transitionId: "t-1",
        chainId: "chain-1",
        depth: 0,
      }),
    );
    await appendTurnTransition(
      rootDir,
      sessionId,
      sampleTransition({
        turnId: "turn-2",
        transitionId: "t-2",
        chainId: "chain-2",
        depth: 0,
      }),
    );
    await appendTurnTransition(
      rootDir,
      sessionId,
      sampleTransition({
        turnId: "turn-1",
        transitionId: "t-3",
        chainId: "chain-1",
        depth: 1,
        reason: "user_retry",
      }),
    );

    const latestTurn1 = await findLatestTurnTransition(rootDir, sessionId, "turn-1");
    assert.ok(latestTurn1);
    assert.equal(latestTurn1.transitionId, "t-3");
    assert.equal(latestTurn1.depth, 1);
    assert.equal(latestTurn1.chainId, "chain-1");

    const latestTurn2 = await findLatestTurnTransition(rootDir, sessionId, "turn-2");
    assert.ok(latestTurn2);
    assert.equal(latestTurn2.transitionId, "t-2");

    const missing = await findLatestTurnTransition(rootDir, sessionId, "turn-does-not-exist");
    assert.equal(missing, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("emitTurnTransition: next_turn generates a fresh chainId at depth 0", async () => {
  const rootDir = await createTempRoot();
  try {
    const result = await emitTurnTransition({
      storageRoot: rootDir,
      sessionId: "session-emit-next",
      turnId: "turn-1",
      fromStatus: "queued",
      toStatus: "queued",
      reason: "next_turn",
    });
    assert.match(result.transitionId, /^transition-/u);
    assert.match(result.chainId, /^chain-/u);
    assert.equal(result.depth, 0);
    assert.equal(result.reason, "next_turn");

    const [persisted] = await listTurnTransitions(rootDir, "session-emit-next");
    assert.deepEqual(persisted, result);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("emitTurnTransition: retry extends an existing chainId and increments depth", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-emit-retry";
    const first = await emitTurnTransition({
      storageRoot: rootDir,
      sessionId,
      turnId: "turn-1",
      fromStatus: "queued",
      toStatus: "queued",
      reason: "next_turn",
    });
    const retry = await emitTurnTransition({
      storageRoot: rootDir,
      sessionId,
      turnId: "turn-1",
      fromStatus: "reviewing",
      toStatus: "running",
      reason: "user_retry",
      chainId: first.chainId,
      depth: first.depth + 1,
    });
    assert.equal(retry.chainId, first.chainId);
    assert.equal(retry.depth, 1);
    assert.equal(retry.reason, "user_retry");
    assert.notEqual(retry.transitionId, first.transitionId);
    const all = await listTurnTransitions(rootDir, sessionId);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.chainId, all[1]?.chainId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("createChainId returns a unique string each call", () => {
  const a = createChainId();
  const b = createChainId();
  assert.match(a, /^chain-/u);
  assert.match(b, /^chain-/u);
  assert.notEqual(a, b);
});
