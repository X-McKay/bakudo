/**
 * Phase 6 W4 — coverage for the new read/remove APIs added to both v1 and v2
 * artifact stores. Existing `artifactStore.test.ts` covers the unchanged
 * append/list paths; this file adds focused tests for the additive surface.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../../src/artifactStore.js";
import {
  appendArtifactRecord,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactsFilePath,
  listArtifactRecords,
  listArtifactsForSession,
  removeArtifactFile,
  removeArtifactRecords,
  type ArtifactRecord,
} from "../../src/host/artifactStore.js";
import { ArtifactPersistenceError } from "../../src/host/errors.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-artifact-cleanup-"));

const buildRecord = (overrides: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactId: "artifact-test",
  sessionId: "session-test",
  turnId: "turn-1",
  attemptId: "attempt-1",
  kind: "log",
  name: "x.log",
  path: "artifacts/x.log",
  createdAt: "2026-04-15T00:00:00.000Z",
  ...overrides,
});

// ---------------------------------------------------------------------------
// listArtifactsForSession (v2 alias)
// ---------------------------------------------------------------------------

test("listArtifactsForSession is a verb-shaped alias of listArtifactRecords", async () => {
  const root = await createTempRoot();
  try {
    const r = buildRecord({ artifactId: "a-1" });
    await appendArtifactRecord(root, "session-test", r);
    const viaAlias = await listArtifactsForSession(root, "session-test");
    const viaOriginal = await listArtifactRecords(root, "session-test");
    assert.deepEqual(viaAlias, viaOriginal);
    assert.equal(viaAlias.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// removeArtifactRecords (v2 prune)
// ---------------------------------------------------------------------------

test("removeArtifactRecords prunes only the matching artifactIds, atomic rewrite preserves order", async () => {
  const root = await createTempRoot();
  try {
    const ids = ["a-1", "a-2", "a-3"];
    for (const id of ids) {
      await appendArtifactRecord(root, "session-test", buildRecord({ artifactId: id }));
    }
    await removeArtifactRecords(root, "session-test", ["a-2"]);
    const remaining = await listArtifactRecords(root, "session-test");
    assert.deepEqual(
      remaining.map((r) => r.artifactId),
      ["a-1", "a-3"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeArtifactRecords with empty id list is a no-op", async () => {
  const root = await createTempRoot();
  try {
    await appendArtifactRecord(root, "session-test", buildRecord({ artifactId: "a-1" }));
    await removeArtifactRecords(root, "session-test", []);
    const remaining = await listArtifactRecords(root, "session-test");
    assert.equal(remaining.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeArtifactRecords tolerates a missing file (ENOENT)", async () => {
  const root = await createTempRoot();
  try {
    await removeArtifactRecords(root, "session-missing", ["a-1"]);
    // No throw — no file to read back.
    const path = artifactsFilePath(root, "session-missing");
    await assert.rejects(() => stat(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// removeArtifactFile
// ---------------------------------------------------------------------------

test("removeArtifactFile deletes the on-disk file", async () => {
  const root = await createTempRoot();
  try {
    const path = join(root, "stray.tmp");
    await writeFile(path, "x", "utf8");
    await removeArtifactFile(path);
    await assert.rejects(() => stat(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeArtifactFile tolerates ENOENT silently", async () => {
  const root = await createTempRoot();
  try {
    await removeArtifactFile(join(root, "nope.tmp"));
    // No throw expected.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v1 ArtifactStore: listArtifactsForSession + removeArtifact
// ---------------------------------------------------------------------------

test("ArtifactStore.listArtifactsForSession aliases listArtifacts", async () => {
  const root = await createTempRoot();
  try {
    const store = new ArtifactStore(root);
    await store.registerArtifact({
      artifactId: "v1-a",
      sessionId: "session-test",
      kind: "log",
      name: "x.log",
      path: join(root, "session-test/artifacts/x.log"),
    });
    const viaAlias = await store.listArtifactsForSession("session-test");
    const viaOriginal = await store.listArtifacts("session-test");
    assert.deepEqual(viaAlias, viaOriginal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore.removeArtifact unlinks file + prunes registry", async () => {
  const root = await createTempRoot();
  try {
    const store = new ArtifactStore(root);
    const artifactsDir = join(root, "session-test", "artifacts");
    const filePath = join(artifactsDir, "x.log");
    await writeFile(filePath, "data", "utf8").catch(async () => {
      // First write fails because dir absent — registerArtifact creates it.
    });
    await store.registerArtifact({
      artifactId: "v1-a",
      sessionId: "session-test",
      kind: "log",
      name: "x.log",
      path: filePath,
    });
    await writeFile(filePath, "data", "utf8");
    await store.removeArtifact("session-test", filePath);
    await assert.rejects(() => stat(filePath));
    const remaining = await store.listArtifacts("session-test");
    assert.equal(remaining.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ArtifactStore.removeArtifact wraps non-ENOENT failures in ArtifactPersistenceError", async () => {
  // Force a failure by passing a path inside a non-existent unwritable dir
  // when the registry rewrite tries to create it. We simulate by creating a
  // file-as-dir collision: write a file at the would-be artifact-dir path so
  // the registry's writeJsonAtomic mkdir fails loudly.
  const root = await createTempRoot();
  try {
    const store = new ArtifactStore(root);
    // Register first so the registry exists, then sabotage by writing a
    // file at the registry path (so subsequent rewrite fails).
    await store.registerArtifact({
      artifactId: "v1-bad",
      sessionId: "session-bad",
      kind: "log",
      name: "x.log",
      path: join(root, "session-bad", "artifacts", "x.log"),
    });
    // Replace the registry file with a directory so atomic rename fails.
    const indexPath = join(root, "session-bad", "artifacts", "index.json");
    await rm(indexPath, { force: true });
    await writeFile(indexPath, "[]", "utf8");
    // Make the artifacts dir read-only so rewrite of the registry fails.
    // Skip this check on platforms where chmod isn't reliable; just assert
    // the wrapped-error contract via a path that will fail unlink unusually.
    // Use a known invalid path component on POSIX (NUL char) to force EINVAL.
    await assert.rejects(
      () => store.removeArtifact("session-bad", "/proc/1/root/\u0000/x"),
      (err) => err instanceof ArtifactPersistenceError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
