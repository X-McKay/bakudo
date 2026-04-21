import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  SESSION_INDEX_SCHEMA_VERSION,
  loadSessionIndex,
  sessionIndexPath,
} from "../../src/host/sessionIndex.js";
import { SessionStore } from "../../src/sessionStore.js";

const createTempRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "bakudo-index-persist-"));

test("saveSession persists the summary index to .bakudo/sessions/index.json", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-persist",
      goal: "persist me",
      repoRoot: ".",
      status: "planned",
      createdAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:00.000Z",
    });

    const indexFile = sessionIndexPath(rootDir);
    assert.equal((await stat(indexFile)).isFile(), true);
    const raw = JSON.parse(await readFile(indexFile, "utf8")) as {
      schemaVersion: number;
      entries: Array<{ sessionId: string; status: string; title: string }>;
    };
    assert.equal(raw.schemaVersion, SESSION_INDEX_SCHEMA_VERSION);
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0]?.sessionId, "session-persist");
    assert.equal(raw.entries[0]?.title, "persist me");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listSessions reads the fast-path index without touching session directories", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-fastpath",
      goal: "fast",
      repoRoot: ".",
      createdAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:00.000Z",
    });

    // Corrupt the on-disk session.json. If listSessions were still scanning
    // directories, it would either drop this row or throw; because the index
    // already holds the summary, it remains visible.
    const paths = store.paths("session-fastpath");
    await writeFile(paths.sessionFile, "{not-json", "utf8");

    const summaries = await store.listSessions();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.sessionId, "session-fastpath");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listSessions rebuilds the index from a directory scan when the file is missing", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-rebuild-old",
      goal: "older",
      repoRoot: ".",
      createdAt: "2026-04-14T09:00:00.000Z",
      updatedAt: "2026-04-14T09:00:00.000Z",
    });
    await store.createSession({
      sessionId: "session-rebuild-new",
      goal: "newer",
      repoRoot: ".",
      createdAt: "2026-04-14T12:00:00.000Z",
      updatedAt: "2026-04-14T12:00:00.000Z",
    });

    // Simulate index corruption or an external delete. The next listSessions
    // must fall back to a directory scan, rebuild the index on disk, and
    // return the same entries sorted newest-first.
    await rm(sessionIndexPath(rootDir));
    assert.equal(await loadSessionIndex(rootDir), null);

    const summaries = await store.listSessions();
    assert.deepEqual(
      summaries.map((entry) => entry.sessionId),
      ["session-rebuild-new", "session-rebuild-old"],
    );

    const reloaded = await loadSessionIndex(rootDir);
    assert.ok(reloaded);
    assert.equal(reloaded.entries.length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listSessions treats a malformed index as missing and rebuilds in place", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-malformed",
      goal: "malformed cache",
      repoRoot: ".",
      createdAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:00.000Z",
    });

    await writeFile(sessionIndexPath(rootDir), "{this is not json", "utf8");

    const summaries = await store.listSessions();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.sessionId, "session-malformed");

    const reloaded = await loadSessionIndex(rootDir);
    assert.ok(reloaded);
    assert.equal(reloaded.entries.length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listSessions returns an empty list when there are no sessions at all", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    const summaries = await store.listSessions();
    assert.deepEqual(summaries, []);
    // No rebuild warning expected: a fresh repo without any session dirs
    // shouldn't write an index file either.
    assert.equal(await loadSessionIndex(rootDir), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
