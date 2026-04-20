import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { ApplyDriftDecision, SourceBaselineRecord } from "../sessionTypes.js";

const execFileAsync = promisify(execFile);

const gitString = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
};

const gitStatusClean = async (cwd: string): Promise<boolean> => {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd },
  );
  return stdout.trim().length === 0;
};

const gitBranchName = async (cwd: string): Promise<string | undefined> => {
  try {
    const branch = await gitString(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return branch.length === 0 ? undefined : branch;
  } catch {
    return undefined;
  }
};

export const captureSourceBaseline = async (repoRoot: string): Promise<SourceBaselineRecord> => {
  const resolvedRepoRoot = resolve(repoRoot);
  const topLevel = await gitString(resolvedRepoRoot, ["rev-parse", "--show-toplevel"]);
  const gitDirRaw = await gitString(resolvedRepoRoot, ["rev-parse", "--git-dir"]);
  const headSha = await gitString(resolvedRepoRoot, ["rev-parse", "HEAD"]);
  const branchName = await gitBranchName(resolvedRepoRoot);
  const clean = await gitStatusClean(resolvedRepoRoot);
  const gitDir = resolve(topLevel, gitDirRaw);
  return {
    repoRoot: topLevel,
    repoIdentity: `${topLevel}::${gitDir}`,
    headSha,
    ...(branchName === undefined ? {} : { branchName }),
    detachedHead: branchName === undefined,
    clean,
    capturedAt: new Date().toISOString(),
  };
};

const isAncestor = async (cwd: string, base: string, head: string): Promise<boolean> => {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", base, head], { cwd });
    return true;
  } catch {
    return false;
  }
};

const hasMergeBase = async (cwd: string, base: string, head: string): Promise<boolean> => {
  try {
    const mergeBase = await gitString(cwd, ["merge-base", base, head]);
    return mergeBase.length > 0;
  } catch {
    return false;
  }
};

export type DriftEvaluation = {
  decision: ApplyDriftDecision;
  current: SourceBaselineRecord;
};

export const evaluateApplyDrift = async (
  baseline: SourceBaselineRecord,
  repoRoot: string,
): Promise<DriftEvaluation> => {
  const current = await captureSourceBaseline(repoRoot);
  if (baseline.repoIdentity !== current.repoIdentity) {
    return { decision: "blocked_repo_mismatch", current };
  }
  if (current.detachedHead) {
    return { decision: "blocked_detached_head", current };
  }
  if (baseline.detachedHead) {
    return { decision: "blocked_detached_head", current };
  }
  if (baseline.branchName !== current.branchName) {
    return { decision: "blocked_branch_switched", current };
  }
  if (baseline.headSha === current.headSha) {
    return { decision: "allowed", current };
  }
  if (await isAncestor(current.repoRoot, baseline.headSha, current.headSha)) {
    return { decision: "allowed", current };
  }
  if (await hasMergeBase(current.repoRoot, baseline.headSha, current.headSha)) {
    return { decision: "blocked_baseline_not_ancestor", current };
  }
  return { decision: "blocked_unrelated_history", current };
};
