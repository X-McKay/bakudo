import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 10_000_000;

export type ApplyWorkspaceStatusEntry = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  tracked: boolean;
  originalPath?: string;
};

export type ApplyWorkspaceUnsupportedSurface = {
  kind: "unmerged_path" | "submodule_path";
  path: string;
  detail: string;
};

export type ApplyWorkspaceSourceStatus = {
  repoRoot: string;
  headSha: string;
  clean: boolean;
  entries: ApplyWorkspaceStatusEntry[];
  unsupported: ApplyWorkspaceUnsupportedSurface[];
};

export type ApplyWorkspaceHandle = {
  workspaceRoot: string;
  cleanup: () => Promise<void>;
  sourceStatus: ApplyWorkspaceSourceStatus;
};

export type CreateApplyWorkspaceOptions = {
  tempRoot?: string;
};

export class ApplyWorkspaceUnsupportedSurfaceError extends Error {
  readonly sourceStatus: ApplyWorkspaceSourceStatus;

  constructor(sourceStatus: ApplyWorkspaceSourceStatus) {
    super(formatUnsupportedSurfaceError(sourceStatus.unsupported));
    this.name = "ApplyWorkspaceUnsupportedSurfaceError";
    this.sourceStatus = sourceStatus;
  }
}

const comparePath = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const compareStatusEntry = (
  left: ApplyWorkspaceStatusEntry,
  right: ApplyWorkspaceStatusEntry,
): number => {
  const pathOrder = comparePath(left.path, right.path);
  if (pathOrder !== 0) {
    return pathOrder;
  }
  return comparePath(left.originalPath ?? "", right.originalPath ?? "");
};

const compareRemovalPath = (left: string, right: string): number => {
  const leftDepth = left.split("/").length;
  const rightDepth = right.split("/").length;
  if (leftDepth !== rightDepth) {
    return rightDepth - leftDepth;
  }
  return comparePath(left, right);
};

const formatUnsupportedSurfaceError = (
  unsupported: readonly ApplyWorkspaceUnsupportedSurface[],
): string => {
  const details = unsupported.map((surface) => `${surface.kind}:${surface.path}`);
  return `Apply workspace does not support: ${details.join(", ")}`;
};

const gitStdout = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
};

const gitTrimmed = async (cwd: string, args: string[]): Promise<string> =>
  (await gitStdout(cwd, args)).trim();

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
};

const resolveWithinRoot = (root: string, relativePath: string): string => {
  const resolvedRoot = resolve(root);
  const absolutePath = resolve(resolvedRoot, relativePath);
  if (absolutePath === resolvedRoot || absolutePath.startsWith(`${resolvedRoot}/`)) {
    return absolutePath;
  }
  throw new Error(`Refusing to access path outside repo root: ${relativePath}`);
};

const parseStatusPorcelain = (output: string): ApplyWorkspaceStatusEntry[] => {
  const tokens = output.split("\u0000");
  const entries: ApplyWorkspaceStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record) {
      continue;
    }
    if (record.length < 4) {
      throw new Error(`Unexpected git status record: ${JSON.stringify(record)}`);
    }
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const path = record.slice(3);
    let originalPath: string | undefined;
    if (indexStatus === "R" || indexStatus === "C") {
      const renameSource = tokens[index + 1];
      if (!renameSource) {
        throw new Error(`Missing rename source path for status record: ${record}`);
      }
      originalPath = renameSource;
      index += 1;
    }
    entries.push({
      path,
      indexStatus,
      worktreeStatus,
      tracked: !(indexStatus === "?" && worktreeStatus === "?"),
      ...(originalPath === undefined ? {} : { originalPath }),
    });
  }
  return entries.sort(compareStatusEntry);
};

const isUnmergedEntry = (entry: ApplyWorkspaceStatusEntry): boolean => {
  const code = `${entry.indexStatus}${entry.worktreeStatus}`;
  return (
    entry.indexStatus === "U" ||
    entry.worktreeStatus === "U" ||
    ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)
  );
};

const isSubmodulePath = async (repoRoot: string, path: string): Promise<boolean> => {
  const stageOutput = await gitStdout(repoRoot, ["ls-files", "--stage", "--", path]);
  const firstLine = stageOutput.split("\n")[0]?.trim();
  return firstLine?.startsWith("160000 ") ?? false;
};

