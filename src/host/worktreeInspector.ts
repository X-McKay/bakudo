import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { reservedGuestOutputDirForAttempt } from "../attemptProtocol.js";
import type { WorktreeSnapshot } from "./worktreeDiscovery.js";

const execFileAsync = promisify(execFile);

export type WorktreeInspection = {
  sandboxTaskId: string;
  branchName: string;
  worktreePath: string;
  reservedOutputDir: string;
  dirty: boolean;
  changedFiles: string[];
  repoChangedFiles: string[];
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

const listChangedFiles = async (cwd: string): Promise<string[]> => {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd },
  );
  return stdout
    .split("\n")
    .map((line) => line.slice(3))
    .map(normalizeStatusPath)
    .filter((line) => line.length > 0);
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

const readTrackedPatch = async (cwd: string, reservedOutputDir: string): Promise<string> => {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--binary", "HEAD", "--", ".", `:(exclude)${reservedOutputDir}`],
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

export const inspectWorktree = async (args: {
  snapshot: WorktreeSnapshot;
  taskId: string;
  attemptId: string;
}): Promise<WorktreeInspection> => {
  const { snapshot, taskId, attemptId } = args;
  const reservedOutputDir = reservedOutputRelativeDirForAttempt(attemptId);
  const changedFiles = await listChangedFiles(snapshot.path);
  const repoChangedFiles = changedFiles.filter(
    (path) => path !== reservedOutputDir && !path.startsWith(`${reservedOutputDir}/`),
  );

  const outputDir = join(snapshot.path, reservedOutputDir);
  let outputArtifacts: string[] = [];
  try {
    outputArtifacts = await readDirRecursive(outputDir);
  } catch {
    outputArtifacts = [];
  }

  const trackedPatch = await readTrackedPatch(snapshot.path, reservedOutputDir);
  const untrackedFiles = repoChangedFiles.filter((path) => !trackedPatch.includes(` b/${path}\n`));
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
    dirty: changedFiles.length > 0,
    changedFiles,
    repoChangedFiles,
    outputArtifacts,
    patchDiff,
    diffBytes: Buffer.byteLength(patchDiff, "utf8"),
  };
};
