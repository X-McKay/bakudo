import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendArtifactRecord,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  listArtifactRecords,
  type ArtifactRecord,
} from "../../src/host/artifactStore.js";
import { PROTECTED_FILE_BASENAMES, runCleanup } from "../../src/host/commands/cleanup.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { SessionRecord } from "../../src/sessionTypes.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-cleanup-"));

type FixtureOptions = {
  sessionId?: string;
  status?: SessionRecord["status"];
  attempts?: ReadonlyArray<{ attemptId: string; status: "succeeded" | "failed" }>;
  records?: ReadonlyArray<Partial<ArtifactRecord>>;
  withReviewProvenanceApproval?: boolean;
};

const buildFixture = async (
  rootDir: string,
  options: FixtureOptions = {},
): Promise<{ sessionId: string; sessionDir: string }> => {
  const sessionId = options.sessionId ?? "session-cleanup";
  const status = options.status ?? "completed";
  const attempts = options.attempts ?? [
    { attemptId: "attempt-1", status: "failed" as const },
    { attemptId: "attempt-2", status: "succeeded" as const },
  ];

  const turn = {
    turnId: "turn-1",
    prompt: "p",
    mode: "build",
    status: status === "completed" ? ("completed" as const) : ("failed" as const),
    attempts: attempts.map((a) => ({ attemptId: a.attemptId, status: a.status })),
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:01:00.000Z",
    ...(options.withReviewProvenanceApproval === true
      ? {
          latestReview: {
            reviewId: "review-1",
            attemptId: attempts.at(-1)!.attemptId,
            outcome: "success" as const,
            action: "accept" as const,
            reviewedAt: "2026-04-15T00:01:00.000Z",
          },
        }
      : {}),
  };

  const store = new SessionStore(rootDir);
  await store.createSession({
    sessionId,
    goal: "fixture goal",
    repoRoot: "/tmp/repo",
    status,
    turns: [turn],
  });

  const { sessionDir, artifactsDir } = store.paths(sessionId);
  await mkdir(artifactsDir, { recursive: true });

  const records: ArtifactRecord[] =
    options.records !== undefined && options.records.length > 0
      ? options.records.map((r, idx) => ({
          schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
          artifactId: `artifact-${idx}`,
          sessionId,
          turnId: "turn-1",
          attemptId: attempts[0]!.attemptId,
          kind: "log",
          name: `worker-output-${idx}.log`,
          path: `artifacts/worker-output-${idx}.log`,
          createdAt: "2026-01-01T00:00:00.000Z",
          ...r,
        }))
      : [
          {
            schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
            artifactId: "artifact-superseded-log",
            sessionId,
            turnId: "turn-1",
            attemptId: "attempt-1",
            kind: "log",
            name: "worker-output.log",
            path: "artifacts/attempt-1-worker-output.log",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
            artifactId: "artifact-protected-result",
            sessionId,
            turnId: "turn-1",
            attemptId: "attempt-2",
            kind: "result",
            name: "result.json",
            path: "artifacts/attempt-2-result.json",
            createdAt: "2026-04-15T00:01:00.000Z",
          },
        ];

  for (const record of records) {
    await appendArtifactRecord(rootDir, sessionId, record);
    const filePath = join(sessionDir, record.path);
    await mkdir(join(sessionDir, "artifacts"), { recursive: true });
    await writeFile(filePath, `dummy contents for ${record.artifactId}\n`, "utf8");
  }

  if (options.withReviewProvenanceApproval === true) {
    await writeFile(
      join(sessionDir, "provenance.ndjson"),
      `${JSON.stringify({ provenanceId: "p-1", sessionId, turnId: "turn-1" })}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionDir, "approvals.ndjson"),
      `${JSON.stringify({ approvalId: "a-1", sessionId, turnId: "turn-1" })}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionDir, "transitions.ndjson"),
      `${JSON.stringify({ transitionId: "t-1", sessionId, turnId: "turn-1" })}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionDir, "events.ndjson"),
      `${JSON.stringify({ eventId: "e-1", sessionId, turnId: "turn-1", kind: "host.session_created" })}\n`,
      "utf8",
    );
  }

  return { sessionId, sessionDir };
};

// ---------------------------------------------------------------------------
// Hard rules — review / provenance / approval untouched
// ---------------------------------------------------------------------------

test("cleanup never deletes review/provenance/approval/session/event/transition files (Hard Rules 1+2)", async () => {
  const root = await createTempRoot();
  try {
    const { sessionId, sessionDir } = await buildFixture(root, {
      withReviewProvenanceApproval: true,
    });
    await runCleanup(root, { dryRun: false });

    // Each protected basename we wrote must still exist on disk.
    const wrote = new Set([
      "session.json",
      "provenance.ndjson",
      "approvals.ndjson",
      "transitions.ndjson",
      "events.ndjson",
      "artifacts.ndjson",
    ]);
    for (const basename of PROTECTED_FILE_BASENAMES) {
      if (!wrote.has(basename)) continue;
      const path = join(sessionDir, basename);
      try {
        await stat(path);
      } catch {
        assert.fail(`protected file removed: ${basename}`);
      }
    }

    // The session record (and therefore the only persisted review record)
    // must round-trip identically.
    const store = new SessionStore(root);
    const sessionAfter = await store.loadSession(sessionId);
    assert.ok(sessionAfter !== null);
    const reviewAfter = sessionAfter?.turns[0]?.latestReview;
    assert.equal(reviewAfter?.reviewId, "review-1", "review record must survive cleanup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Acceptance: dry-run reports impact without deleting (plan AC #1, #2)
// ---------------------------------------------------------------------------

test("cleanup --dry-run reports eligible artifacts but deletes nothing", async () => {
  const root = await createTempRoot();
  try {
    const { sessionId, sessionDir } = await buildFixture(root);
    const beforePath = join(sessionDir, "artifacts/attempt-1-worker-output.log");
    const before = await stat(beforePath);
    assert.ok(before.isFile());

    const report = await runCleanup(root, { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.ok(report.eligible.length >= 1, "dry-run should mark superseded log eligible");
    assert.equal(report.removed.length, 0, "dry-run never removes");
    assert.ok(report.totalBytes > 0, "dry-run must surface storage impact > 0");

    // File still on disk.
    const after = await stat(beforePath);
    assert.ok(after.isFile());

    // Records still in the v2 NDJSON log.
    const remaining = await listArtifactRecords(root, sessionId);
    assert.equal(remaining.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup live run removes the eligible artifact + prunes its v2 record + appends cleanup-log", async () => {
  const root = await createTempRoot();
  try {
    const { sessionId, sessionDir } = await buildFixture(root);
    const target = join(sessionDir, "artifacts/attempt-1-worker-output.log");
    await stat(target); // sanity — exists pre-run

    const report = await runCleanup(root, { dryRun: false });
    assert.equal(report.dryRun, false);
    assert.ok(report.removed.length >= 1);

    // File must be gone, protected file must remain.
    await assert.rejects(() => stat(target));
    await stat(join(sessionDir, "artifacts/attempt-2-result.json"));

    // v2 NDJSON pruned of the removed entry.
    const remaining = await listArtifactRecords(root, sessionId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.artifactId, "artifact-protected-result");

    // Hard Rule #3: cleanup-log NDJSON records the removal.
    const cleanupLog = await readFile(join(sessionDir, "cleanup.ndjson"), "utf8");
    assert.match(cleanupLog, /host\.artifact_cleaned/u);
    assert.match(cleanupLog, /artifact-superseded-log/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Acceptance: --older-than threshold scoping
// ---------------------------------------------------------------------------

test("cleanup --older-than honours the override (fresh artifacts kept)", async () => {
  const root = await createTempRoot();
  try {
    const { sessionId, sessionDir } = await buildFixture(root, {
      status: "failed",
      attempts: [{ attemptId: "attempt-1", status: "failed" }],
      records: [
        {
          artifactId: "fresh-log",
          attemptId: "attempt-1",
          kind: "log",
          name: "fresh.log",
          path: "artifacts/fresh.log",
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const report = await runCleanup(root, { dryRun: false, olderThanMs: 86_400_000 });
    assert.equal(
      report.removed.length,
      0,
      "1-min-old artifact must not be deleted by 1d threshold",
    );
    await stat(join(sessionDir, "artifacts/fresh.log"));
    const remaining = await listArtifactRecords(root, sessionId);
    assert.equal(remaining.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --session scoping
// ---------------------------------------------------------------------------

test("cleanup --session limits work to one session", async () => {
  const root = await createTempRoot();
  try {
    await buildFixture(root, { sessionId: "session-A" });
    await buildFixture(root, { sessionId: "session-B" });
    const report = await runCleanup(root, { dryRun: true, sessionId: "session-A" });
    assert.equal(report.scannedSessions, 1);
    for (const entry of report.eligible) {
      assert.equal(entry.sessionId, "session-A");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
