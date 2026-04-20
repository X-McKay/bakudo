import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { captureSourceBaseline, evaluateApplyDrift } from "../../src/host/sourceBaseline.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

const gitOut = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
};

const createRepo = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), "bakudo-baseline-"));
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
  await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
  await writeFile(join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
};

test("captureSourceBaseline records the current branch, head, and cleanliness", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    assert.equal(baseline.repoRoot, repoRoot);
    assert.equal(baseline.detachedHead, false);
    assert.ok(baseline.branchName);
    assert.equal(baseline.clean, true);
    assert.match(baseline.headSha, /^[0-9a-f]{40}$/u);
    assert.match(baseline.repoIdentity, /::/u);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: allowed on same-SHA baseline with no-op source edits", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    await writeFile(join(repoRoot, "notes.txt"), "uncommitted\n", "utf8");

    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "allowed");
    assert.equal(drift.current.headSha, baseline.headSha);
    assert.equal(drift.current.clean, false);
    assert.equal(drift.current.branchName, baseline.branchName);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: allowed with dirty-source overlap against descendant HEAD", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    await writeFile(join(repoRoot, "README.md"), "hello\nnext\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "next"]);
    // dirty overlap: uncommitted edit to the same file as the new commit
    await writeFile(join(repoRoot, "README.md"), "hello\nnext\ndirty tail\n", "utf8");
    await writeFile(join(repoRoot, "notes.txt"), "local dirty file\n", "utf8");

    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "allowed");
    assert.notEqual(drift.current.headSha, baseline.headSha);
    assert.equal(drift.current.clean, false);
    assert.equal(drift.current.branchName, baseline.branchName);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: allowed when source only deletes files that never appeared in baseline", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    // Add-then-delete a fresh file in a new commit, so the delete never
    // touches anything known to the baseline.
    await writeFile(join(repoRoot, "ephemeral.txt"), "temp\n", "utf8");
    await git(repoRoot, ["add", "ephemeral.txt"]);
    await git(repoRoot, ["commit", "-m", "add ephemeral"]);
    await unlink(join(repoRoot, "ephemeral.txt"));
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "remove ephemeral"]);

    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "allowed");
    assert.notEqual(drift.current.headSha, baseline.headSha);
    assert.equal(drift.current.branchName, baseline.branchName);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: blocks blocked_repo_mismatch when the repository identity differs", async () => {
  const repoA = await createRepo();
  const repoB = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoA);
    const drift = await evaluateApplyDrift(baseline, repoB);
    assert.equal(drift.decision, "blocked_repo_mismatch");
    assert.notEqual(drift.current.repoIdentity, baseline.repoIdentity);
  } finally {
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: blocks branch switch while preserving the descendant-head path", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    await git(repoRoot, ["checkout", "-b", "feature/apply"]);
    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "blocked_branch_switched");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: blocks blocked_detached_head when HEAD is detached", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    await git(repoRoot, ["checkout", "--detach"]);
    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "blocked_detached_head");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: blocks blocked_baseline_not_ancestor when the branch diverges", async () => {
  const repoRoot = await createRepo();
  try {
    // Move baseline forward one commit so we have an ancestor to reset past.
    await writeFile(join(repoRoot, "step.txt"), "step one\n", "utf8");
    await git(repoRoot, ["add", "step.txt"]);
    await git(repoRoot, ["commit", "-m", "step one"]);
    const baseline = await captureSourceBaseline(repoRoot);
    const anchor = await gitOut(repoRoot, ["rev-parse", "HEAD~1"]);
    // Reset behind the baseline and add a new commit so the baseline SHA
    // shares an ancestor with HEAD but is not itself an ancestor.
    await git(repoRoot, ["reset", "--hard", anchor]);
    await writeFile(join(repoRoot, "diverged.txt"), "diverged\n", "utf8");
    await git(repoRoot, ["add", "diverged.txt"]);
    await git(repoRoot, ["commit", "-m", "diverged"]);

    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "blocked_baseline_not_ancestor");
    assert.notEqual(drift.current.headSha, baseline.headSha);
    assert.equal(drift.current.branchName, baseline.branchName);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift: blocks blocked_unrelated_history when HEAD points at an orphan commit", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    // Build an orphan commit on a scratch branch that shares no history,
    // then redirect the primary branch ref at it so repoIdentity and
    // branchName stay stable and `blocked_unrelated_history` fires first.
    await git(repoRoot, ["switch", "--orphan", "orphan-scratch"]);
    await writeFile(join(repoRoot, "fresh.txt"), "fresh\n", "utf8");
    await git(repoRoot, ["add", "fresh.txt"]);
    await git(repoRoot, ["commit", "-m", "orphan commit"]);
    const orphanSha = await gitOut(repoRoot, ["rev-parse", "HEAD"]);
    const baselineBranch = baseline.branchName;
    assert.ok(baselineBranch, "baseline must have a branch name for this test");
    await git(repoRoot, ["checkout", baselineBranch]);
    await git(repoRoot, ["update-ref", `refs/heads/${baselineBranch}`, orphanSha]);
    await git(repoRoot, ["reset", "--hard", orphanSha]);
    await git(repoRoot, ["branch", "-D", "orphan-scratch"]);

    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "blocked_unrelated_history");
    assert.equal(drift.current.branchName, baseline.branchName);
    assert.equal(drift.current.repoIdentity, baseline.repoIdentity);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
