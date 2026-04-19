import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorktreeSnapshot = {
  path: string;
  branch: string;
  head: string;
};

export const parseWorktreePorcelain = (
  output: string,
  expectedBranch: string,
): WorktreeSnapshot | null => {
  let currentPath = "";
  let currentHead = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      currentHead = "";
      continue;
    }
    if (line.startsWith("HEAD ")) {
      currentHead = line.slice("HEAD ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      const branch = line.slice("branch ".length).trim();
      if (branch === expectedBranch) {
        return {
          path: currentPath,
          branch,
          head: currentHead,
        };
      }
    }
  }
  return null;
};

export const discoverWorktree = async (
  repoPath: string,
  taskId: string,
): Promise<WorktreeSnapshot | null> => {
  const expectedBranch = `refs/heads/agent/${taskId}`;
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
    });
    return parseWorktreePorcelain(stdout, expectedBranch);
  } catch {
    return null;
  }
};
