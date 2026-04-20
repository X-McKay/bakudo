import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";

import { inspectWorktree, reservedOutputRelativeDirForAttempt } from "../../src/host/worktreeInspector.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

const gitString = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
};

const createRepo = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-worktree-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "bakudo@example.test"]);
  await git(root, ["config", "user.name", "Bakudo Tests"]);
  await writeFile(join(root, "README.md"), "hello\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
};

const snapshotFor = async (root: string, taskId: string) => ({
  path: root,
  branch: `refs/heads/agent/${taskId}`,
  head: await gitString(root, ["rev-parse", "HEAD"]),
});

test("inspectWorktree reports dirty candidate changes relative to the recorded baseline", async () => {
  const root = await createRepo();
  try {
    const baselineHeadSha = await gitString(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, "README.md"), "hello\nworld\n", "utf8");
    const outputDir = join(root, reservedOutputRelativeDirForAttempt("attempt-1"));
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "summary.md"), "# summary\n", "utf8");

    const inspection = await inspectWorktree({
      snapshot: await snapshotFor(root, "bakudo-attempt-1"),
      taskId: "bakudo-attempt-1",
      attemptId: "attempt-1",
      baselineHeadSha,
    });

    assert.equal(inspection.baselineHeadSha, baselineHeadSha);
    assert.equal(inspection.currentHeadSha, baselineHeadSha);
    assert.equal(inspection.changeKind, "dirty");
    assert.equal(inspection.dirty, true);
    assert.deepEqual(inspection.dirtyFiles, ["README.md"]);
    assert.deepEqual(inspection.committedFiles, []);
    assert.deepEqual(inspection.repoChangedFiles, ["README.md"]);
    assert.deepEqual(inspection.outputArtifacts, ["summary.md"]);
    assert.match(inspection.patchDiff, /README\.md/u);
    assert.doesNotMatch(inspection.patchDiff, /summary\.md/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectWorktree reports committed-only candidate changes relative to the recorded baseline", async () => {
  const root = await createRepo();
  try {
    const baselineHeadSha = await gitString(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, "README.md"), "hello\ncommitted\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "candidate commit"]);

    const inspection = await inspectWorktree({
      snapshot: await snapshotFor(root, "bakudo-attempt-2"),
      taskId: "bakudo-attempt-2",
      attemptId: "attempt-2",
      baselineHeadSha,
    });

    assert.equal(inspection.baselineHeadSha, baselineHeadSha);
    assert.notEqual(inspection.currentHeadSha, baselineHeadSha);
    assert.equal(inspection.changeKind, "committed");
    assert.equal(inspection.dirty, false);
    assert.deepEqual(inspection.changedFiles, []);
    assert.deepEqual(inspection.dirtyFiles, []);
    assert.deepEqual(inspection.committedFiles, ["README.md"]);
    assert.deepEqual(inspection.repoChangedFiles, ["README.md"]);
    assert.match(inspection.patchDiff, /README\.md/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectWorktree reports mixed committed and dirty candidate changes relative to the recorded baseline", async () => {
  const root = await createRepo();
  try {
    const baselineHeadSha = await gitString(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, "README.md"), "hello\ncommitted\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "candidate commit"]);
    await writeFile(join(root, "notes.txt"), "dirty notes\n", "utf8");
    const outputDir = join(root, reservedOutputRelativeDirForAttempt("attempt-3"));
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "summary.md"), "# summary\n", "utf8");

    const inspection = await inspectWorktree({
      snapshot: await snapshotFor(root, "bakudo-attempt-3"),
      taskId: "bakudo-attempt-3",
      attemptId: "attempt-3",
      baselineHeadSha,
    });

    assert.equal(inspection.changeKind, "mixed");
    assert.equal(inspection.dirty, true);
    assert.deepEqual(inspection.dirtyFiles, ["notes.txt"]);
    assert.deepEqual(inspection.committedFiles, ["README.md"]);
    assert.deepEqual(inspection.repoChangedFiles, ["README.md", "notes.txt"]);
    assert.deepEqual(inspection.outputArtifacts, ["summary.md"]);
    assert.match(inspection.patchDiff, /README\.md/u);
    assert.match(inspection.patchDiff, /notes\.txt/u);
    assert.doesNotMatch(inspection.patchDiff, /summary\.md/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
