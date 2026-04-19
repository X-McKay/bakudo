import assert from "node:assert/strict";
import test from "node:test";

import { formatInspectSandbox } from "../../src/host/inspectFormatter.js";
import type { SessionAttemptRecord, SessionRecord } from "../../src/sessionTypes.js";

const buildSession = (): SessionRecord => ({
  schemaVersion: 2,
  sessionId: "session-f07",
  repoRoot: "/tmp/repo",
  title: "truncate sandbox dispatch",
  status: "completed",
  turns: [],
  createdAt: "2026-04-19T12:00:00.000Z",
  updatedAt: "2026-04-19T12:01:00.000Z",
});

const buildAttempt = (dispatchCommand: string[]): SessionAttemptRecord => ({
  attemptId: "attempt-f07",
  status: "succeeded",
  request: {
    schemaVersion: 1,
    taskId: "attempt-f07",
    sessionId: "session-f07",
    goal: "truncate sandbox dispatch",
    mode: "build",
    assumeDangerousSkipPermissions: true,
  },
  result: {
    schemaVersion: 1,
    taskId: "attempt-f07",
    sessionId: "session-f07",
    status: "succeeded",
    summary: "dispatch completed",
    finishedAt: "2026-04-19T12:01:00.000Z",
  },
  metadata: { sandboxTaskId: "abox-task-f07" },
  dispatchCommand,
});

test("F-07: formatInspectSandbox truncates huge inline dispatch bodies", () => {
  const payload = Array.from(
    { length: 600 },
    (_, index) => `echo VERBOSE_PAYLOAD_SENTINEL_${String(index).padStart(3, "0")}`,
  ).join("\n");
  const payloadLines = payload.split("\n").length;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const session = buildSession();
  const attempt = buildAttempt([
    "abox",
    "--repo",
    "/tmp/scratch",
    "run",
    "--task",
    "bakudo-1-sess-f07",
    "--ephemeral",
    "--",
    "bash",
    "-lc",
    payload,
  ]);
  const rendered = formatInspectSandbox({
    session,
    attempt,
    artifacts: [
      {
        schemaVersion: 1,
        artifactId: "artifact-f07-dispatch",
        sessionId: session.sessionId,
        taskId: attempt.attemptId,
        kind: "dispatch",
        name: "dispatch.json",
        path: "/tmp/bakudo/artifacts/dispatch.json",
        createdAt: "2026-04-19T12:01:00.000Z",
      },
    ],
  }).join("\n");

  assert.ok(
    rendered.split("\n").length <= 20,
    `sandbox output grew too large (${rendered.split("\n").length} lines)\n${rendered}`,
  );
  assert.match(rendered, /ABox\s+abox --repo \/tmp\/scratch run --task bakudo-1-sess-f07 --/);
  assert.ok(
    rendered.includes(
      `bash -lc <${payloadLines} lines, ${payloadBytes} bytes; see /tmp/bakudo/artifacts/dispatch.json>`,
    ),
    rendered,
  );
  assert.doesNotMatch(rendered, /VERBOSE_PAYLOAD_SENTINEL_599/);
});
