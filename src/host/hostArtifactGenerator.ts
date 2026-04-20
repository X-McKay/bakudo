import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ArtifactStore } from "../artifactStore.js";
import type { ArtifactKind } from "./artifactStore.js";
import {
  CANDIDATE_FINGERPRINT_ARTIFACT_NAME,
  CANDIDATE_MANIFEST_ARTIFACT_NAME,
  describeCandidateManifest,
} from "./candidateManifest.js";
import { writeSessionArtifact } from "./sessionArtifactWriter.js";
import type { WorktreeInspection } from "./worktreeInspector.js";

const guestArtifactKind = (name: string): ArtifactKind => {
  if (name.endsWith(".diff") || name.endsWith(".patch")) {
    return "patch";
  }
  if (name.endsWith(".md")) {
    return "summary";
  }
  if (name.endsWith(".json")) {
    return "report";
  }
  return "report";
};

export const writeHostArtifacts = async (args: {
  artifactStore: ArtifactStore;
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  inspection: WorktreeInspection;
  applyResult?: Record<string, unknown>;
}): Promise<string[]> => {
  const { artifactStore, storageRoot, sessionId, turnId, attemptId, inspection, applyResult } = args;
  const written: string[] = [];
  const { manifest, fingerprint } = describeCandidateManifest(inspection);
  if (inspection.patchDiff.length > 0) {
    await writeSessionArtifact(
      artifactStore,
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      "patch.diff",
      inspection.patchDiff,
      "patch",
      {
        generatedBy: "host.worktreeInspector",
        producer: "host.worktreeInspector",
        phase: "provenance",
        diffBytes: inspection.diffBytes,
      },
    );
    written.push("patch.diff");
  }
  await writeSessionArtifact(
    artifactStore,
    storageRoot,
    sessionId,
    turnId,
    attemptId,
    "changed-files.json",
    `${JSON.stringify(inspection.repoChangedFiles, null, 2)}\n`,
    "report",
    {
      generatedBy: "host.worktreeInspector",
      producer: "host.worktreeInspector",
      phase: "provenance",
      role: "changed-files",
      fileCount: inspection.repoChangedFiles.length,
    },
  );
  written.push("changed-files.json");
  await writeSessionArtifact(
    artifactStore,
    storageRoot,
    sessionId,
    turnId,
    attemptId,
    CANDIDATE_MANIFEST_ARTIFACT_NAME,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "report",
    {
      generatedBy: "host.worktreeInspector",
      producer: "host.worktreeInspector",
      phase: "provenance",
      role: "candidate-manifest",
      fingerprint,
      changeKind: manifest.changeKind,
      currentHeadSha: manifest.currentHeadSha,
      ...(manifest.baselineHeadSha === undefined
        ? {}
        : { baselineHeadSha: manifest.baselineHeadSha }),
    },
  );
  written.push(CANDIDATE_MANIFEST_ARTIFACT_NAME);

  await writeSessionArtifact(
    artifactStore,
    storageRoot,
    sessionId,
    turnId,
    attemptId,
    CANDIDATE_FINGERPRINT_ARTIFACT_NAME,
    `${fingerprint}\n`,
    "report",
    {
      generatedBy: "host.worktreeInspector",
      producer: "host.worktreeInspector",
      phase: "provenance",
      role: "candidate-fingerprint",
      fingerprint,
    },
  );
  written.push(CANDIDATE_FINGERPRINT_ARTIFACT_NAME);

  if (applyResult !== undefined) {
    await writeSessionArtifact(
      artifactStore,
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      "apply-result.json",
      `${JSON.stringify(applyResult, null, 2)}\n`,
      "report",
      {
        generatedBy: "host.executeAttempt",
        producer: "host.executeAttempt",
        phase: "finalize",
        role: "apply-result",
      },
    );
    written.push("apply-result.json");
  }
  return written;
};

export const harvestGuestArtifacts = async (args: {
  artifactStore: ArtifactStore;
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  inspection: WorktreeInspection;
}): Promise<string[]> => {
  const { artifactStore, storageRoot, sessionId, turnId, attemptId, inspection } = args;
  const written: string[] = [];
  for (const relativePath of inspection.outputArtifacts) {
    const contents = await readFile(
      join(inspection.worktreePath, inspection.reservedOutputDir, relativePath),
      "utf8",
    );
    const name = basename(relativePath);
    await writeSessionArtifact(
      artifactStore,
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      name,
      contents,
      guestArtifactKind(name),
      {
        generatedBy: "guest",
        producer: "guest",
        phase: "execution",
        sourceRelativePath: relativePath,
        originalPath: relativePath,
      },
    );
    written.push(name);
  }
  return written;
};
