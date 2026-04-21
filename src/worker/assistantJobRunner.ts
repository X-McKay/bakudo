import { reservedGuestOutputDirForAttempt } from "../attemptPath.js";
import type { AttemptSpec, ExecutionProfile } from "../attemptProtocol.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * `assistant_job` runner.
 *
 * Wave 1 (revised): Uses `profile.resolvedCommand` — the command array
 * pre-resolved by the host via the {@link providerRegistry} before the
 * profile was serialised into the sandbox. This keeps the worker bundle
 * free of host-only dependencies (registry, zod).
 *
 * The bounded prompt is piped via stdin so it is not subject to ARG_MAX
 * limits.
 */
export const runAssistantJob = (
  spec: AttemptSpec,
  profile: ExecutionProfile,
): TaskRunnerCommand => {
  const command = profile.resolvedCommand;
  if (!command || command.length === 0) {
    throw new Error(
      `invalid execution profile for provider "${profile.providerId}": resolvedCommand is empty`,
    );
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
