import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ApplyWorkspaceUnsupportedSurfaceError,
  createApplyWorkspace,
} from "../../src/host/applyWorkspace.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

const gitStdout = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

const createRepo = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), "bakudo-apply-workspace-"));
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
  await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
  await writeFile(join(repoRoot, "tracked.txt"), "tracked base\n", "utf8");
  await writeFile(join(repoRoot, "staged.txt"), "staged base\n", "utf8");
  await writeFile(join(repoRoot, "delete-me.txt"), "delete me\n", "utf8");
  await writeFile(join(repoRoot, "old-name.txt"), "rename me\n", "utf8");
  await writeFile(join(repoRoot, "untouched.txt"), "untouched\n", "utf8");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
};

test("createApplyWorkspace seeds a detached temp worktree with dirty source state", async () => {
  const repoRoot = await createRepo();
  let workspaceRoot = "";
  try {
    await writeFile(join(repoRoot, "tracked.txt"), "tracked base\nlocal dirty\n", "utf8");
    await writeFile(join(repoRoot, "staged.txt"), "staged base\nstaged edit\n", "utf8");
    await git(repoRoot, ["add", "staged.txt"]);
    await git(repoRoot, ["mv", "old-name.txt", "new-name.txt"]);
    await git(repoRoot, ["rm", "delete-me.txt"]);
    await writeFile(join(repoRoot, "notes.txt"), "untracked notes\n", "utf8");

    const handle = await createApplyWorkspace(repoRoot);
    workspaceRoot = handle.workspaceRoot;
    try {
      assert.notEqual(workspaceRoot, repoRoot);
      assert.equal(await gitStdout(workspaceRoot, ["branch", "--show-current"]), "");
      assert.equal(
        await readFile(join(workspaceRoot, "tracked.txt"), "utf8"),
        "tracked base\nlocal dirty\n",
      );
      assert.equal(
        await readFile(join(workspaceRoot, "staged.txt"), "utf8"),
        "staged base\nstaged edit\n",
      );
      assert.equal(await readFile(join(workspaceRoot, "new-name.txt"), "utf8"), "rename me\n");
      assert.equal(await pathExists(join(workspaceRoot, "old-name.txt")), false);
      assert.equal(await pathExists(join(workspaceRoot, "delete-me.txt")), false);
      assert.equal(await readFile(join(workspaceRoot, "notes.txt"), "utf8"), "untracked notes\n");
      assert.equal(await readFile(join(workspaceRoot, "untouched.txt"), "utf8"), "untouched\n");

      assert.equal(handle.sourceStatus.clean, false);
      assert.deepEqual(
        handle.sourceStatus.entries.map((entry) => ({
          path: entry.path,
          code: `${entry.indexStatus}${entry.worktreeStatus}`,
          originalPath: entry.originalPath,
        })),
        [
          { path: "delete-me.txt", code: "D ", originalPath: undefined },
          { path: "new-name.txt", code: "R ", originalPath: "old-name.txt" },
          { path: "notes.txt", code: "??", originalPath: undefined },
          { path: "staged.txt", code: "M ", originalPath: undefined },
          { path: "tracked.txt", code: " M", originalPath: undefined },
        ],
      );
      assert.deepEqual(handle.sourceStatus.unsupported, []);
    } finally {
      await handle.cleanup();
    }

    assert.equal(await pathExists(workspaceRoot), false);
    const worktrees = await gitStdout(repoRoot, ["worktree", "list", "--porcelain"]);
    assert.equal(worktrees.includes(workspaceRoot), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("createApplyWorkspace cleanup is safe to call more than once", async () => {
  const repoRoot = await createRepo();
  try {
    const handle = await createApplyWorkspace(repoRoot);
    const { workspaceRoot, cleanup } = handle;
    await cleanup();
    await cleanup();
    assert.equal(await pathExists(workspaceRoot), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("createApplyWorkspace rejects unresolved merge state with explicit unsupported surfaces", async () => {
  const repoRoot = await createRepo();
  try {
    await git(repoRoot, ["checkout", "-b", "feature/conflict"]);
    await writeFile(join(repoRoot, "tracked.txt"), "feature change\n", "utf8");
    await git(repoRoot, ["add", "tracked.txt"]);
    await git(repoRoot, ["commit", "-m", "feature change"]);
    await git(repoRoot, ["checkout", "main"]);
    await writeFile(join(repoRoot, "tracked.txt"), "main change\n", "utf8");
    await git(repoRoot, ["add", "tracked.txt"]);
    await git(repoRoot, ["commit", "-m", "main change"]);
    await assert.rejects(
      async () => {
        try {
          await git(repoRoot, ["merge", "feature/conflict"]);
        } catch {
          // Expected conflict.
        }
        await createApplyWorkspace(repoRoot);
      },
      (error: unknown) => {
        assert.ok(error instanceof ApplyWorkspaceUnsupportedSurfaceError);
        assert.deepEqual(error.sourceStatus.unsupported, [
          {
            kind: "unmerged_path",
            path: "tracked.txt",
            detail: "git status reports UU",
          },
        ]);
        return true;
      },
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
