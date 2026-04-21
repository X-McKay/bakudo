import { reservedGuestOutputDirForAttempt } from "../attemptPath.js";
import type { AttemptSpec, ExecutionProfile } from "../attemptProtocol.js";
import { providerRegistry } from "../host/providerRegistry.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * `assistant_job` runner.
 *
 * Wave 1: Resolves the agent command via the {@link providerRegistry} using
 * `profile.providerId`. Falls back to splitting `profile.agentBackend` for
 * backwards-compatibility with pre-Wave-1 serialised profiles.
 *
 * The bounded prompt is piped via stdin so it is not subject to ARG_MAX
 * limits.
 */
export const runAssistantJob = (
  spec: AttemptSpec,
  profile: ExecutionProfile,
): TaskRunnerCommand => {
  const resolvedProviderId = profile.providerId ?? profile.agentBackend;
  if (!resolvedProviderId) {
    throw new Error(
      "invalid execution profile: neither providerId nor agentBackend is set",
    );
  }

  let command: string[];

  if (profile.providerId !== undefined) {
    // Wave 1 path: look up the registered provider.
    const provider = providerRegistry.get(profile.providerId);
    command = provider.command;
  } else {
    // Legacy fallback: split the raw agentBackend string.
    // This path is retained for backwards-compatibility only and will be
    // removed once all callers have migrated to providerId.
    command = (profile.agentBackend ?? "")
      .split(" ")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (command.length === 0) {
      throw new Error("invalid execution profile: agentBackend is empty");
    }
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
