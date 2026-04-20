import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../../src/artifactStore.js";
import { SessionStore } from "../../src/sessionStore.js";
import {
  APPLY_RECOVERY_ARTIFACT_NAME,
  APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME,
  recoverInterruptedApplyIfNeeded,
} from "../../src/host/applyRecovery.js";
import { writeSessionArtifact } from "../../src/host/sessionArtifactWriter.js";

const createTempDir = async (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

const seedInterruptedApply = async (args: {
  repoRoot: string;
  storageRoot: string;
  sourceContents: string;
  journalBefore: string;
  journalAfter: string;
  candidateState?: "apply_verifying" | "apply_writeback";
}) => {
  const sessionId = "session-apply-recovery";
  const turnId = "turn-1";
  const attemptId = "attempt-1";
  const store = new SessionStore(args.storageRoot);
  const artifactStore = new ArtifactStore(args.storageRoot);

  await writeFile(join(args.repoRoot, "README.md"), args.sourceContents, "utf8");
  await store.createSession({
    sessionId,
    goal: "recover apply",
    repoRoot: args.repoRoot,
    status: "reviewing",
    turns: [
      {
        turnId,
        prompt: "recover apply",
        mode: "build",
        status: "reviewing",
        attempts: [
          {
            attemptId,
            status: "needs_review",
            candidateState: args.candidateState ?? "apply_writeback",
            candidate: {
              state: args.candidateState ?? "apply_writeback",
              updatedAt: "2026-04-19T12:00:00.000Z",
            },
            result: {
              schemaVersion: 1,
              taskId: attemptId,
              sessionId,
              status: "succeeded",
              summary: "worker ok",
              exitCode: 0,
              finishedAt: "2026-04-19T12:00:00.000Z",
            },
            reviewRecord: {
              reviewId: "review-1",
              attemptId,
              outcome: "success",
              action: "accept",
              reviewedAt: "2026-04-19T12:00:00.000Z",
            },
          },
        ],
        latestReview: {
          reviewId: "review-1",
          attemptId,
          outcome: "success",
          action: "accept",
          reviewedAt: "2026-04-19T12:00:00.000Z",
        },
        createdAt: "2026-04-19T12:00:00.000Z",
        updatedAt: "2026-04-19T12:00:00.000Z",
      },
    ],
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
  });

  if ((args.candidateState ?? "apply_writeback") === "apply_writeback") {
    await writeSessionArtifact(
      artifactStore,
      args.storageRoot,
      sessionId,
      turnId,
      attemptId,
      APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: "2026-04-19T12:00:00.000Z",
          entries: [
            {
              path: "README.md",
              before: { kind: "text", content: args.journalBefore },
              after: { kind: "text", content: args.journalAfter },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "report",
      {
        generatedBy: "host.candidateApplier",
        producer: "host.candidateApplier",
        phase: "apply",
        role: "apply-writeback-journal",
      },
    );
  }

  return { sessionId, turnId, attemptId, store, artifactStore };
};

test("recoverInterruptedApplyIfNeeded restores interrupted write-back from the journal", async () => {
  const repoRoot = await createTempDir("bakudo-apply-recovery-repo-");
  const storageRoot = await createTempDir("bakudo-apply-recovery-store-");
  try {
    const seeded = await seedInterruptedApply({
      repoRoot,
      storageRoot,
      sourceContents: "after\n",
      journalBefore: "before\n",
      journalAfter: "after\n",
    });

    const recovered = await recoverInterruptedApplyIfNeeded({
      sessionStore: seeded.store,
      artifactStore: seeded.artifactStore,
      storageRoot,
      sessionId: seeded.sessionId,
    });

    assert.equal(recovered, true);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "before\n");

    const session = await seeded.store.loadSession(seeded.sessionId);
    const attempt = session?.turns[0]?.attempts[0];
    assert.equal(session?.status, "failed");
    assert.equal(session?.turns[0]?.status, "failed");
    assert.equal(session?.turns[0]?.latestReview?.action, "retry");
    assert.equal(attempt?.candidateState, "apply_failed");
    assert.match(attempt?.candidate?.applyError ?? "", /restored 1 source path/u);

    const artifacts = await seeded.artifactStore.listTaskArtifacts(seeded.sessionId, seeded.attemptId);
    assert.ok(artifacts.some((artifact) => artifact.name === APPLY_RECOVERY_ARTIFACT_NAME));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("recoverInterruptedApplyIfNeeded refuses to overwrite post-crash source edits", async () => {
  const repoRoot = await createTempDir("bakudo-apply-recovery-drift-repo-");
  const storageRoot = await createTempDir("bakudo-apply-recovery-drift-store-");
  try {
    const seeded = await seedInterruptedApply({
      repoRoot,
      storageRoot,
      sourceContents: "user edit after crash\n",
      journalBefore: "before\n",
      journalAfter: "after\n",
    });

    const recovered = await recoverInterruptedApplyIfNeeded({
      sessionStore: seeded.store,
      artifactStore: seeded.artifactStore,
      storageRoot,
      sessionId: seeded.sessionId,
    });

    assert.equal(recovered, true);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "user edit after crash\n");

    const session = await seeded.store.loadSession(seeded.sessionId);
    const attempt = session?.turns[0]?.attempts[0];
    assert.equal(attempt?.candidateState, "apply_failed");
    assert.match(attempt?.candidate?.applyError ?? "", /source paths changed after the crash/u);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("recoverInterruptedApplyIfNeeded marks apply_verifying interruptions as apply_failed without source mutation", async () => {
  const repoRoot = await createTempDir("bakudo-apply-recovery-verify-repo-");
  const storageRoot = await createTempDir("bakudo-apply-recovery-verify-store-");
  try {
    const seeded = await seedInterruptedApply({
      repoRoot,
      storageRoot,
      sourceContents: "before\n",
      journalBefore: "before\n",
      journalAfter: "after\n",
      candidateState: "apply_verifying",
    });

    const recovered = await recoverInterruptedApplyIfNeeded({
      sessionStore: seeded.store,
      artifactStore: seeded.artifactStore,
      storageRoot,
      sessionId: seeded.sessionId,
    });

    assert.equal(recovered, true);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "before\n");

    const session = await seeded.store.loadSession(seeded.sessionId);
    const attempt = session?.turns[0]?.attempts[0];
    assert.equal(attempt?.candidateState, "apply_failed");
    assert.match(attempt?.candidate?.applyError ?? "", /apply_verifying/u);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});
