import { reservedGuestOutputDirForAttempt } from "../attemptPath.js";
import type { AttemptSpec, ExecutionProfile } from "../attemptProtocol.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * `assistant_job` runner.
 *
 * Builds an agent invocation from `profile.agentBackend` and pipes a bounded
 * prompt via stdin so it is not subject to ARG_MAX limits.
 */
export const runAssistantJob = (
  spec: AttemptSpec,
  profile: ExecutionProfile,
): TaskRunnerCommand => {
  const command = profile.agentBackend
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (command.length === 0) {
    throw new Error("invalid execution profile: agentBackend is empty");
  }
  const boundedPrompt = [spec.prompt, ...spec.instructions].join("\n\n");
  const guestOutputDir = reservedGuestOutputDirForAttempt(spec.attemptId);

  return {
    command,
    stdin: boundedPrompt,
    env: {
      BAKUDO_GUEST_OUTPUT_DIR: guestOutputDir,
    },
  };
};
