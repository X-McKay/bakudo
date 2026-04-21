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
  // abox v0.3.0: pass resource constraints when explicitly set in the profile.
  // These override the abox config defaults and come from ResourceBudget role
  // definitions (Wave 5). Omitting them lets abox use its own defaults.
  ...(profile.memoryMiB !== undefined ? ["--memory", String(profile.memoryMiB)] : []),
  ...(profile.cpus !== undefined ? ["--cpus", String(profile.cpus)] : []),
];

export const sandboxBranchName = (taskId: string): string => `agent/${taskId}`;

export const buildAboxShellCommandArgs = (
  taskId: string,
  command: string,
  profile: ExecutionProfile,
  repoPath?: string,
): string[] => [...buildAboxRunArgs(taskId, profile, repoPath), "--", "bash", "-lc", command];
