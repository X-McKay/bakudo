/**
 * Wave 2: Chaos Monkey Runner
 *
 * Implements the adversarial evaluator that runs in the same preserved sandbox
 * as the Worker agent. Its sole job is to find edge cases, security flaws, or
 * missing logic in the code the Worker just produced, and write a *failing*
 * test that proves the flaw.
 *
 * If the Chaos Monkey cannot find any flaw, it outputs exactly "LGTM" so the
 * `headlessExecute` loop can detect a clean pass.
 *
 * Security note: the Chaos Monkey runs inside the abox microVM with the same
 * sandbox lifecycle as the Worker ("preserved"), so it sees the exact file
 * state the Worker left behind. It does NOT have write access to the host.
 */
import { reservedGuestOutputDirForAttempt } from "../attemptPath.js";
import type { AttemptSpec } from "../attemptProtocol.js";
import { providerRegistry } from "../host/providerRegistry.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * The adversarial system prompt injected as stdin for the Chaos Monkey agent.
 *
 * Constraints:
 * - MUST NOT fix the code — only write failing tests.
 * - MUST output exactly "LGTM" (case-sensitive) if no flaws are found.
 * - MUST review the recent `git diff` to understand what was just written.
 */
export const CHAOS_MONKEY_PROMPT = `
You are the Chaos Monkey. Your job is to break the code that was just written.

Instructions:
1. Run \`git diff HEAD~1\` (or \`git diff\` if there is only one commit) to review the recent changes.
2. Carefully analyse the diff for edge cases, security flaws, off-by-one errors, missing null checks, or unhandled error paths.
3. If you find a flaw, write a NEW failing test case that proves the flaw exists. Place it in the appropriate test file.
4. Do NOT fix the code. Only write tests that fail.
5. If you cannot find any flaws after a thorough review, output exactly: LGTM

Output format:
- If a flaw is found: describe the flaw briefly, then write the failing test.
- If no flaw is found: output only the word LGTM on its own line.
`.trim();

/**
 * Build the {@link TaskRunnerCommand} for the Chaos Monkey adversarial
 * evaluator. The command is resolved from the `"chaos-monkey"` provider in
 * the {@link providerRegistry}; the adversarial prompt is piped via stdin.
 */
export const runChaosMonkey = (spec: AttemptSpec): TaskRunnerCommand => {
  const provider = providerRegistry.get("chaos-monkey");
  const guestOutputDir = reservedGuestOutputDirForAttempt(spec.attemptId);

  return {
    command: provider.command,
    stdin: CHAOS_MONKEY_PROMPT,
    env: {
      BAKUDO_GUEST_OUTPUT_DIR: guestOutputDir,
      // Signal to the agent that it is operating in adversarial mode so it
      // does not accidentally apply any "helpful" fixes.
      BAKUDO_CHAOS_MONKEY: "1",
    },
  };
};

/**
 * Determine whether a Chaos Monkey output string represents a clean pass.
 *
 * The contract is strict: the output must contain the exact token "LGTM"
 * (case-sensitive) to be treated as a pass. Any other output is treated as
 * a flaw report that should trigger a Worker retry.
 */
export const isChaosMonkeyLgtm = (output: string): boolean => {
  // Allow the LGTM token to appear anywhere in the output (the agent may
  // emit trailing whitespace or a brief preamble before the token).
  return output.includes("LGTM");
};
