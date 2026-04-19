import type { ExecutionProfile } from "../attemptProtocol.js";

export const generateSandboxTaskId = (attemptId: string): string => {
  const sanitized = attemptId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `bakudo-${sanitized.length > 0 ? sanitized : "attempt"}`;
};

export const isEphemeralSandbox = (profile: ExecutionProfile | undefined): boolean =>
  profile?.sandboxLifecycle !== "preserved";

export const buildAboxRunArgs = (
  taskId: string,
  profile: ExecutionProfile,
  repoPath?: string,
): string[] => [
  ...(repoPath ? ["--repo", repoPath] : []),
  "run",
  "--task",
  taskId,
  ...(isEphemeralSandbox(profile) ? ["--ephemeral"] : []),
];

export const sandboxBranchName = (taskId: string): string => `agent/${taskId}`;

export const buildAboxShellCommandArgs = (
  taskId: string,
  command: string,
  profile: ExecutionProfile,
  repoPath?: string,
): string[] => [...buildAboxRunArgs(taskId, profile, repoPath), "--", "bash", "-lc", command];
