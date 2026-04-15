import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ArtifactStore } from "../../src/artifactStore.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../src/sessionTypes.js";
import type { TaskProgressEvent, TaskResult } from "../../src/protocol.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-store-"));

test("SessionStore computes a stable layout and persists session state", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    const sessionId = "session/one:alpha";
    const paths = store.paths(sessionId);
    const safeSessionDir = join(rootDir, "session_one_alpha");

    assert.equal(paths.sessionDir, safeSessionDir);
    assert.equal(paths.sessionFile, join(safeSessionDir, "session.json"));
    assert.equal(paths.eventsFile, join(safeSessionDir, "events.ndjson"));
    assert.equal(paths.artifactsDir, join(safeSessionDir, "artifacts"));
    assert.equal(paths.artifactsFile, join(safeSessionDir, "artifacts", "index.json"));

    const created = await store.createSession({
      sessionId,
      goal: "ship the host-side persistence scaffold",
      repoRoot: ".",
      assumeDangerousSkipPermissions: true,
      status: "planned",
      createdAt: "2026-04-13T10:00:00.000Z",
    });

    assert.equal(created.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
    assert.equal(created.goal, "ship the host-side persistence scaffold");
    assert.equal(created.status, "planned");

    const firstResult = {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      taskId: "task-1",
      sessionId,
      status: "succeeded",
      summary: "implemented the scaffold",
      finishedAt: "2026-04-13T10:05:00.000Z",
    } satisfies TaskResult;

    await store.upsertTask(sessionId, {
      taskId: "task-1",
      status: "running",
      lastMessage: "starting",
    });
    await store.upsertTask(sessionId, {
      taskId: "task-1",
      status: "succeeded",
      result: firstResult,
      lastMessage: "done",
    });

    const eventOne = {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      kind: "task.started",
      taskId: "task-1",
      sessionId,
      status: "running",
      message: "sandbox launched",
      timestamp: "2026-04-13T10:01:00.000Z",
    } satisfies TaskProgressEvent;
    const eventTwo = {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      kind: "task.completed",
      taskId: "task-1",
      sessionId,
      status: "succeeded",
      message: "task finished",
      timestamp: "2026-04-13T10:05:00.000Z",
    } satisfies TaskProgressEvent;

    await store.appendTaskEvent(sessionId, eventOne);
    await store.appendTaskEvent(sessionId, eventTwo);

    const loaded = await store.loadSession(sessionId);
    assert.ok(loaded);
    assert.equal(loaded.sessionId, sessionId);
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0]?.attempts.length, 1);
    assert.equal(loaded.turns[0]?.attempts[0]?.status, "succeeded");
    assert.equal(loaded.turns[0]?.attempts[0]?.result?.summary, "implemented the scaffold");

    const events = await store.readTaskEvents(sessionId);
    assert.deepEqual(events, [eventOne, eventTwo]);

    assert.equal((await stat(paths.sessionFile)).isFile(), true);
    assert.equal((await stat(paths.eventsFile)).isFile(), true);

    const onDiskEvents = await readFile(paths.eventsFile, "utf8");
    assert.equal(onDiskEvents.trim().split("\n").length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("SessionStore lists sessions newest updated first with stable tie-breaking", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await mkdir(join(rootDir, "notes"), { recursive: true });

    await store.createSession({
      sessionId: "session/old",
      goal: "oldest session",
      repoRoot: ".",
      assumeDangerousSkipPermissions: true,
      createdAt: "2026-04-13T09:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
    });
    await store.createSession({
      sessionId: "session/tie-z",
      goal: "same timestamp, later id",
      repoRoot: ".",
      assumeDangerousSkipPermissions: true,
      createdAt: "2026-04-13T11:00:00.000Z",
      updatedAt: "2026-04-13T11:00:00.000Z",
    });
    await store.createSession({
      sessionId: "session/tie-a",
      goal: "same timestamp, earlier id",
      repoRoot: ".",
      assumeDangerousSkipPermissions: true,
      createdAt: "2026-04-13T11:00:00.000Z",
      updatedAt: "2026-04-13T11:00:00.000Z",
    });
    await store.createSession({
      sessionId: "session/latest",
      goal: "most recent session",
      repoRoot: ".",
      assumeDangerousSkipPermissions: true,
      createdAt: "2026-04-13T12:00:00.000Z",
      updatedAt: "2026-04-13T12:30:00.000Z",
    });

    const sessions = await store.listSessions();

    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["session/latest", "session/tie-a", "session/tie-z", "session/old"],
    );
    assert.equal(sessions[0]?.updatedAt, "2026-04-13T12:30:00.000Z");
    assert.equal(sessions[1]?.updatedAt, "2026-04-13T11:00:00.000Z");
    assert.equal(sessions[2]?.updatedAt, "2026-04-13T11:00:00.000Z");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("ArtifactStore registers and upserts session artifacts", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session/one:alpha";
    const store = new ArtifactStore(rootDir);

    assert.equal(store.artifactDir(sessionId), join(rootDir, "session_one_alpha", "artifacts"));

    const firstArtifact = await store.registerArtifact({
      artifactId: "artifact-1",
      sessionId,
      taskId: "task-1",
      kind: "patch",
      name: "workspace.patch",
      path: "artifacts/workspace.patch",
      createdAt: "2026-04-13T10:06:00.000Z",
      metadata: { reviewed: false },
    });

    const secondArtifact = await store.registerArtifact({
      artifactId: "artifact-1",
      sessionId,
      taskId: "task-1",
      kind: "patch",
      name: "workspace.patch",
      path: "artifacts/workspace-reviewed.patch",
      createdAt: "2026-04-13T10:07:00.000Z",
      metadata: { reviewed: true },
    });

    assert.equal(firstArtifact.path, "artifacts/workspace.patch");
    assert.equal(secondArtifact.path, "artifacts/workspace-reviewed.patch");

    const artifacts = await store.listArtifacts(sessionId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.path, "artifacts/workspace-reviewed.patch");
    assert.equal(artifacts[0]?.metadata?.reviewed, true);

    const artifactFile = join(rootDir, "session_one_alpha", "artifacts", "index.json");
    assert.equal((await stat(artifactFile)).isFile(), true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
