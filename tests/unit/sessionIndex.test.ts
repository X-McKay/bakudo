import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  SESSION_INDEX_SCHEMA_VERSION,
  buildIndexEntryFromSession,
  loadSessionIndex,
  sessionIndexPath,
  sortIndexEntries,
  type SessionIndexEntry,
} from "../../src/host/sessionIndex.js";
import type { SessionRecord } from "../../src/sessionTypes.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-index-"));

const baseSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  schemaVersion: 2,
  sessionId: "session-test-1",
  repoRoot: "/tmp/repo",
  title: "sample session",
  goal: "sample session",
  status: "completed",
  assumeDangerousSkipPermissions: false,
  turns: [],
  createdAt: "2026-04-14T10:00:00.000Z",
  updatedAt: "2026-04-14T11:00:00.000Z",
  ...overrides,
});

test("buildIndexEntryFromSession extracts latestTurnId and review from final turn", () => {
  const session = baseSession({
    turns: [
      {
        turnId: "turn-1",
        prompt: "first turn",
        mode: "standard",
        status: "completed",
        attempts: [],
        createdAt: "2026-04-14T10:00:00.000Z",
        updatedAt: "2026-04-14T10:30:00.000Z",
      },
      {
        turnId: "turn-2",
        prompt: "second turn",
        mode: "plan",
        status: "completed",
        attempts: [],
        createdAt: "2026-04-14T10:31:00.000Z",
        updatedAt: "2026-04-14T11:00:00.000Z",
        latestReview: {
          reviewId: "review-1",
          attemptId: "attempt-1",
          outcome: "success",
          action: "accept",
          reviewedAt: "2026-04-14T11:00:00.000Z",
        },
      },
    ],
  });

  const entry = buildIndexEntryFromSession(session);

  assert.equal(entry.schemaVersion, SESSION_INDEX_SCHEMA_VERSION);
  assert.equal(entry.sessionId, "session-test-1");
  assert.equal(entry.title, "sample session");
  assert.equal(entry.status, "completed");
  assert.equal(entry.latestTurnId, "turn-2");
  assert.equal(entry.lastMode, "plan");
  assert.equal(entry.latestReviewedOutcome, "success");
  assert.equal(entry.latestReviewedAction, "accept");
});

test("buildIndexEntryFromSession omits review fields when no turn has landed", () => {
  const entry = buildIndexEntryFromSession(baseSession({ status: "draft" }));
  assert.equal(entry.latestTurnId, undefined);
  assert.equal(entry.latestReviewedOutcome, undefined);
  assert.equal(entry.latestReviewedAction, undefined);
  assert.equal(entry.lastMode, "standard");
});

test("buildIndexEntryFromSession coerces legacy mode tokens to composer modes", () => {
  const entry = buildIndexEntryFromSession(
    baseSession({
      turns: [
        {
          turnId: "turn-1",
          prompt: "legacy",
          mode: "build",
          status: "completed",
          attempts: [],
          createdAt: "2026-04-14T10:00:00.000Z",
          updatedAt: "2026-04-14T10:00:00.000Z",
        },
      ],
    }),
  );
  assert.equal(entry.lastMode, "standard");
});

test("sortIndexEntries orders newest updatedAt first with stable sessionId tie-break", () => {
  const a: SessionIndexEntry = {
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    sessionId: "session-a",
    title: "",
    repoRoot: ".",
    status: "completed",
    lastMode: "standard",
    updatedAt: "2026-04-14T10:00:00.000Z",
  };
  const b: SessionIndexEntry = {
    ...a,
    sessionId: "session-b",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };
  const c: SessionIndexEntry = {
    ...a,
    sessionId: "session-c",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };

  const sorted = sortIndexEntries([a, c, b]);

  assert.deepEqual(
    sorted.map((entry) => entry.sessionId),
    ["session-b", "session-c", "session-a"],
  );
});

test("sortIndexEntries does not mutate the input array", () => {
  const a: SessionIndexEntry = {
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    sessionId: "session-a",
    title: "",
    repoRoot: ".",
    status: "completed",
    lastMode: "standard",
    updatedAt: "2026-04-14T10:00:00.000Z",
  };
  const b: SessionIndexEntry = {
    ...a,
    sessionId: "session-b",
    updatedAt: "2026-04-14T12:00:00.000Z",
  };
  const input = [a, b];
  sortIndexEntries(input);
  assert.deepEqual(
    input.map((entry) => entry.sessionId),
    ["session-a", "session-b"],
  );
});

test("loadSessionIndex returns null when index.json does not exist", async () => {
  const rootDir = await createTempRoot();
  try {
    const result = await loadSessionIndex(rootDir);
    assert.equal(result, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadSessionIndex returns null for malformed JSON", async () => {
  const rootDir = await createTempRoot();
  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(sessionIndexPath(rootDir), "{not json", "utf8");
    const result = await loadSessionIndex(rootDir);
    assert.equal(result, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadSessionIndex returns null when schemaVersion is unknown", async () => {
  const rootDir = await createTempRoot();
  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      sessionIndexPath(rootDir),
      JSON.stringify({ schemaVersion: 99, entries: [] }),
      "utf8",
    );
    const result = await loadSessionIndex(rootDir);
    assert.equal(result, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadSessionIndex returns null when an entry fails shape validation", async () => {
  const rootDir = await createTempRoot();
  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      sessionIndexPath(rootDir),
      JSON.stringify({
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        entries: [{ sessionId: "missing-required-fields" }],
      }),
      "utf8",
    );
    const result = await loadSessionIndex(rootDir);
    assert.equal(result, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadSessionIndex returns sorted entries for a valid file", async () => {
  const rootDir = await createTempRoot();
  try {
    await mkdir(rootDir, { recursive: true });
    const entries: SessionIndexEntry[] = [
      {
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        sessionId: "old",
        title: "old",
        repoRoot: ".",
        status: "completed",
        lastMode: "standard",
        updatedAt: "2026-04-14T09:00:00.000Z",
      },
      {
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        sessionId: "new",
        title: "new",
        repoRoot: ".",
        status: "running",
        lastMode: "autopilot",
        updatedAt: "2026-04-14T12:00:00.000Z",
      },
    ];
    await writeFile(
      sessionIndexPath(rootDir),
      JSON.stringify({ schemaVersion: SESSION_INDEX_SCHEMA_VERSION, entries }),
      "utf8",
    );
    const result = await loadSessionIndex(rootDir);
    assert.ok(result);
    assert.equal(result.schemaVersion, SESSION_INDEX_SCHEMA_VERSION);
    assert.deepEqual(
      result.entries.map((entry) => entry.sessionId),
      ["new", "old"],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadSessionIndex returns null when the top-level entries field is not an array", async () => {
  const rootDir = await createTempRoot();
  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      sessionIndexPath(rootDir),
      JSON.stringify({ schemaVersion: SESSION_INDEX_SCHEMA_VERSION, entries: "nope" }),
      "utf8",
    );
    const result = await loadSessionIndex(rootDir);
    assert.equal(result, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
