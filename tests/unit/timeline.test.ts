import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSessionEvent } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import { createSessionEventLogWriter } from "../../src/host/eventLogWriter.js";
import {
  appendArtifactRecord,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactIdFor,
  type ArtifactRecord,
} from "../../src/host/artifactStore.js";
import {
  getLatestAttempt,
  getLatestTurn,
  listSessionSummaries,
  listTurnArtifacts,
  listTurnEvents,
  loadEventLog,
  loadSession,
  loadTurn,
} from "../../src/host/timeline.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-timeline-"));

const seedSession = async (rootDir: string, sessionId: string): Promise<void> => {
  const store = new SessionStore(rootDir);
  await store.createSession({
    sessionId,
    goal: "test timeline",
    repoRoot: "/tmp",
    assumeDangerousSkipPermissions: false,
    status: "running",
    turns: [
      {
        turnId: "turn-1",
        prompt: "do something",
        mode: "plan",
        status: "running",
        attempts: [
          { attemptId: "attempt-1", status: "running" },
          { attemptId: "attempt-2", status: "succeeded" },
        ],
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:01.000Z",
      },
      {
        turnId: "turn-2",
        prompt: "follow up",
        mode: "plan",
        status: "queued",
        attempts: [],
        createdAt: "2026-04-15T00:00:02.000Z",
        updatedAt: "2026-04-15T00:00:02.000Z",
      },
    ],
  });
};

const buildArtifact = (turnId: string, kind: ArtifactRecord["kind"]): ArtifactRecord => ({
  schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactId: artifactIdFor(),
  sessionId: "session-tl",
  turnId,
  attemptId: "attempt-1",
  kind,
  name: `${kind}.json`,
  path: `artifacts/${kind}.json`,
  createdAt: "2026-04-15T00:00:00.000Z",
});

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

