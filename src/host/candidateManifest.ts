import { createHash } from "node:crypto";

import type { CandidateChangeKind } from "../sessionTypes.js";
import type { WorktreeInspection } from "./worktreeInspector.js";

export const CANDIDATE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_MANIFEST_ARTIFACT_NAME = "candidate-manifest.json";
export const CANDIDATE_FINGERPRINT_ARTIFACT_NAME = "candidate-fingerprint.txt";

export type CandidateManifest = {
  schemaVersion: typeof CANDIDATE_MANIFEST_SCHEMA_VERSION;
  comparisonBase: "candidate_head" | "source_baseline";
  baselineHeadSha?: string;
  currentHeadSha: string;
  changeKind: CandidateChangeKind;
  hasCommittedChanges: boolean;
  hasDirtyChanges: boolean;
  committedFiles: string[];
  dirtyFiles: string[];
  changedFiles: string[];
  outputArtifacts: string[];
  reservedOutputDir: string;
  diffBytes: number;
};

const sortedUnique = (paths: ReadonlyArray<string>): string[] => [...new Set(paths)].sort();

export const buildCandidateManifest = (inspection: WorktreeInspection): CandidateManifest => ({
  schemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
  comparisonBase: inspection.baselineHeadSha === undefined ? "candidate_head" : "source_baseline",
  ...(inspection.baselineHeadSha === undefined ? {} : { baselineHeadSha: inspection.baselineHeadSha }),
  currentHeadSha: inspection.currentHeadSha,
  changeKind: inspection.changeKind,
  hasCommittedChanges: inspection.committedFiles.length > 0,
  hasDirtyChanges: inspection.dirtyFiles.length > 0,
  committedFiles: sortedUnique(inspection.committedFiles),
  dirtyFiles: sortedUnique(inspection.dirtyFiles),
  changedFiles: sortedUnique(inspection.repoChangedFiles),
  outputArtifacts: sortedUnique(inspection.outputArtifacts),
  reservedOutputDir: inspection.reservedOutputDir,
  diffBytes: inspection.diffBytes,
});

export const fingerprintCandidateManifest = (manifest: CandidateManifest): string =>
  createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

export const describeCandidateManifest = (
  inspection: WorktreeInspection,
): { manifest: CandidateManifest; fingerprint: string } => {
  const manifest = buildCandidateManifest(inspection);
  return {
    manifest,
    fingerprint: fingerprintCandidateManifest(manifest),
  };
};
