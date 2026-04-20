import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../../src/artifactStore.js";
import {
  CANDIDATE_FINGERPRINT_ARTIFACT_NAME,
  CANDIDATE_MANIFEST_ARTIFACT_NAME,
  buildCandidateManifest,
  fingerprintCandidateManifest,
} from "../../src/host/candidateManifest.js";
import { readSessionEventLog } from "../../src/host/eventLogWriter.js";
import { listArtifactRecords } from "../../src/host/artifactStore.js";
import { harvestGuestArtifacts, writeHostArtifacts } from "../../src/host/hostArtifactGenerator.js";
import type { WorktreeInspection } from "../../src/host/worktreeInspector.js";
import { createSessionPaths } from "../../src/sessionStore.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-host-artifact-"));

test("harvestGuestArtifacts preserves guest sourceRelativePath provenance", async () => {
  const root = await createTempRoot();
  try {
    const worktreePath = join(root, "worktree");
    const reservedOutputDir = ".bakudo/out/attempt-1";
    await mkdir(join(worktreePath, reservedOutputDir, "nested"), { recursive: true });
    await writeFile(
      join(worktreePath, reservedOutputDir, "nested", "summary.md"),
      "# Nested Summary\n",
      "utf8",
    );

    const inspection: WorktreeInspection = {
      sandboxTaskId: "sandbox-1",
      branchName: "candidate/1",
      worktreePath,
      reservedOutputDir,
      currentHeadSha: "a".repeat(40),
      dirty: false,
      changedFiles: [],
      repoChangedFiles: [],
      dirtyFiles: [],
      committedFiles: [],
      changeKind: "clean",
      outputArtifacts: ["nested/summary.md"],
      patchDiff: "",
      diffBytes: 0,
    };

    const store = new ArtifactStore(root);
    const written = await harvestGuestArtifacts({
      artifactStore: store,
      storageRoot: root,
      sessionId: "session-guest",
      turnId: "turn-1",
      attemptId: "attempt-1",
      inspection,
    });

    assert.deepEqual(written, ["summary.md"]);
    const records = await listArtifactRecords(root, "session-guest");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.name, "summary.md");
    assert.equal(records[0]?.producer, "guest");
    assert.equal(records[0]?.phase, "execution");
    assert.equal(records[0]?.role, "summary");
    assert.equal(records[0]?.sourceRelativePath, "nested/summary.md");

    const envelopes = await readSessionEventLog(root, "session-guest");
    const payload = envelopes.find((envelope) => envelope.kind === "host.artifact_registered")
      ?.payload as {
      producer: string;
      phase: string;
      role: string;
      sourceRelativePath: string;
    };
    assert.equal(payload.producer, "guest");
    assert.equal(payload.phase, "execution");
    assert.equal(payload.role, "summary");
    assert.equal(payload.sourceRelativePath, "nested/summary.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeHostArtifacts persists a candidate manifest and stable fingerprint", async () => {
  const root = await createTempRoot();
  try {
    const inspection: WorktreeInspection = {
      sandboxTaskId: "sandbox-1",
      branchName: "candidate/1",
      worktreePath: join(root, "worktree"),
      reservedOutputDir: ".bakudo/out/attempt-1",
      baselineHeadSha: "a".repeat(40),
      currentHeadSha: "b".repeat(40),
      dirty: true,
      changedFiles: ["notes.txt", ".bakudo/out/attempt-1/summary.md"],
      repoChangedFiles: ["README.md", "notes.txt"],
      dirtyFiles: ["notes.txt"],
      committedFiles: ["README.md"],
      changeKind: "mixed",
      outputArtifacts: ["summary.md"],
      patchDiff: "diff --git a/README.md b/README.md\n",
      diffBytes: Buffer.byteLength("diff --git a/README.md b/README.md\n", "utf8"),
    };

    const store = new ArtifactStore(root);
    const written = await writeHostArtifacts({
      artifactStore: store,
      storageRoot: root,
      sessionId: "session-host",
      turnId: "turn-1",
      attemptId: "attempt-1",
      inspection,
    });

    assert.deepEqual(written, [
      "patch.diff",
      "changed-files.json",
      CANDIDATE_MANIFEST_ARTIFACT_NAME,
      CANDIDATE_FINGERPRINT_ARTIFACT_NAME,
    ]);

    const manifest = buildCandidateManifest(inspection);
    const fingerprint = fingerprintCandidateManifest(manifest);
    const { sessionDir } = createSessionPaths(root, "session-host");
    const records = await listArtifactRecords(root, "session-host");
    const manifestRecord = records.find((record) => record.name === CANDIDATE_MANIFEST_ARTIFACT_NAME);
    const fingerprintRecord = records.find(
      (record) => record.name === CANDIDATE_FINGERPRINT_ARTIFACT_NAME,
    );

    assert.ok(manifestRecord);
    assert.ok(fingerprintRecord);
    assert.equal(manifestRecord.role, "candidate-manifest");
    assert.equal(fingerprintRecord.role, "candidate-fingerprint");
    assert.equal(manifestRecord.metadata?.fingerprint, fingerprint);
    assert.equal(fingerprintRecord.metadata?.fingerprint, fingerprint);

    const manifestBody = await readFile(join(sessionDir, manifestRecord.path), "utf8");
    const fingerprintBody = await readFile(join(sessionDir, fingerprintRecord.path), "utf8");
    assert.deepEqual(JSON.parse(manifestBody), manifest);
    assert.equal(fingerprintBody.trim(), fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
