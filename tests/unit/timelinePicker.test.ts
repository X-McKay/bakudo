import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore } from "../../src/sessionStore.js";
import type { SessionTurnRecord } from "../../src/sessionTypes.js";
import {
  buildTimelineRows,
  inspectTimelineTurn,
  parseTimelineSelection,
  restartFromTurn,
} from "../../src/host/commands/timeline.js";
import { listTurnTransitions } from "../../src/host/transitionStore.js";

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-timeline-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const makeTurn = (
  turnId: string,
  prompt: string,
  updatedAt: string,
  status: SessionTurnRecord["status"] = "completed",
): SessionTurnRecord => ({
  turnId,
  prompt,
  mode: "build",
  status,
  attempts: [],
  createdAt: "2026-04-14T12:00:00.000Z",
  updatedAt,
});

// ---------------------------------------------------------------------------
// buildTimelineRows + parseTimelineSelection — pure helpers
// ---------------------------------------------------------------------------

test("buildTimelineRows: newest turn renders at index 0", () => {
  const turns = [
    makeTurn("turn-a", "first", "2026-04-14T12:00:00.000Z"),
    makeTurn("turn-c", "third", "2026-04-14T14:00:00.000Z"),
    makeTurn("turn-b", "second", "2026-04-14T13:00:00.000Z"),
  ];
  const rows = buildTimelineRows(turns);
  assert.equal(rows[0]?.turnId, "turn-c");
  assert.equal(rows[1]?.turnId, "turn-b");
  assert.equal(rows[2]?.turnId, "turn-a");
});

test("buildTimelineRows: label contains turnId, status, goal, timestamp", () => {
  const rows = buildTimelineRows([
    makeTurn("turn-x", "implement thing", "2026-04-14T12:00:00.000Z"),
  ]);
  const row = rows[0];
  assert.ok(row);
  assert.match(row.label, /turn-x/);
  assert.match(row.label, /completed/);
  assert.match(row.label, /implement thing/);
  assert.match(row.label, /2026-04-14T12:00:00\.000Z/);
});

test("buildTimelineRows: long goals are truncated with …", () => {
  const longGoal = "x".repeat(100);
  const rows = buildTimelineRows([makeTurn("turn-long", longGoal, "2026-04-14T12:00:00.000Z")]);
  assert.ok(rows[0]!.displayGoal.endsWith("…"));
  assert.ok(rows[0]!.displayGoal.length <= 48);
});

test("parseTimelineSelection: inspect/restart tokens parse correctly", () => {
  assert.deepEqual(parseTimelineSelection("inspect turn-1"), {
    action: "inspect",
    turnId: "turn-1",
  });
  assert.deepEqual(parseTimelineSelection("restart turn-7"), {
    action: "restart",
    turnId: "turn-7",
  });
  assert.deepEqual(parseTimelineSelection("INSPECT turn-1"), {
    action: "inspect",
    turnId: "turn-1",
  });
});

test("parseTimelineSelection: malformed inputs return null", () => {
  assert.equal(parseTimelineSelection(""), null);
  assert.equal(parseTimelineSelection("cancel"), null);
  assert.equal(parseTimelineSelection("garbage turn-1"), null);
  assert.equal(parseTimelineSelection("inspect"), null);
});

// ---------------------------------------------------------------------------
// restartFromTurn integration (writes real transitions)
// ---------------------------------------------------------------------------

test("restartFromTurn: creates new turn with parentTurnId + writes user_rewind transition", async () => {
  await withTempRoot(async (root) => {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-rw-1",
      goal: "rewind test",
      repoRoot: root,
      status: "running",
      turns: [
        makeTurn("turn-1", "first", "2026-04-14T12:00:00.000Z"),
        makeTurn("turn-2", "second", "2026-04-14T13:00:00.000Z"),
      ],
    });
    const result = await restartFromTurn(root, "session-rw-1", "turn-1");
    assert.ok(result !== null);
    assert.equal(result!.transition.reason, "user_rewind");
    assert.equal(result!.newTurn.parentTurnId, "turn-1");
    assert.match(result!.newTurn.turnId, /^turn-/u);

    const session = await store.loadSession("session-rw-1");
    assert.ok(session);
    const branched = session!.turns.find((t) => t.turnId === result!.newTurn.turnId);
    assert.ok(branched, "new turn persisted to session.json");
    assert.equal(branched!.parentTurnId, "turn-1");

    const transitions = await listTurnTransitions(root, "session-rw-1");
    const rewindTransitions = transitions.filter((t) => t.reason === "user_rewind");
    assert.equal(rewindTransitions.length, 1);
    assert.equal(rewindTransitions[0]?.turnId, result!.newTurn.turnId);
  });
});

test("restartFromTurn: returns null when the session is missing", async () => {
  await withTempRoot(async (root) => {
    const result = await restartFromTurn(root, "session-does-not-exist", "turn-1");
    assert.equal(result, null);
  });
});

test("restartFromTurn: returns null when the parent turn is missing", async () => {
  await withTempRoot(async (root) => {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-rw-no-parent",
      goal: "no parent",
      repoRoot: root,
      status: "running",
      turns: [makeTurn("turn-1", "first", "2026-04-14T12:00:00.000Z")],
    });
    const result = await restartFromTurn(root, "session-rw-no-parent", "turn-missing");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// inspectTimelineTurn renders the summary for the selected turn.
// ---------------------------------------------------------------------------

test("inspectTimelineTurn: returns summary tab lines for the selected turn", async () => {
  await withTempRoot(async (root) => {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-inspect-t",
      goal: "selected goal",
      repoRoot: root,
      status: "running",
      turns: [
        makeTurn("turn-1", "first goal", "2026-04-14T12:00:00.000Z"),
        makeTurn("turn-2", "second goal", "2026-04-14T13:00:00.000Z"),
      ],
    });
    const lines = await inspectTimelineTurn(root, "session-inspect-t", "turn-1");
    assert.equal(lines[0], "Summary");
    const joined = lines.join("\n");
    assert.match(joined, /session-inspect-t/);
    assert.match(joined, /first goal/);
  });
});

test("inspectTimelineTurn: missing turn surfaces an error line", async () => {
  await withTempRoot(async (root) => {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-inspect-miss",
      goal: "x",
      repoRoot: root,
      status: "running",
      turns: [makeTurn("turn-1", "only", "2026-04-14T12:00:00.000Z")],
    });
    const lines = await inspectTimelineTurn(root, "session-inspect-miss", "turn-nope");
    assert.match(lines.join("\n"), /not found/);
  });
});
