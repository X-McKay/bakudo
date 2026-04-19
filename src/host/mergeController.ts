import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PreservedCandidateRef = {
  candidateId: string;
  taskId: string;
};

type ExecFileLike = (file: string, args: string[]) => Promise<unknown>;

export const createMergeController = (execFileFn: ExecFileLike = execFileAsync) => {
  const mergePreservedCandidate = async (
    aboxBin: string,
    repoPath: string,
    candidate: PreservedCandidateRef,
  ): Promise<void> => {
    await execFileFn(aboxBin, ["--repo", repoPath, "merge", "--task", candidate.taskId]);
  };

  const discardPreservedCandidate = async (
    aboxBin: string,
    repoPath: string,
    candidate: PreservedCandidateRef,
  ): Promise<void> => {
    await execFileFn(aboxBin, ["--repo", repoPath, "stop", "--task", candidate.taskId, "--clean"]);
  };

  return { mergePreservedCandidate, discardPreservedCandidate };
};

const defaultController = createMergeController();

export const mergeSandbox = async (
  aboxBin: string,
  repoPath: string,
  taskId: string,
): Promise<void> => {
  await defaultController.mergePreservedCandidate(aboxBin, repoPath, {
    candidateId: taskId,
    taskId,
  });
};

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
