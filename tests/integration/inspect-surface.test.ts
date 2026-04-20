import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../../src/artifactStore.js";
import type { SessionRecord, SessionTurnRecord } from "../../src/sessionTypes.js";
import {
  formatInspectArtifacts,
  formatInspectLogs,
  formatInspectReview,
  formatInspectSandbox,
  formatInspectSummary,
} from "../../src/host/inspectFormatter.js";
import { buildInspectView } from "../../src/host/commands/inspect.js";
import { reviewTaskResult } from "../../src/reviewer.js";
import { SessionStore } from "../../src/sessionStore.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-inspect-int-"));

const buildFixtureSession = (): {
  session: SessionRecord;
  turn: SessionTurnRecord;
} => {
  const turn: SessionTurnRecord = {
    turnId: "turn-1",
    prompt: "add a review surface",
    mode: "build",
    status: "completed",
    attempts: [
      {
        attemptId: "attempt-abc",
        status: "succeeded",
        request: {
          schemaVersion: 1,
          taskId: "attempt-abc",
          sessionId: "session-inspect-1",
          goal: "add a review surface",
          mode: "build",
          assumeDangerousSkipPermissions: true,
        },
        result: {
          schemaVersion: 1,
          taskId: "attempt-abc",
          sessionId: "session-inspect-1",
          status: "succeeded",
          summary: "3 files changed, tests pass",
          finishedAt: "2026-04-14T12:05:00.000Z",
          exitCode: 0,
        },
        metadata: { sandboxTaskId: "abox-sandbox-99" },
        dispatchCommand: ["abox", "--repo", "/tmp/repo", "run", "--task", "attempt-abc"],
      },
    ],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:05:00.000Z",
    latestReview: {
      reviewId: "review-test-1",
      attemptId: "attempt-abc",
      outcome: "success",
      action: "accept",
      reason: "all green",
      reviewedAt: "2026-04-14T12:05:01.000Z",
    },
  };
  const session: SessionRecord = {
    schemaVersion: 2,
    sessionId: "session-inspect-1",
    repoRoot: "/tmp/repo",
    title: "add a review surface",
    status: "completed",
    turns: [turn],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:05:00.000Z",
  };
  return { session, turn };
};

test("inspect summary contains sandbox ID and session info", () => {
  const { session, turn } = buildFixtureSession();
  const attempt = turn.attempts[0]!;
  const lines = formatInspectSummary({ session, turn, attempt });
  const joined = lines.join("\n");
  assert.match(joined, /session-inspect-1/, "contains session ID");
  assert.match(joined, /abox-sandbox-99/, "contains sandbox ID");
  assert.match(joined, /\/tmp\/repo/, "contains repo root");
  assert.match(joined, /success/, "contains outcome");
});

test("inspect review produces expected sections", () => {
  const { session, turn } = buildFixtureSession();
  const attempt = turn.attempts[0]!;
  const reviewed = reviewTaskResult(attempt.result!);
  const lines = formatInspectReview({ session, attempt, reviewed, artifacts: [] });
  const joined = lines.join("\n");
  assert.match(joined, /Review/, "starts with Review heading");
  assert.match(joined, /attempt-abc/, "contains attempt ID");
  assert.match(joined, /success/, "contains outcome");
  assert.match(joined, /accept/, "contains action");
});

