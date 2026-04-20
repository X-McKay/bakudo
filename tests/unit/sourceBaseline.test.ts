import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { captureSourceBaseline, evaluateApplyDrift } from "../../src/host/sourceBaseline.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
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

test("evaluateApplyDrift allows same-branch descendant HEAD advancement with dirty state", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    await writeFile(join(repoRoot, "README.md"), "hello\nnext\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "next"]);
    await writeFile(join(repoRoot, "notes.txt"), "local dirty file\n", "utf8");

    const drift = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(drift.decision, "allowed");
    assert.equal(drift.current.clean, false);
    assert.equal(drift.current.branchName, baseline.branchName);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("evaluateApplyDrift blocks branch switches and detached HEAD state", async () => {
  const repoRoot = await createRepo();
  try {
    const baseline = await captureSourceBaseline(repoRoot);
    await git(repoRoot, ["checkout", "-b", "feature/apply"]);
    const branchSwitched = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(branchSwitched.decision, "blocked_branch_switched");

    await git(repoRoot, ["checkout", "--detach"]);
    const detached = await evaluateApplyDrift(baseline, repoRoot);
    assert.equal(detached.decision, "blocked_detached_head");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