const collectUnsupportedSurfaces = async (
  repoRoot: string,
  entries: readonly ApplyWorkspaceStatusEntry[],
): Promise<ApplyWorkspaceUnsupportedSurface[]> => {
  const unsupported: ApplyWorkspaceUnsupportedSurface[] = [];
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    if (isUnmergedEntry(entry)) {
      unsupported.push({
        kind: "unmerged_path",
        path: entry.path,
        detail: `git status reports ${entry.indexStatus}${entry.worktreeStatus}`,
      });
    }
    const pathsToCheck = [entry.path, entry.originalPath].filter(
      (value): value is string => value !== undefined,
    );
    for (const path of pathsToCheck) {
      if (!entry.tracked || seenPaths.has(path)) {
        continue;
      }
      if (await isSubmodulePath(repoRoot, path)) {
        unsupported.push({
          kind: "submodule_path",
          path,
          detail: "submodule paths are not overlaid into apply workspaces",
        });
      }
      seenPaths.add(path);
    }
  }
  return unsupported.sort((left, right) => {
    const kindOrder = comparePath(left.kind, right.kind);
    if (kindOrder !== 0) {
      return kindOrder;
    }
    return comparePath(left.path, right.path);
  });
};

const readSourceStatus = async (repoPath: string): Promise<ApplyWorkspaceSourceStatus> => {
  const repoRoot = await gitTrimmed(repoPath, ["rev-parse", "--show-toplevel"]);
  const headSha = await gitTrimmed(repoRoot, ["rev-parse", "HEAD"]);
  const statusOutput = await gitStdout(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  const entries = parseStatusPorcelain(statusOutput);
  const unsupported = await collectUnsupportedSurfaces(repoRoot, entries);
  return {
    repoRoot,
    headSha,
    clean: entries.length === 0,
    entries,
    unsupported,
  };
};

const copyRelativePath = async (
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
): Promise<void> => {
  const sourcePath = resolveWithinRoot(sourceRoot, relativePath);
  const destinationPath = resolveWithinRoot(destinationRoot, relativePath);
  await rm(destinationPath, { recursive: true, force: true });
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, {
    force: true,
    recursive: true,
    verbatimSymlinks: true,
  });
};

const removeRelativePath = async (root: string, relativePath: string): Promise<void> => {
  await rm(resolveWithinRoot(root, relativePath), { recursive: true, force: true });
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

const overlaySourceState = async (
  sourceRoot: string,
  workspaceRoot: string,
  entries: readonly ApplyWorkspaceStatusEntry[],
): Promise<void> => {
  const removals = new Set<string>();
  const copies = new Set<string>();
  for (const entry of entries) {
    if (entry.indexStatus === "R" && entry.originalPath !== undefined) {
      removals.add(entry.originalPath);
    }
    const sourcePath = resolveWithinRoot(sourceRoot, entry.path);
    if (await pathExists(sourcePath)) {
      copies.add(entry.path);
    } else {
      removals.add(entry.path);
    }
  }
  for (const relativePath of Array.from(removals).sort(compareRemovalPath)) {
    await removeRelativePath(workspaceRoot, relativePath);
  }
  for (const relativePath of Array.from(copies).sort(comparePath)) {
    await copyRelativePath(sourceRoot, workspaceRoot, relativePath);
  }
};

export const createApplyWorkspace = async (
  repoPath: string,
  options: CreateApplyWorkspaceOptions = {},
): Promise<ApplyWorkspaceHandle> => {
  const sourceStatus = await readSourceStatus(repoPath);
  if (sourceStatus.unsupported.length > 0) {
    throw new ApplyWorkspaceUnsupportedSurfaceError(sourceStatus);
  }

  const tempRoot = resolve(options.tempRoot ?? tmpdir());
  await mkdir(tempRoot, { recursive: true });
  const workspaceParent = await mkdtemp(join(tempRoot, "bakudo-apply-workspace-"));
  const workspaceRoot = join(workspaceParent, "repo");

  let cleaned = false;
  let worktreeCreated = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (worktreeCreated) {
      try {
        await git(sourceStatus.repoRoot, ["worktree", "remove", "--force", workspaceRoot]);
      } catch {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }
    await rm(workspaceParent, { recursive: true, force: true });
  };

  try {
    await git(sourceStatus.repoRoot, [
      "worktree",
      "add",
      "--detach",
      workspaceRoot,
      sourceStatus.headSha,
    ]);
    worktreeCreated = true;
    await overlaySourceState(sourceStatus.repoRoot, workspaceRoot, sourceStatus.entries);
    return {
      workspaceRoot,
      cleanup,
      sourceStatus,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
