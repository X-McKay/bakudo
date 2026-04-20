import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";

import {
  reservedOutputRelativeDirForAttempt,
  inspectWorktree,
} from "../../src/host/worktreeInspector.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

test("inspectWorktree separates repo changes from reserved output artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-worktree-"));
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "bakudo@example.test"]);
    await git(root, ["config", "user.name", "Bakudo Tests"]);
    await writeFile(join(root, "README.md"), "hello\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "initial"]);

    await writeFile(join(root, "README.md"), "hello\nworld\n", "utf8");
    const outputDir = join(root, reservedOutputRelativeDirForAttempt("attempt-1"));
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "summary.md"), "# summary\n", "utf8");

    const inspection = await inspectWorktree({
      snapshot: {
        path: root,
        branch: "refs/heads/agent/bakudo-attempt-1",
        head: "HEAD",
      },
      taskId: "bakudo-attempt-1",
      attemptId: "attempt-1",
    });

    assert.deepEqual(inspection.repoChangedFiles, ["README.md"]);
    assert.deepEqual(inspection.outputArtifacts, ["summary.md"]);
    assert.equal(inspection.reservedOutputDir, ".bakudo/out/attempt-1");
    assert.match(inspection.patchDiff, /README\.md/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
