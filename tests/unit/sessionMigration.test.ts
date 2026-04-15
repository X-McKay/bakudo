import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SessionStore, loadSessionRecord } from "../../src/sessionStore.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../src/sessionTypes.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-migrate-"));

test("loadSessionRecord: v2 record passes through unchanged", () => {
  const raw = {
    schemaVersion: 2,
    sessionId: "session-1",
    repoRoot: "/tmp/repo",
    goal: "hello",
    status: "planned",
    assumeDangerousSkipPermissions: false,
    turns: [
      {
        turnId: "turn-1",
        prompt: "do a thing",
        mode: "build",
        status: "queued",
        attempts: [],
        createdAt: "2026-04-14T12:00:00.000Z",
        updatedAt: "2026-04-14T12:00:00.000Z",
      },
    ],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };
  const loaded = loadSessionRecord(raw);
  assert.equal(loaded.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
  assert.equal(loaded.sessionId, "session-1");
  assert.equal(loaded.repoRoot, "/tmp/repo");
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.turns[0]?.turnId, "turn-1");
});

test("loadSessionRecord: v1 record migrates to v2 with repoRoot '.'", () => {
  const raw = {
    schemaVersion: 1,
    sessionId: "session-legacy",
    goal: "the legacy goal",
    status: "completed",
    assumeDangerousSkipPermissions: true,
    tasks: [
      {
        taskId: "task-1",
        status: "succeeded",
        request: {
          schemaVersion: 1,
          taskId: "task-1",
          sessionId: "session-legacy",
          goal: "the legacy goal",
          mode: "build",
          assumeDangerousSkipPermissions: true,
        },
        result: {
          schemaVersion: 1,
          taskId: "task-1",
          sessionId: "session-legacy",
          status: "succeeded",
          summary: "done",
          finishedAt: "2026-04-14T12:10:00.000Z",
        },
        lastMessage: "ok",
      },
    ],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:10:00.000Z",
  };
  const loaded = loadSessionRecord(raw);
  assert.equal(loaded.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
  assert.equal(loaded.repoRoot, ".");
  assert.equal(loaded.sessionId, "session-legacy");
  assert.equal(loaded.turns.length, 1);
  const turn = loaded.turns[0]!;
  assert.equal(turn.turnId, "turn-1");
  assert.equal(turn.prompt, "the legacy goal");
  assert.equal(turn.mode, "build");
  assert.equal(turn.status, "completed");
  assert.equal(turn.attempts.length, 1);
  assert.equal(turn.attempts[0]?.attemptId, "task-1");
  assert.equal(turn.attempts[0]?.status, "succeeded");
  assert.equal(turn.attempts[0]?.result?.summary, "done");
  assert.equal(turn.attempts[0]?.lastMessage, "ok");
});

test("loadSessionRecord: v1 record with no tasks yields empty turns", () => {
  const raw = {
    schemaVersion: 1,
    sessionId: "session-empty",
    goal: "nothing yet",
    status: "planned",
    assumeDangerousSkipPermissions: false,
    tasks: [],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };
  const loaded = loadSessionRecord(raw);
  assert.equal(loaded.turns.length, 0);
});

test("loadSessionRecord: v1 record without schemaVersion (absent) also migrates", () => {
  const raw = {
    sessionId: "session-noversion",
    goal: "legacy no version",
    status: "planned",
    assumeDangerousSkipPermissions: false,
    tasks: [],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };
  const loaded = loadSessionRecord(raw);
  assert.equal(loaded.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
  assert.equal(loaded.repoRoot, ".");
});

test("loadSessionRecord: unrecognized shape throws", () => {
  assert.throws(() => loadSessionRecord({ foo: "bar" }), /unrecognized session record/);
  assert.throws(() => loadSessionRecord(null), /unrecognized session record/);
});

test("SessionStore loadSession migrates a v1 file on disk", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionDir = join(rootDir, "session-old");
    await mkdir(sessionDir, { recursive: true });
    const v1 = {
      schemaVersion: 1,
      sessionId: "session-old",
      goal: "migrate me",
      status: "completed",
      assumeDangerousSkipPermissions: false,
      tasks: [
        {
          taskId: "task-1",
          status: "succeeded",
          lastMessage: "done",
        },
      ],
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:10:00.000Z",
    };
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(v1, null, 2), "utf8");

    const store = new SessionStore(rootDir);
    const loaded = await store.loadSession("session-old");
    assert.ok(loaded);
    assert.equal(loaded.schemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
    assert.equal(loaded.repoRoot, ".");
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0]?.attempts.length, 1);
    assert.equal(loaded.turns[0]?.attempts[0]?.attemptId, "task-1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("SessionStore upsertTurn appends and replaces turns", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-turns",
      goal: "multi turn",
      repoRoot: "/tmp/r",
      assumeDangerousSkipPermissions: false,
      status: "planned",
    });
    await store.upsertTurn("session-turns", {
      turnId: "turn-1",
      prompt: "first",
      mode: "build",
      status: "queued",
      attempts: [],
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    });
    await store.upsertTurn("session-turns", {
      turnId: "turn-2",
      prompt: "second",
      mode: "plan",
      status: "queued",
      attempts: [],
      createdAt: "2026-04-14T12:05:00.000Z",
      updatedAt: "2026-04-14T12:05:00.000Z",
    });
    const loaded = await store.loadSession("session-turns");
    assert.ok(loaded);
    assert.equal(loaded.turns.length, 2);
    assert.equal(loaded.turns[0]?.turnId, "turn-1");
    assert.equal(loaded.turns[1]?.turnId, "turn-2");

    // replace turn-1
    await store.upsertTurn("session-turns", {
      turnId: "turn-1",
      prompt: "first (updated)",
      mode: "build",
      status: "completed",
      attempts: [],
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:10:00.000Z",
    });
    const reloaded = await store.loadSession("session-turns");
    assert.equal(reloaded?.turns.length, 2);
    assert.equal(reloaded?.turns[0]?.prompt, "first (updated)");
    assert.equal(reloaded?.turns[0]?.status, "completed");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("SessionStore upsertAttempt appends attempts under the named turn", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-attempts",
      goal: "attempts",
      repoRoot: ".",
      assumeDangerousSkipPermissions: false,
      status: "planned",
      turns: [
        {
          turnId: "turn-1",
          prompt: "do it",
          mode: "build",
          status: "queued",
          attempts: [],
          createdAt: "2026-04-14T12:00:00.000Z",
          updatedAt: "2026-04-14T12:00:00.000Z",
        },
      ],
    });
    await store.upsertAttempt("session-attempts", "turn-1", {
      attemptId: "attempt-a",
      status: "running",
    });
    await store.upsertAttempt("session-attempts", "turn-1", {
      attemptId: "attempt-b",
      status: "queued",
    });
    // replace attempt-a
    await store.upsertAttempt("session-attempts", "turn-1", {
      attemptId: "attempt-a",
      status: "succeeded",
    });

    const loaded = await store.loadSession("session-attempts");
    assert.equal(loaded?.turns.length, 1);
    assert.equal(loaded?.turns[0]?.attempts.length, 2);
    assert.equal(loaded?.turns[0]?.attempts[0]?.attemptId, "attempt-a");
    assert.equal(loaded?.turns[0]?.attempts[0]?.status, "succeeded");
    assert.equal(loaded?.turns[0]?.attempts[1]?.attemptId, "attempt-b");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