test("inspect sandbox shows dispatch command and artifact paths", async () => {
  const rootDir = await createTempRoot();
  try {
    const { session } = buildFixtureSession();
    const attempt = session.turns[0]!.attempts[0]!;
    const artifactStore = new ArtifactStore(rootDir);
    await artifactStore.registerArtifact({
      artifactId: "art-1",
      sessionId: session.sessionId,
      taskId: attempt.attemptId,
      kind: "result",
      name: "result.json",
      path: join(rootDir, "result.json"),
    });
    const artifacts = await artifactStore.listTaskArtifacts(session.sessionId, attempt.attemptId);
    const lines = formatInspectSandbox({ session, attempt, artifacts });
    const joined = lines.join("\n");
    assert.match(joined, /Sandbox/, "starts with Sandbox heading");
    assert.match(joined, /abox.*run/, "contains dispatch command");
    assert.match(joined, /result\.json/, "contains artifact path");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("inspect artifacts subcommand lists registered artifacts", async () => {
  const rootDir = await createTempRoot();
  try {
    const { session } = buildFixtureSession();
    const attempt = session.turns[0]!.attempts[0]!;
    const artifactStore = new ArtifactStore(rootDir);
    await artifactStore.registerArtifact({
      artifactId: "art-dispatch",
      sessionId: session.sessionId,
      taskId: attempt.attemptId,
      kind: "dispatch",
      name: "dispatch.json",
      path: join(rootDir, "dispatch.json"),
    });
    await artifactStore.registerArtifact({
      artifactId: "art-log",
      sessionId: session.sessionId,
      taskId: attempt.attemptId,
      kind: "log",
      name: "worker-output.log",
      path: join(rootDir, "worker-output.log"),
    });
    const artifacts = await artifactStore.listTaskArtifacts(session.sessionId, attempt.attemptId);
    const lines = formatInspectArtifacts({ session, attempt, artifacts });
    const joined = lines.join("\n");
    assert.match(joined, /Artifacts/, "starts with Artifacts heading");
    assert.match(joined, /Count\s+2/, "reports count of 2");
    assert.match(joined, /dispatch\.json/, "lists dispatch artifact");
    assert.match(joined, /worker-output\.log/, "lists log artifact");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("inspect logs subcommand renders event lines", () => {
  const { session } = buildFixtureSession();
  const attempt = session.turns[0]!.attempts[0]!;
  const events = [
    {
      timestamp: "2026-04-14T12:00:00Z",
      status: "running",
      taskId: "attempt-abc",
      kind: "task.started",
    },
    {
      timestamp: "2026-04-14T12:01:00Z",
      status: "running",
      taskId: "attempt-abc",
      kind: "task.progress",
      message: "working",
    },
    {
      timestamp: "2026-04-14T12:05:00Z",
      status: "succeeded",
      taskId: "attempt-abc",
      kind: "task.completed",
    },
  ];
  const lines = formatInspectLogs({ session, attempt, events });
  const joined = lines.join("\n");
  assert.match(joined, /Logs/, "starts with Logs heading");
  assert.match(joined, /Events\s+3/, "reports 3 events");
  assert.match(joined, /task\.started/, "contains started event");
  assert.match(joined, /working/, "contains progress message");
  assert.match(joined, /task\.completed/, "contains completed event");
});

test("buildInspectView review prefers persisted apply-state review over raw worker success", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-inspect-apply",
      goal: "apply recovery",
      repoRoot: "/tmp/repo",
      status: "failed",
      turns: [
        {
          turnId: "turn-1",
          prompt: "apply recovery",
          mode: "build",
          status: "failed",
          attempts: [
            {
              attemptId: "attempt-apply",
              status: "failed",
              candidateState: "apply_failed",
              candidate: {
                state: "apply_failed",
                updatedAt: "2026-04-19T12:00:02.000Z",
                applyError: "host apply failed after review",
              },
              result: {
                schemaVersion: 1,
                taskId: "attempt-apply",
                sessionId: "session-inspect-apply",
                status: "succeeded",
                summary: "worker succeeded before host apply",
                exitCode: 0,
                finishedAt: "2026-04-19T12:00:01.000Z",
              },
              reviewRecord: {
                reviewId: "review-apply-1",
                attemptId: "attempt-apply",
                outcome: "retryable_failure",
                action: "retry",
                reason: "host apply failed after review",
                reviewedAt: "2026-04-19T12:00:02.000Z",
              },
            },
          ],
          latestReview: {
            reviewId: "review-apply-1",
            attemptId: "attempt-apply",
            outcome: "retryable_failure",
            action: "retry",
            reason: "host apply failed after review",
            reviewedAt: "2026-04-19T12:00:02.000Z",
          },
          createdAt: "2026-04-19T12:00:00.000Z",
          updatedAt: "2026-04-19T12:00:02.000Z",
        },
      ],
      createdAt: "2026-04-19T12:00:00.000Z",
      updatedAt: "2026-04-19T12:00:02.000Z",
    });
    const session = (await store.loadSession("session-inspect-apply"))!;
    const { lines } = await buildInspectView({
      rootDir,
      session,
      requestedTab: "review",
      invalidTabMode: "error",
    });
    const joined = lines.join("\n");
    assert.match(joined, /Outcome\s+retryable_failure/u);
    assert.match(joined, /Action\s+retry/u);
    assert.match(joined, /Candidate\s+apply_failed/u);
    assert.match(joined, /host apply failed after review/u);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
