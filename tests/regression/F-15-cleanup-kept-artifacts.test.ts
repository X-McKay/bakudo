import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendArtifactRecord,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  type ArtifactRecord,
} from "../../src/host/artifactStore.js";
import { formatCleanupReport, runCleanup } from "../../src/host/commands/cleanup.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { SessionRecord } from "../../src/sessionTypes.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-f-15-"));

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
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      status: attempt.status,
    })),
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
      ? options.records.map((record, index) => ({
          schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
          artifactId: `artifact-${index}`,
          sessionId,
          turnId: "turn-1",
          attemptId: attempts[0]!.attemptId,
          kind: "log",
          name: `worker-output-${index}.log`,
          path: `artifacts/worker-output-${index}.log`,
          createdAt: "2026-01-01T00:00:00.000Z",
          ...record,
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

test("F-15: cleanup --dry-run emits both removed and kept sections", async () => {
  const root = await createTempRoot();
  try {
    await buildFixture(root);

    const report = await runCleanup(root, { dryRun: true });
    const lines = formatCleanupReport(report);
    const kept = report.kept ?? [];

    assert.ok(lines.includes("Would remove:"));
    assert.ok(lines.includes("Would keep:"));
    assert.ok(
      lines.some((line) => /\[superseded_retry_log\].*attempt-1-worker-output\.log/u.test(line)),
    );
    assert.ok(lines.some((line) => /\[protected_kind\].*result\.json/u.test(line)));
    assert.ok(lines.some((line) => /\[session_root\].*session\.json/u.test(line)));
    assert.equal(report.totalArtifacts, report.eligible.length + kept.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
