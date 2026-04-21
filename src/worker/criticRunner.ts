/**
 * Wave 4: Critic Runner
 *
 * The Critic is a Reflection Agent that analyses why a Worker failed after
 * multiple retries. It produces a structured Post-Mortem starting with
 * "LESSON LEARNED: " that the Curator can consolidate into the Semantic
 * Memory Knowledge Graph.
 *
 * The Critic runs inside the same abox sandbox as the failed Worker so it
 * has access to the exact file state and git history at the time of failure.
 *
 * Security note: the Critic is read-only. It MUST NOT modify any files or
 * run git commands. It only reads the transcript and diff, then outputs
 * a Post-Mortem via stdout.
 */
import { providerRegistry } from "../host/providerRegistry.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

// ---------------------------------------------------------------------------
// Critic prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt injected as stdin for the Critic agent.
 *
 * Constraints:
 * - MUST output a Post-Mortem starting with "LESSON LEARNED: ".
 * - MUST NOT modify any files or run git commands.
 * - MUST analyse the root cause, not just the symptoms.
 */
export const CRITIC_PROMPT = `
You are the Critic. The Worker agent just failed to complete its task after multiple retries.
Below is the execution transcript and the final git diff.

Analyze exactly WHY the Worker failed. Consider:
- Syntax errors or type errors in the generated code
- Misunderstanding of the codebase structure or conventions
- Wrong package manager or tooling commands
- Missing dependencies or imports
- Logic errors in the implementation
- Test failures that reveal incorrect assumptions

Output a structured Post-Mortem starting with "LESSON LEARNED: " followed by:
1. Root cause (one sentence)
2. Evidence from the transcript (quote the relevant lines)
3. Generalizable rule to prevent this in future (one actionable sentence)

Example:
LESSON LEARNED: The Worker used npm instead of pnpm.
Root cause: The Worker defaulted to npm without checking the project's package manager.
Evidence: "npm install" failed with "This project uses pnpm".
Rule: Always run \`cat package.json | grep packageManager\` before installing dependencies.
`.trim();

// ---------------------------------------------------------------------------
// Critic runner
// ---------------------------------------------------------------------------

/**
 * Build the {@link TaskRunnerCommand} for the Critic reflection agent.
 * The failed transcript and diff are injected via stdin.
 *
 * @param transcript  The full execution transcript from the failed Worker run.
 * @param diff        The git diff at the time of failure (may be empty).
 */
export const runCritic = (transcript: string, diff: string): TaskRunnerCommand => {
  const provider = providerRegistry.get("critic");

  const stdin = [
    CRITIC_PROMPT,
    "",
    "TRANSCRIPT:",
    transcript,
    "",
    "DIFF:",
    diff.length > 0 ? diff : "(no diff — no changes were committed)",
  ].join("\n");

  return {
    command: provider.command,
    stdin,
    env: {
      // Signal to the agent that it is in read-only reflection mode.
      BAKUDO_CRITIC_MODE: "1",
    },
  };
};

// ---------------------------------------------------------------------------
// Post-Mortem helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a Critic output string contains a valid Post-Mortem.
 * The output MUST start with "LESSON LEARNED: " to be treated as a valid
 * Post-Mortem that the Curator can consolidate.
 */
export const isValidPostMortem = (output: string): boolean => {
  return output.includes("LESSON LEARNED:");
};

/**
 * Extract the Post-Mortem text from a Critic output string.
 * Returns the text from "LESSON LEARNED:" to the end of the output.
 * Returns `null` if no valid Post-Mortem is found.
 */
export const extractPostMortem = (output: string): string | null => {
  const index = output.indexOf("LESSON LEARNED:");
  if (index === -1) return null;
  return output.slice(index).trim();
};
