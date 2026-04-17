import type { AttemptSpec, AttemptTaskKind } from "../attemptProtocol.js";
import { runAssistantJob } from "./assistantJobRunner.js";
import { runExplicitCommand } from "./commandRunner.js";
import { runVerificationCheck } from "./checkRunner.js";

// ---------------------------------------------------------------------------
// TaskRunnerCommand — the uniform shape runners hand back to workerRuntime
// ---------------------------------------------------------------------------

export type TaskRunnerCommand = {
  command: string[];
  env?: Record<string, string>;
  /** Optional content piped to stdin (e.g. bounded prompt for agent CLI). */
  stdin?: string;
};

export type TaskRunner = (spec: AttemptSpec) => TaskRunnerCommand;

// ---------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------

export const taskRunners: Record<AttemptTaskKind, TaskRunner> = {
  assistant_job: runAssistantJob,
  explicit_command: runExplicitCommand,
  verification_check: runVerificationCheck,
};

/**
 * Resolve a task-kind spec to the concrete command that workerRuntime should
 * spawn. The caller (workerRuntime) is responsible for process management
 * (timeout, capture, heartbeat, progress events).
 */
export const dispatchTaskKind = (spec: AttemptSpec): TaskRunnerCommand => {
  const runner = taskRunners[spec.taskKind];
  return runner(spec);
};
