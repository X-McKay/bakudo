import assert from "node:assert/strict";
import test from "node:test";

import { reviewTaskResult } from "../../src/reviewer.js";
import type { SessionAttemptRecord, SessionRecord } from "../../src/sessionTypes.js";
import { formatInspectTab } from "../../src/host/inspectTabs.js";

const buildSession = (): SessionRecord => ({
  schemaVersion: 2,
  sessionId: "session-tabs",
  repoRoot: "/tmp/tabs",
  title: "the goal",
  status: "running",
  turns: [],
  createdAt: "2026-04-14T12:00:00.000Z",
  updatedAt: "2026-04-14T12:00:00.000Z",
});

const buildAttempt = (): SessionAttemptRecord => ({
  attemptId: "attempt-tabs",
  status: "succeeded",
  request: {
    schemaVersion: 1,
    taskId: "attempt-tabs",
    sessionId: "session-tabs",
    goal: "the goal",
    mode: "build",
    assumeDangerousSkipPermissions: true,
  },
  result: {
    schemaVersion: 1,
    taskId: "attempt-tabs",
    sessionId: "session-tabs",
    status: "succeeded",
    summary: "all green",
    finishedAt: "2026-04-14T12:05:00.000Z",
  },
  metadata: { sandboxTaskId: "sandbox-tabs" },
});

const buildTurn = () => ({
  turnId: "turn-tabs",
  prompt: "the goal",
  mode: "build",
  status: "completed" as const,
  attempts: [buildAttempt()],
  createdAt: "2026-04-14T12:00:00.000Z",
  updatedAt: "2026-04-14T12:05:00.000Z",
});

const baseInput = () => {
  const session = buildSession();
  const turn = buildTurn();
  const attempt = turn.attempts[0]!;
  return {
    session,
    turn,
    attempt,
    artifacts: [],
    events: [],
    reviewed: reviewTaskResult(attempt.result!),
    approvals: [],
  };
};

// ---------------------------------------------------------------------------

test("formatInspectTab routes summary → formatInspectSummary output", () => {
  const lines = formatInspectTab("summary", baseInput());
  assert.equal(lines[0], "Summary");
});

test("formatInspectTab routes review → formatInspectReview output", () => {
  const lines = formatInspectTab("review", baseInput());
  assert.equal(lines[0], "Review");
});

test("formatInspectTab routes provenance → formatInspectProvenance output", () => {
  const lines = formatInspectTab("provenance", baseInput());
  assert.equal(lines[0], "Provenance");
});

test("formatInspectTab routes artifacts → formatInspectArtifacts output", () => {
  const lines = formatInspectTab("artifacts", baseInput());
  assert.equal(lines[0], "Artifacts");
});

test("formatInspectTab routes approvals → formatInspectApprovals output", () => {
  const lines = formatInspectTab("approvals", baseInput());
  assert.equal(lines[0], "Approvals");
});

test("formatInspectTab routes logs → formatInspectLogs output", () => {
  const lines = formatInspectTab("logs", baseInput());
  assert.equal(lines[0], "Logs");
});

test("formatInspectTab review without reviewed payload returns placeholder", () => {
  const base = baseInput();
  const input: Parameters<typeof formatInspectTab>[1] = {
    session: base.session,
    turn: base.turn,
    attempt: base.attempt,
    artifacts: base.artifacts,
    events: base.events,
    approvals: base.approvals,
  };
  const lines = formatInspectTab("review", input);
  const joined = lines.join("\n");
  assert.equal(lines[0], "Review");
  assert.match(joined, /no reviewed result yet/);
});

test("formatInspectTab provenance without attempt returns placeholder", () => {
  const base = baseInput();
  const input: Parameters<typeof formatInspectTab>[1] = {
    session: base.session,
    turn: base.turn,
    artifacts: base.artifacts,
    events: base.events,
    reviewed: base.reviewed,
    approvals: base.approvals,
  };
  const lines = formatInspectTab("provenance", input);
  assert.equal(lines[0], "Provenance");
  assert.ok(lines.some((line) => line.includes("no attempts yet")));
});

test("summary tab ordering invariant preserved: Outcome before State", () => {
  const lines = formatInspectTab("summary", baseInput());
  const indexOf = (label: string): number => lines.findIndex((line) => line.startsWith(label));
  assert.ok(indexOf("Session") < indexOf("Repo"));
  assert.ok(indexOf("Repo") < indexOf("Goal"));
  assert.ok(indexOf("Goal") < indexOf("Outcome"));
  assert.ok(indexOf("Outcome") < indexOf("Action"));
  assert.ok(indexOf("Action") < indexOf("Attempt"));
  assert.ok(indexOf("Attempt") < indexOf("Sandbox"));
  assert.ok(indexOf("Sandbox") < indexOf("State"));
  assert.ok(indexOf("State") < indexOf("Updated"));
  assert.ok(indexOf("Updated") < indexOf("Turns"));
});

test("approvals tab with no records renders count 0 + placeholder", () => {
  const lines = formatInspectTab("approvals", baseInput());
  const joined = lines.join("\n");
  assert.match(joined, /Count.*0/);
  assert.match(joined, /no approval records/);
});

test("logs tab filters by attempt.attemptId", () => {
  const input = baseInput();
  const lines = formatInspectTab("logs", {
    ...input,
    events: [
      { timestamp: "t1", status: "running", taskId: "attempt-tabs", kind: "task.started" },
      { timestamp: "t2", status: "running", taskId: "other", kind: "task.progress" },
    ],
  });
  const joined = lines.join("\n");
  assert.match(joined, /Events.*1/);
  assert.match(joined, /task\.started/);
  assert.doesNotMatch(joined, /task\.progress/);
});
