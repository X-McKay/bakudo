import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendArtifactRecord,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactsFilePath,
  listArtifactRecords,
  type ArtifactRecord,
} from "../../src/host/artifactStore.js";
import {
  cleanupSession,
  computeStorageTotalBytes,
  formatCleanupReport,
  parseCleanupArgs,
  runCleanup,
} from "../../src/host/commands/cleanup.js";
import { SessionStore } from "../../src/sessionStore.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-cleanup-support-"));

const buildMinimalSession = async (
  rootDir: string,
  sessionId: string,
): Promise<{ sessionDir: string }> => {
  const store = new SessionStore(rootDir);
  await store.createSession({
    sessionId,
    goal: "g",
    repoRoot: "/tmp/repo",
    status: "completed",
    turns: [
      {
        turnId: "turn-1",
        prompt: "p",
        mode: "build",
        status: "completed",
        attempts: [
          { attemptId: "attempt-1", status: "failed" },
          { attemptId: "attempt-2", status: "succeeded" },
        ],
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:01:00.000Z",
      },
    ],
  });
  const { sessionDir, artifactsDir } = store.paths(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const record: ArtifactRecord = {
    schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
    artifactId: "artifact-x",
    sessionId,
    turnId: "turn-1",
    attemptId: "attempt-1",
    kind: "log",
    name: "x.log",
    path: "artifacts/x.log",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await appendArtifactRecord(rootDir, sessionId, record);
  await writeFile(join(sessionDir, "artifacts/x.log"), "data\n", "utf8");
  return { sessionDir };
};

// ---------------------------------------------------------------------------
// parseCleanupArgs
// ---------------------------------------------------------------------------

test("parseCleanupArgs: empty argv → dryRun=false, no overrides", () => {
  const result = parseCleanupArgs([]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.args.dryRun, false);
    assert.equal(result.args.olderThanMs, undefined);
    assert.equal(result.args.sessionId, undefined);
  }
});

test("parseCleanupArgs: --dry-run flips dryRun", () => {
  const result = parseCleanupArgs(["--dry-run"]);
  assert.equal(result.ok && result.args.dryRun, true);
});

test("parseCleanupArgs: --older-than 30d resolves to 30 days in ms", () => {
  const result = parseCleanupArgs(["--older-than", "30d"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.args.olderThanMs, 30 * 86_400_000);
});

test("parseCleanupArgs: --older-than=7d (=) form supported", () => {
  const result = parseCleanupArgs(["--older-than=7d"]);
  assert.equal(result.ok && result.args.olderThanMs, 7 * 86_400_000);
});

test("parseCleanupArgs: --session pulls the next token", () => {
  const result = parseCleanupArgs(["--session", "session-x"]);
  assert.equal(result.ok && result.args.sessionId, "session-x");
});

test("parseCleanupArgs: rejects unknown flag", () => {
  const result = parseCleanupArgs(["--what"]);
  assert.equal(result.ok, false);
});

test("parseCleanupArgs: rejects bad duration", () => {
  const result = parseCleanupArgs(["--older-than", "1y"]);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// formatCleanupReport
// ---------------------------------------------------------------------------

test("formatCleanupReport produces a non-empty header line set", () => {
  const report = {
    policy: {
      intermediateMaxAgeMs: 86_400_000,
      intermediateKinds: ["log"] as const,
      protectedKinds: ["result"] as const,
    },
    dryRun: true,
    scannedSessions: 0,
    scannedArtifacts: 0,
    eligible: [],
    removed: [],
    totalBytes: 0,
    errors: [],
  };
  const lines = formatCleanupReport(report);
  assert.ok(lines.length >= 3);
  assert.match(lines[0]!, /bakudo cleanup/u);
});

// ---------------------------------------------------------------------------
// Orphan files
// ---------------------------------------------------------------------------

test("cleanup detects orphan files in the artifacts dir", async () => {
  const root = await createTempRoot();
  try {
    const { sessionDir } = await buildMinimalSession(root, "session-orphan");
    const orphanPath = join(sessionDir, "artifacts/stray.tmp");
    await writeFile(orphanPath, "leftover\n", "utf8");
    const report = await runCleanup(root, { dryRun: true });
    const orphans = report.eligible.filter((e) => e.reason === "orphan_temp_file");
    assert.ok(orphans.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// computeStorageTotalBytes (used by `bakudo doctor`)
// ---------------------------------------------------------------------------

test("computeStorageTotalBytes sums every on-disk artifact across sessions", async () => {
  const root = await createTempRoot();
  try {
    await buildMinimalSession(root, "session-A");
    await buildMinimalSession(root, "session-B");
    const total = await computeStorageTotalBytes(root);
    assert.ok(total > 0, "should sum >0 bytes from fixture artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computeStorageTotalBytes returns 0 for a missing storage root", async () => {
  const root = join(tmpdir(), `bakudo-cleanup-missing-${Date.now()}`);
  const total = await computeStorageTotalBytes(root);
  assert.equal(total, 0);
});

// ---------------------------------------------------------------------------
// cleanupSession returns errors but doesn't throw on permission failures
// ---------------------------------------------------------------------------

test("cleanupSession aggregates errors rather than throwing on non-protected failures", async () => {
  const root = await createTempRoot();
  try {
    await buildMinimalSession(root, "session-empty");
    // Manually delete the underlying file so the cleanup driver sees a
    // record without a matching file. ENOENT-tolerated path inside the
    // remove helper means no errors should escape.
    const filePath = artifactsFilePath(root, "session-empty");
    const targets = await listArtifactRecords(root, "session-empty");
    for (const t of targets) {
      try {
        await rm(join(root, "session-empty", t.path), { force: true });
      } catch {
        /* tolerated */
      }
    }
    assert.ok(filePath.length > 0);
    const result = await cleanupSession(root, "session-empty", { dryRun: false });
    assert.equal(result.errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
