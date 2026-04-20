import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  classifyApplyConflict,
  classifyReconciliationConflict,
  type ApplyConflictClassification,
  type ClassifyConflictInput,
  type FileContentSnapshot,
  type ReconciliationConflictKind,
} from "./conflictPolicy.js";

const execFileAsync = promisify(execFile);

type LineEdit = {
  start: number;
  deleteCount: number;
  insertLines: string[];
};

export type ReconcileFileInput = ClassifyConflictInput & {
  path: string;
};

export type ReconciledFileResolution =
  | "unchanged"
  | "converged"
  | "take_candidate"
  | "keep_source"
  | "merge_text";

export type ReconciledFileResult = {
  kind: "resolved";
  path: string;
  resolution: ReconciledFileResolution;
  content: FileContentSnapshot;
};

export type ReconciledFileConflict = {
  kind: "conflict";
  path: string;
  conflictKind: ReconciliationConflictKind;
  classification: ApplyConflictClassification;
  baseContent: FileContentSnapshot;
  candidateContent: FileContentSnapshot;
  sourceContent: FileContentSnapshot;
};

export type ReconcileFileOutcome = ReconciledFileResult | ReconciledFileConflict;

export type ReconcileFilesSummary = {
  resolved: ReconciledFileResult[];
  conflicts: ReconciledFileConflict[];
};

const comparePath = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const resolveFile = (input: ReconcileFileInput): ReconciledFileResult => {
  const { path, baseContent, candidateContent, sourceContent } = input;
  if (candidateContent === sourceContent) {
    return {
      kind: "resolved",
      path,
      resolution: candidateContent === baseContent ? "unchanged" : "converged",
      content: candidateContent,
    };
  }
  if (sourceContent === baseContent) {
    return {
      kind: "resolved",
      path,
      resolution: "take_candidate",
      content: candidateContent,
    };
  }
  return {
    kind: "resolved",
    path,
    resolution: "keep_source",
    content: sourceContent,
  };
};

const mergeTextConflict = async (
  input: {
    baseContent: string;
    candidateContent: string;
    sourceContent: string;
  },
): Promise<string | null> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "bakudo-reconcile-"));
  try {
    const basePath = join(tempRoot, "base.txt");
    const sourcePath = join(tempRoot, "source.txt");
    const candidatePath = join(tempRoot, "candidate.txt");
    await writeFile(basePath, input.baseContent, "utf8");
    await writeFile(sourcePath, input.sourceContent, "utf8");
    await writeFile(candidatePath, input.candidateContent, "utf8");
    try {
      const { stdout } = await execFileAsync("git", [
        "merge-file",
        "-p",
        sourcePath,
        basePath,
        candidatePath,
      ]);
      return stdout;
    } catch (error) {
      const err = error as { code?: number; stdout?: string };
      if (err.code !== 1) {
        throw error;
      }
      const candidateEdits = await diffLineEdits(basePath, candidatePath);
      const sourceEdits = await diffLineEdits(basePath, sourcePath);
      return mergeNonOverlappingEdits(input.baseContent, candidateEdits, sourceEdits);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const diffLineEdits = async (basePath: string, targetPath: string): Promise<LineEdit[]> => {
  const parseOutput = (output: string): LineEdit[] => {
    const edits: LineEdit[] = [];
    const lines = output.split("\n");
    let current: LineEdit | null = null;
    for (const line of lines) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (header) {
        if (current !== null) {
          edits.push(current);
        }
        const oldStart = Number.parseInt(header[1] ?? "1", 10);
        const oldCount = Number.parseInt(header[2] ?? "1", 10);
        current = {
          start: Math.max(0, oldStart - 1),
          deleteCount: oldCount,
          insertLines: [],
        };
        continue;
      }
      if (current === null || line.length === 0 || line === "\\ No newline at end of file") {
        continue;
      }
      if (line.startsWith("+")) {
        current.insertLines.push(line.slice(1));
      }
    }
    if (current !== null) {
      edits.push(current);
    }
    return edits;
  };

  try {
    const { stdout } = await execFileAsync("git", [
      "diff",
      "--no-index",
      "--unified=0",
      "--",
      basePath,
      targetPath,
    ]);
    return parseOutput(stdout);
  } catch (error) {
    const err = error as { code?: number; stdout?: string };
    if (err.code === 1) {
      return parseOutput(err.stdout ?? "");
    }
    throw error;
  }
};

const editsOverlap = (left: LineEdit, right: LineEdit): boolean => {
  const leftEnd = left.start + left.deleteCount;
  const rightEnd = right.start + right.deleteCount;
  if (left.deleteCount === 0 && right.deleteCount === 0) {
    return left.start === right.start;
  }
  if (left.deleteCount === 0) {
    return left.start >= right.start && left.start <= rightEnd;
  }
  if (right.deleteCount === 0) {
    return right.start >= left.start && right.start <= leftEnd;
  }
  return left.start < rightEnd && right.start < leftEnd;
};

const mergeNonOverlappingEdits = (
  baseContent: string,
  candidateEdits: readonly LineEdit[],
  sourceEdits: readonly LineEdit[],
): string | null => {
  for (const candidateEdit of candidateEdits) {
    for (const sourceEdit of sourceEdits) {
      if (editsOverlap(candidateEdit, sourceEdit)) {
        return null;
      }
    }
  }

  const baseLines = baseContent.split("\n");
  const mergedEdits = [...candidateEdits, ...sourceEdits].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.deleteCount - right.deleteCount;
  });

  const output: string[] = [];
  let cursor = 0;
  for (const edit of mergedEdits) {
    output.push(...baseLines.slice(cursor, edit.start));
    output.push(...edit.insertLines);
    cursor = edit.start + edit.deleteCount;
  }
  output.push(...baseLines.slice(cursor));
  return output.join("\n");
};

export const reconcileFile = async (input: ReconcileFileInput): Promise<ReconcileFileOutcome> => {
  const conflictKind = classifyReconciliationConflict(input);
  if (conflictKind === null) {
    return resolveFile(input);
  }

  if (
    conflictKind === "both_modified_different" &&
    input.baseContent !== null &&
    input.candidateContent !== null &&
    input.sourceContent !== null
  ) {
    const merged = await mergeTextConflict({
      baseContent: input.baseContent,
      candidateContent: input.candidateContent,
      sourceContent: input.sourceContent,
    });
    if (merged !== null) {
      return {
        kind: "resolved",
        path: input.path,
        resolution: "merge_text",
        content: merged,
      };
    }
  }

  return {
    kind: "conflict",
    path: input.path,
    conflictKind,
    classification: classifyApplyConflict({ path: input.path, kind: conflictKind }),
    baseContent: input.baseContent,
    candidateContent: input.candidateContent,
    sourceContent: input.sourceContent,
  };
};

export const reconcileFiles = async (
  inputs: Iterable<ReconcileFileInput>,
): Promise<ReconcileFilesSummary> => {
  const ordered = Array.from(inputs).sort((left, right) => comparePath(left.path, right.path));
  const resolved: ReconciledFileResult[] = [];
  const conflicts: ReconciledFileConflict[] = [];
  for (const input of ordered) {
    const outcome = await reconcileFile(input);
    if (outcome.kind === "resolved") {
      resolved.push(outcome);
    } else {
      conflicts.push(outcome);
    }
  }
  return { resolved, conflicts };
};