test("loadSession returns the session record when present", async () => {
  const rootDir = await createTempRoot();
  try {
    await seedSession(rootDir, "session-tl");
    const session = await loadSession(rootDir, "session-tl");
    assert.notEqual(session, null);
    assert.equal(session!.sessionId, "session-tl");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadSession returns null for missing session", async () => {
  const rootDir = await createTempRoot();
  try {
    const session = await loadSession(rootDir, "session-nope");
    assert.equal(session, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadTurn
// ---------------------------------------------------------------------------

test("loadTurn returns the matching turn", async () => {
  const rootDir = await createTempRoot();
  try {
    await seedSession(rootDir, "session-tl");
    const turn = await loadTurn(rootDir, "session-tl", "turn-1");
    assert.notEqual(turn, null);
    assert.equal(turn!.turnId, "turn-1");
    assert.equal(turn!.attempts.length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadTurn returns null for unknown turnId", async () => {
  const rootDir = await createTempRoot();
  try {
    await seedSession(rootDir, "session-tl");
    const turn = await loadTurn(rootDir, "session-tl", "turn-999");
    assert.equal(turn, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadTurn returns null for missing session", async () => {
  const rootDir = await createTempRoot();
  try {
    const turn = await loadTurn(rootDir, "no-session", "turn-1");
    assert.equal(turn, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// getLatestTurn / getLatestAttempt
// ---------------------------------------------------------------------------

test("getLatestTurn returns the last turn in the array", async () => {
  const rootDir = await createTempRoot();
  try {
    await seedSession(rootDir, "session-tl");
    const turn = await getLatestTurn(rootDir, "session-tl");
    assert.notEqual(turn, null);
    assert.equal(turn!.turnId, "turn-2");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("getLatestTurn returns null for missing session", async () => {
  const rootDir = await createTempRoot();
  try {
    assert.equal(await getLatestTurn(rootDir, "missing"), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("getLatestAttempt returns the last attempt of the turn", async () => {
  const rootDir = await createTempRoot();
  try {
    await seedSession(rootDir, "session-tl");
    const attempt = await getLatestAttempt(rootDir, "session-tl", "turn-1");
    assert.notEqual(attempt, null);
    assert.equal(attempt!.attemptId, "attempt-2");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("getLatestAttempt returns null when turn has no attempts", async () => {
  const rootDir = await createTempRoot();
  try {
    await seedSession(rootDir, "session-tl");
    const attempt = await getLatestAttempt(rootDir, "session-tl", "turn-2");
    assert.equal(attempt, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("getLatestAttempt returns null for missing session", async () => {
  const rootDir = await createTempRoot();
  try {
    assert.equal(await getLatestAttempt(rootDir, "missing", "turn-1"), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listTurnEvents
// ---------------------------------------------------------------------------

test("listTurnEvents returns envelopes filtered by turnId in write order", async () => {
  const rootDir = await createTempRoot();
  try {
    await seedSession(rootDir, "session-tl");
    const writer = createSessionEventLogWriter(rootDir, "session-tl");
    const mkEnvelope = (turnId: string, kind: string) =>
      createSessionEvent({
        kind: "worker.attempt_progress" as const,
        sessionId: "session-tl",
        turnId,
        attemptId: "attempt-1",
        actor: "worker",
        payload: { attemptId: "attempt-1", status: "running", message: kind },
      });
    await writer.append(mkEnvelope("turn-1", "a"));
    await writer.append(mkEnvelope("turn-2", "b"));
    await writer.append(mkEnvelope("turn-1", "c"));
    await writer.close();

    const events = await listTurnEvents(rootDir, "session-tl", "turn-1");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.payload.message, "a");
    assert.equal(events[1]?.payload.message, "c");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listTurnEvents returns [] when event log is absent", async () => {
  const rootDir = await createTempRoot();
  try {
    const events = await listTurnEvents(rootDir, "session-nope", "turn-1");
    assert.deepEqual(events, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listTurnArtifacts
// ---------------------------------------------------------------------------

test("listTurnArtifacts returns records filtered by turnId", async () => {
  const rootDir = await createTempRoot();
  try {
    await appendArtifactRecord(rootDir, "session-tl", buildArtifact("turn-1", "result"));
    await appendArtifactRecord(rootDir, "session-tl", buildArtifact("turn-2", "log"));
    await appendArtifactRecord(rootDir, "session-tl", buildArtifact("turn-1", "dispatch"));

    const artifacts = await listTurnArtifacts(rootDir, "session-tl", "turn-1");
    assert.equal(artifacts.length, 2);
    assert.deepEqual(
      artifacts.map((a) => a.kind),
      ["result", "dispatch"],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listTurnArtifacts returns [] when artifacts.ndjson is missing", async () => {
  const rootDir = await createTempRoot();
  try {
    const artifacts = await listTurnArtifacts(rootDir, "session-tl", "turn-1");
    assert.deepEqual(artifacts, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadEventLog
// ---------------------------------------------------------------------------

test("loadEventLog separates good envelopes from malformed lines", async () => {
  const rootDir = await createTempRoot();
  try {
    const writer = createSessionEventLogWriter(rootDir, "session-log");
    await writer.append(
      createSessionEvent({
        kind: "host.dispatch_started",
        sessionId: "session-log",
        actor: "host",
        payload: {
          attemptId: "a1",
          goal: "g",
          mode: "plan" as const,
          assumeDangerousSkipPermissions: false,
        },
      }),
    );
    await writer.close();
    // Manually append a malformed line.
    const { eventLogFilePath } = await import("../../src/host/eventLogWriter.js");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(eventLogFilePath(rootDir, "session-log"), "}{bad\n");

    const loaded = await loadEventLog(rootDir, "session-log");
    assert.equal(loaded.envelopes.length, 1);
    assert.equal(loaded.malformedLineCount, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listSessionSummaries
// ---------------------------------------------------------------------------

test("listSessionSummaries returns entries sorted newest-first", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-old",
      goal: "old",
      repoRoot: "/tmp",
      assumeDangerousSkipPermissions: false,
      updatedAt: "2026-04-14T00:00:00.000Z",
    });
    await store.createSession({
      sessionId: "session-new",
      goal: "new",
      repoRoot: "/tmp",
      assumeDangerousSkipPermissions: false,
      updatedAt: "2026-04-15T00:00:00.000Z",
    });

    const summaries = await listSessionSummaries(rootDir);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0]!.sessionId, "session-new");
    assert.equal(summaries[1]!.sessionId, "session-old");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listSessionSummaries returns [] when no sessions exist", async () => {
  const rootDir = await createTempRoot();
  try {
    const summaries = await listSessionSummaries(rootDir);
    assert.deepEqual(summaries, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
