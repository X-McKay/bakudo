export type FileContentSnapshot = string | null;

export type ReconciliationConflictKind =
  | "both_added_different"
  | "candidate_deleted_source_modified"
  | "candidate_modified_source_deleted"
  | "both_modified_different";

export type ClassifyConflictInput = {
  baseContent: FileContentSnapshot;
  candidateContent: FileContentSnapshot;
  sourceContent: FileContentSnapshot;
};

export type ApplyConflictClass =
  | "textual_overlap"
  | "lockfile_conflict"
  | "binary_conflict"
  | "unsupported_surface"
  | "structural_conflict"
  | "drift_gate_failure"
  | "fingerprint_mismatch";

export type ApplyConflictDecision = "needs_confirmation" | "apply_failed";

export type ApplyConflictClassification = {
  class: ApplyConflictClass;
  decision: ApplyConflictDecision;
  reason: string;
};

export const classifyReconciliationConflict = (
  input: ClassifyConflictInput,
): ReconciliationConflictKind | null => {
  const { baseContent, candidateContent, sourceContent } = input;
  if (candidateContent === sourceContent) {
    return null;
  }
  if (candidateContent === baseContent) {
    return null;
  }
  if (sourceContent === baseContent) {
    return null;
  }
  if (baseContent === null) {
    return "both_added_different";
  }
  if (candidateContent === null) {
    return "candidate_deleted_source_modified";
  }
  if (sourceContent === null) {
    return "candidate_modified_source_deleted";
  }
  return "both_modified_different";
};

export const isLockfilePath = (path: string): boolean =>
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$/u.test(
    path,
  );

export const classifyApplyConflict = (args: {
  path: string;
  kind: ReconciliationConflictKind;
}): ApplyConflictClassification => {
  if (isLockfilePath(args.path)) {
    return {
      class: "lockfile_conflict",
      decision: "needs_confirmation",
      reason: `lockfile conflict requires confirmation for ${args.path}`,
    };
  }
  return {
    class: "textual_overlap",
    decision: "needs_confirmation",
    reason: `textual overlap requires confirmation for ${args.path}`,
  };
};
