import assert from "node:assert/strict";
import test from "node:test";

import { reviewTaskResult } from "../../src/reviewer.js";
import type { SessionAttemptRecord, SessionRecord } from "../../src/sessionTypes.js";
import {
  formatInspectArtifacts,
  formatInspectLogs,
  formatInspectReview,
  formatInspectSandbox,
  formatInspectSummary,
} from "../../src/host/inspectFormatter.js";

const buildSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  schemaVersion: 2,
  sessionId: "session-sample",
  repoRoot: "/tmp/repo",
  goal: "the goal",
  status: "running",
  assumeDangerousSkipPermissions: false,
  turns: [],
  createdAt: "2026-04-14T12:00:00.000Z",
  updatedAt: "2026-04-14T12:00:00.000Z",
  ...overrides,
});

const buildAttempt = (): SessionAttemptRecord => ({
  attemptId: "attempt-xyz",
  status: "succeeded",
  request: {
    schemaVersion: 1,
    taskId: "attempt-xyz",
    sessionId: "session-sample",
    goal: "the goal",
    mode: "build",
    assumeDangerousSkipPermissions: true,
  },
  result: {
    schemaVersion: 1,
    taskId: "attempt-xyz",
    sessionId: "session-sample",
    status: "succeeded",
    summary: "all green",
    finishedAt: "2026-04-14T12:05:00.000Z",
  },
  metadata: { sandboxTaskId: "abox-sandbox-123" },
});

test("formatInspectSummary: includes session, repo, turns, and outcome", () => {
  const session = buildSession();
  const attempt = buildAttempt();
  const turn = {
    turnId: "turn-1",
    prompt: "the goal",
    mode: "build",
    status: "completed" as const,
    attempts: [attempt],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:05:00.000Z",
  };
  const lines = formatInspectSummary({ session, turn, attempt });
  assert.equal(lines[0], "Summary");
  const joined = lines.join("\n");
  assert.match(joined, /session-sample/);
  assert.match(joined, /\/tmp\/repo/);
  assert.match(joined, /the goal/);
  assert.match(joined, /turn-1/);
  assert.match(joined, /attempt-xyz/);
  assert.match(joined, /abox-sandbox-123/);
  assert.match(joined, /success/);
});

test("formatInspectSummary: ordering puts Outcome before State/Updated/Turns", () => {
  const session = buildSession();
  const attempt = buildAttempt();
  const turn = {
    turnId: "turn-1",
    prompt: "the goal",
    mode: "build",
    status: "completed" as const,
    attempts: [attempt],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:05:00.000Z",
  };
  const lines = formatInspectSummary({ session, turn, attempt });
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

test("formatInspectReview: Outcome appears before any raw log/dispatch line", () => {
  const session = buildSession();
  const attempt = buildAttempt();
  const reviewed = reviewTaskResult(attempt.result!);
  const lines = formatInspectReview({
    session,
    attempt,
    reviewed,
    artifacts: [
      {
        schemaVersion: 1,
        artifactId: "a1",
        sessionId: session.sessionId,
        taskId: attempt.attemptId,
        kind: "dispatch",
        name: "dispatch.json",
        path: "/tmp/dispatch.json",
        createdAt: "2026-04-14T12:05:00.000Z",
      },
      {
        schemaVersion: 1,
        artifactId: "a2",
        sessionId: session.sessionId,
        taskId: attempt.attemptId,
        kind: "log",
        name: "worker-output.log",
        path: "/tmp/worker.log",
        createdAt: "2026-04-14T12:05:00.000Z",
      },
    ],
  });
  const joined = lines.join("\n");
  const outcomeIndex = joined.indexOf("Outcome");
  const dispatchIndex = joined.indexOf("Dispatch");
  const workerIndex = joined.indexOf("Worker");
  assert.ok(outcomeIndex >= 0);
  assert.ok(dispatchIndex > outcomeIndex);
  assert.ok(workerIndex > outcomeIndex);
});

test("formatInspectReview: projects reviewed outcome + artifact hints", () => {
  const session = buildSession();
  const attempt = buildAttempt();
  const reviewed = reviewTaskResult(attempt.result!);
  const lines = formatInspectReview({
    session,
    attempt,
    reviewed,
    artifacts: [
      {
        schemaVersion: 1,
        artifactId: "a1",
        sessionId: session.sessionId,
        taskId: attempt.attemptId,
        kind: "dispatch",
        name: "dispatch.json",
        path: "/tmp/dispatch.json",
        createdAt: "2026-04-14T12:05:00.000Z",
      },
    ],
  });
  assert.equal(lines[0], "Review");
  const joined = lines.join("\n");
  assert.match(joined, /Outcome.*success/);
  assert.match(joined, /\/tmp\/dispatch\.json/);
});

test("formatInspectSandbox: includes safety + abox command", () => {
  const session = buildSession();
  const attempt = {
    ...buildAttempt(),
    metadata: {
      sandboxTaskId: "abox-1",
      aboxCommand: ["abox", "run", "--task", "abox-1"],
    },
  };
  const lines = formatInspectSandbox({ session, attempt, artifacts: [] });
  assert.equal(lines[0], "Sandbox");
  const joined = lines.join("\n");
  assert.match(joined, /abox run --task abox-1/);
  assert.match(joined, /dangerous-skip-permissions enabled/);
});

test("formatInspectArtifacts: counts + renders rows", () => {
  const session = buildSession();
  const lines = formatInspectArtifacts({
    session,
    artifacts: [
      {
        schemaVersion: 1,
        artifactId: "a1",
        sessionId: session.sessionId,
        taskId: "t",
        kind: "log",
        name: "worker.log",
        path: "/tmp/w.log",
        createdAt: "2026-04-14T12:00:00.000Z",
      },
    ],
  });
  const joined = lines.join("\n");
  assert.match(joined, /Count.*1/);
  assert.match(joined, /worker\.log.*log.*\/tmp\/w\.log/);
});

test("formatInspectArtifacts: empty list renders '(no artifacts registered)'", () => {
  const session = buildSession();
  const lines = formatInspectArtifacts({ session, artifacts: [] });
  assert.ok(lines.some((line) => line.includes("no artifacts registered")));
});

test("formatInspectLogs: filters by attempt.attemptId when attempt provided", () => {
  const session = buildSession();
  const attempt = buildAttempt();
  const lines = formatInspectLogs({
    session,
    attempt,
    events: [
      { timestamp: "t1", status: "running", taskId: attempt.attemptId, kind: "task.started" },
      { timestamp: "t2", status: "succeeded", taskId: "other", kind: "task.completed" },
    ],
  });
  const joined = lines.join("\n");
  assert.match(joined, /Events.*1/);
  assert.match(joined, /task\.started/);
  assert.doesNotMatch(joined, /task\.completed/);
});
