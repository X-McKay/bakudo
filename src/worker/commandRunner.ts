import type { AttemptSpec } from "../attemptProtocol.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * `explicit_command` runner.
 *
 * Uses `spec.execution.command` directly. If the spec carries no command the
 * runner returns a failing `false` command so workerRuntime surfaces a clear
 * error via a non-zero exit code.
 */
export const runExplicitCommand = (spec: AttemptSpec): TaskRunnerCommand => {
  const command = spec.execution.command;
  if (!command || command.length === 0) {
    return { command: ["false"] };
  }
  return { command };
};
