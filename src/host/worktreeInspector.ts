import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { reservedGuestOutputDirForAttempt } from "../attemptProtocol.js";
import type { CandidateChangeKind } from "../sessionTypes.js";
import type { WorktreeSnapshot } from "./worktreeDiscovery.js";

const execFileAsync = promisify(execFile);

type GitStatusEntry = {
  code: string;
  path: string;
};

export type WorktreeInspection = {
  sandboxTaskId: string;
  branchName: string;
  worktreePath: string;
  reservedOutputDir: string;
  baselineHeadSha?: string;
  currentHeadSha: string;
  dirty: boolean;
  changedFiles: string[];
  repoChangedFiles: string[];
  dirtyFiles: string[];
  committedFiles: string[];
  changeKind: CandidateChangeKind;
  outputArtifacts: string[];
  patchDiff: string;
  diffBytes: number;
};

const guestToWorktreeRelative = (guestPath: string): string =>
  guestPath.replace(/^\/workspace\//u, "");

export const reservedOutputRelativeDirForAttempt = (attemptId: string): string =>
  guestToWorktreeRelative(reservedGuestOutputDirForAttempt(attemptId));

const normalizeStatusPath = (raw: string): string => {
  const trimmed = raw.trim();
  const renameIndex = trimmed.indexOf(" -> ");
  return renameIndex === -1 ? trimmed : trimmed.slice(renameIndex + 4).trim();
};

const listStatusEntries = async (cwd: string): Promise<GitStatusEntry[]> => {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd },
  );
  return stdout
    .split("\n")
    .filter((line) => line.length >= 4)
    .map((line) => ({
      code: line.slice(0, 2),
      path: normalizeStatusPath(line.slice(3)),
    }))
    .filter((entry) => entry.path.length > 0);
};

const readDirRecursive = async (rootDir: string, currentDir = rootDir): Promise<string[]> => {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readDirRecursive(rootDir, entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(rootDir, entryPath));
    }
  }
  return files.sort();
};

const gitString = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
};

const resolveBaselineHeadSha = async (
  cwd: string,
  baselineHeadSha: string | undefined,
): Promise<string | undefined> => {
  if (baselineHeadSha === undefined) {
    return undefined;
  }
  try {
    return await gitString(cwd, ["rev-parse", `${baselineHeadSha}^{commit}`]);
  } catch {
    return undefined;
  }
};

const excludeReservedOutputPaths = (paths: ReadonlyArray<string>, reservedOutputDir: string): string[] =>
  paths
    .filter((path) => path !== reservedOutputDir && !path.startsWith(`${reservedOutputDir}/`))
    .sort();

const readChangedPaths = async (cwd: string, args: string[]): Promise<string[]> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
};

const listCommittedFiles = async (
  cwd: string,
  baselineHeadSha: string,
  reservedOutputDir: string,
): Promise<string[]> =>
  readChangedPaths(cwd, [
    "diff",
    "--name-only",
    `${baselineHeadSha}..HEAD`,
    "--",
    ".",
    `:(exclude)${reservedOutputDir}`,
  ]);

const readTrackedPatch = async (
  cwd: string,
  comparisonHeadSha: string,
  reservedOutputDir: string,
): Promise<string> => {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--binary", comparisonHeadSha, "--", ".", `:(exclude)${reservedOutputDir}`],
    { cwd },
  );
  return stdout;
};

const readUntrackedPatch = async (cwd: string, path: string): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--binary", "--no-index", "--", "/dev/null", path],
      { cwd },
    );
    return stdout;
  } catch (error) {
    const err = error as { stdout?: string };
    return err.stdout ?? "";
  }
};

const sortUnique = (paths: ReadonlyArray<string>): string[] => [...new Set(paths)].sort();

const candidateChangeKindFor = (
  committedFiles: ReadonlyArray<string>,
  dirtyFiles: ReadonlyArray<string>,
): CandidateChangeKind => {
  if (committedFiles.length > 0 && dirtyFiles.length > 0) {
    return "mixed";
  }
  if (committedFiles.length > 0) {
    return "committed";
  }
  if (dirtyFiles.length > 0) {
    return "dirty";
  }
  return "clean";
};

export const inspectWorktree = async (args: {
  snapshot: WorktreeSnapshot;
  taskId: string;
  attemptId: string;
  baselineHeadSha?: string;
}): Promise<WorktreeInspection> => {
  const { snapshot, taskId, attemptId, baselineHeadSha } = args;
  const reservedOutputDir = reservedOutputRelativeDirForAttempt(attemptId);
  const effectiveBaselineHeadSha = await resolveBaselineHeadSha(snapshot.path, baselineHeadSha);
  const statusEntries = await listStatusEntries(snapshot.path);
  const changedFiles = sortUnique(statusEntries.map((entry) => entry.path));
  const dirtyFiles = excludeReservedOutputPaths(
    statusEntries.map((entry) => entry.path),
    reservedOutputDir,
  );
  const committedFiles =
    effectiveBaselineHeadSha === undefined
      ? []
      : await listCommittedFiles(snapshot.path, effectiveBaselineHeadSha, reservedOutputDir);
  const repoChangedFiles = sortUnique([...committedFiles, ...dirtyFiles]);

  const outputDir = join(snapshot.path, reservedOutputDir);
  let outputArtifacts: string[] = [];
  try {
    outputArtifacts = await readDirRecursive(outputDir);
  } catch {
    outputArtifacts = [];
  }

  const trackedPatch = await readTrackedPatch(
    snapshot.path,
    effectiveBaselineHeadSha ?? "HEAD",
    reservedOutputDir,
  );
  const untrackedFiles = excludeReservedOutputPaths(
    statusEntries.filter((entry) => entry.code === "??").map((entry) => entry.path),
    reservedOutputDir,
  );
  const untrackedPatches = await Promise.all(
    untrackedFiles.map((path) => readUntrackedPatch(snapshot.path, path)),
  );
  const patchDiff = [trackedPatch, ...untrackedPatches]
    .filter((entry) => entry.length > 0)
    .join("");

  return {
    sandboxTaskId: taskId,
    branchName: snapshot.branch,
    worktreePath: snapshot.path,
    reservedOutputDir,
    ...(effectiveBaselineHeadSha === undefined ? {} : { baselineHeadSha: effectiveBaselineHeadSha }),
    currentHeadSha: snapshot.head,
    dirty: dirtyFiles.length > 0,
    changedFiles,
    repoChangedFiles,
    dirtyFiles,
    committedFiles,
    changeKind: candidateChangeKindFor(committedFiles, dirtyFiles),
    outputArtifacts,
    patchDiff,
    diffBytes: Buffer.byteLength(patchDiff, "utf8"),
  };
};
