import type { AttemptSpec } from "../attemptProtocol.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * `assistant_job` runner.
 *
 * Builds a `claude` CLI invocation for single-shot execution inside the guest.
 * The bounded prompt (spec.prompt + instructions joined) is passed via stdin
 * so it is not subject to ARG_MAX limits.
 *
 * Flags:
 * - `--print`                        — single-shot, stdout-only
 * - `--dangerously-skip-permissions` — when spec.permissions.allowAllTools
 */
export const runAssistantJob = (spec: AttemptSpec): TaskRunnerCommand => {
  const args: string[] = ["claude"];

  if (spec.permissions.allowAllTools) {
    args.push("--dangerously-skip-permissions");
  }

  args.push("--print");

  // Build the bounded prompt: prompt + instructions joined with newlines.
  const boundedPrompt = [spec.prompt, ...spec.instructions].join("\n\n");

  // Pass prompt as a positional argument (claude --print "<prompt>")
  args.push(boundedPrompt);

  return { command: args };
};
