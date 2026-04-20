import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PreservedCandidateRef = {
  candidateId: string;
  taskId: string;
};

type ExecFileLike = (file: string, args: string[]) => Promise<unknown>;

export const createSandboxCleanupController = (execFileFn: ExecFileLike = execFileAsync) => {
  const discardPreservedCandidate = async (
    aboxBin: string,
    repoPath: string,
    candidate: PreservedCandidateRef,
  ): Promise<void> => {
    await execFileFn(aboxBin, ["--repo", repoPath, "stop", candidate.taskId, "--clean"]);
  };

  return { discardPreservedCandidate };
};

const defaultController = createSandboxCleanupController();

export const discardSandbox = async (
  aboxBin: string,
  repoPath: string,
  taskId: string,
): Promise<void> => {
  await defaultController.discardPreservedCandidate(aboxBin, repoPath, {
    candidateId: taskId,
    taskId,
  });
};
