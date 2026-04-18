/**
 * Phase 6 W5 — inspect-formatter secret-redaction tests.
 *
 * Plan 06 §W5 hard rule 383 ("inspect summaries must never expose raw
 * secret values"). Every user-facing string rendered by the formatter is
 * routed through `redactText(..., DEFAULT_REDACTION_POLICY)` before display.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatInspectArtifacts,
  formatInspectLogs,
  formatInspectReview,
  formatInspectSandbox,
  formatInspectSummary,
} from "../../src/host/inspectFormatter.js";
import { REDACTION_MARKER } from "../../src/host/redaction.js";
import { reviewTaskResult } from "../../src/reviewer.js";
import type { SessionAttemptRecord, SessionRecord } from "../../src/sessionTypes.js";

const SECRET_GHP = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_SK = "sk-abcdefghijklmnopqrstuvwxyz012345";

const buildSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  schemaVersion: 2,
  sessionId: "session-sample",
  repoRoot: "/tmp/repo",
  title: `the goal ${SECRET_GHP}`,
  status: "running",
  turns: [
    {
      turnId: "turn-1",
      prompt: `please use ${SECRET_SK} carefully`,
      mode: "build",
      status: "completed" as const,
      attempts: [],
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:05:00.000Z",
    },
  ],
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
    summary: `token leaked: ${SECRET_GHP}`,
    finishedAt: "2026-04-14T12:05:00.000Z",
  },
  metadata: { sandboxTaskId: "abox-sandbox-123" },
  dispatchCommand: ["bash", "-lc", `curl -H 'Authorization: Bearer ${SECRET_SK}'`],
});

// ---------------------------------------------------------------------------
// formatInspectSummary — Goal + Repo routed through redactText
// ---------------------------------------------------------------------------

test("formatInspectSummary redacts secret-looking prompt/goal text", () => {
  const session = buildSession();
  const turn = session.turns[0];
  assert.ok(turn);
  const lines = formatInspectSummary({ session, turn });
  const joined = lines.join("\n");
  assert.ok(!joined.includes(SECRET_GHP), "GHP token leaked in summary output");
  assert.ok(!joined.includes(SECRET_SK), "SK key leaked in summary output");
  assert.ok(joined.includes(REDACTION_MARKER), "marker must appear");
});

// ---------------------------------------------------------------------------
// formatInspectReview — result.summary + dispatch artifact path routed through redactText
// ---------------------------------------------------------------------------

test("formatInspectReview redacts result.summary secret values", () => {
  const session = buildSession();
  const attempt = buildAttempt();
  assert.ok(attempt.result);
  const reviewed = reviewTaskResult(attempt.result);
  const lines = formatInspectReview({
    session,
    attempt,
    reviewed,
    artifacts: [],
  });
  const joined = lines.join("\n");
  assert.ok(!joined.includes(SECRET_GHP), `unexpected raw token in:\n${joined}`);
  assert.ok(joined.includes(REDACTION_MARKER));
});

// ---------------------------------------------------------------------------
// formatInspectSandbox — dispatch command routed through redactText
// ---------------------------------------------------------------------------

test("formatInspectSandbox redacts secrets embedded in dispatch command args", () => {
  const session = buildSession();
  const attempt = buildAttempt();
  const lines = formatInspectSandbox({ session, attempt, artifacts: [] });
  const joined = lines.join("\n");
  assert.ok(!joined.includes(SECRET_SK), `dispatch command leaked sk key:\n${joined}`);
  assert.ok(joined.includes(REDACTION_MARKER));
});

// ---------------------------------------------------------------------------
// formatInspectArtifacts / formatInspectLogs — name + message routed
// ---------------------------------------------------------------------------

test("formatInspectArtifacts redacts artifact names / paths", () => {
  const session = buildSession();
  const lines = formatInspectArtifacts({
    session,
    artifacts: [
      {
        schemaVersion: 1 as const,
        artifactId: "a-1",
        sessionId: "session-sample",
        kind: "log",
        name: `dump-${SECRET_GHP}.log`,
        path: `/tmp/${SECRET_SK}/x.log`,
        createdAt: "2026-04-14T12:00:00.000Z",
      },
    ],
  });
  const joined = lines.join("\n");
  assert.ok(!joined.includes(SECRET_GHP));
  assert.ok(!joined.includes(SECRET_SK));
});

test("formatInspectLogs redacts event.message secrets", () => {
  const session = buildSession();
  const lines = formatInspectLogs({
    session,
    events: [
      {
        timestamp: "2026-04-14T12:01:00.000Z",
        status: "ok",
        taskId: "t-1",
        kind: "progress",
        message: `probe saw ${SECRET_GHP}`,
      },
    ],
  });
  const joined = lines.join("\n");
  assert.ok(!joined.includes(SECRET_GHP));
  assert.ok(joined.includes(REDACTION_MARKER));
});
