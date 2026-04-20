import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ArtifactStore } from "../artifactStore.js";
import type { ArtifactKind } from "./artifactStore.js";
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
  mergeResult?: Record<string, unknown>;
}): Promise<string[]> => {
  const { artifactStore, storageRoot, sessionId, turnId, attemptId, inspection, mergeResult } =
    args;
  const written: string[] = [];
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
      { generatedBy: "host.worktreeInspector", diffBytes: inspection.diffBytes },
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
    { generatedBy: "host.worktreeInspector", fileCount: inspection.repoChangedFiles.length },
  );
  written.push("changed-files.json");

  if (mergeResult !== undefined) {
    await writeSessionArtifact(
      artifactStore,
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      "merge-result.json",
      `${JSON.stringify(mergeResult, null, 2)}\n`,
      "report",
      { generatedBy: "host.executeAttempt" },
    );
    written.push("merge-result.json");
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
        originalPath: relativePath,
      },
    );
    written.push(name);
  }
  return written;
};
