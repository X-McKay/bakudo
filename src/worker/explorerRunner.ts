/**
 * Wave 5: Explorer Runner — Reconnaissance Agent
 *
 * The Explorer runs before the Architect decomposes an Objective. It performs
 * proactive reconnaissance of the codebase and relevant documentation,
 * producing an Intelligence Report that the Architect uses to ground its
 * Campaign plan in reality (rather than hallucinated context).
 *
 * The Explorer is read-only: it MUST NOT write any files or run git commands.
 * It has broad egress access (via the `web-read` abox policy) to fetch
 * documentation and API references.
 *
 * Explorer-stuck fallback: when the Critic returns `NEEDS_EXPLORATION` instead
 * of `LESSON_LEARNED`, the ObjectiveController re-runs the Explorer with the
 * failure context and re-decomposes the failed Campaign.
 */
import { providerRegistry } from "../host/providerRegistry.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

// ---------------------------------------------------------------------------
// Explorer prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt injected as stdin for the Explorer agent.
 *
 * The Explorer MUST produce an Intelligence Report answering the five
 * questions below. It MUST NOT propose a plan — that is the Architect's job.
 */
export const EXPLORER_PROMPT = `
You are the Explorer. You are given an Objective and read-only access to the codebase.
You do NOT write code. You produce an Intelligence Report.

Your report must answer, in order:
1. Which files/modules are relevant to this Objective? (cite paths)
2. Which external libraries or APIs will be involved? (cite real docs, not guesses)
3. What is the current behavior we are about to change? (cite specific functions/lines)
4. What are the top 3 ways this Objective could go wrong?
5. What open questions should the Architect answer before planning?

Output the report as Markdown. Do NOT propose a plan — that is the Architect's job.
`.trim();

/**
 * The system prompt for re-running the Explorer after a Worker failure with
 * `NEEDS_EXPLORATION` verdict from the Critic.
 */
export const EXPLORER_RETRY_PROMPT = `
You are the Explorer. A Worker failed on the Campaign below and the Critic determined that
the failure was caused by insufficient context about the codebase or external dependencies.

Re-run your reconnaissance with the failure context in mind. Focus specifically on:
1. The exact files/functions the Worker touched (cite paths and line numbers).
2. The external library or API behavior that was misunderstood.
3. The specific constraint or invariant the Worker violated.
4. Concrete steps the Architect should take differently in the next Campaign.

Output the updated Intelligence Report as Markdown.
`.trim();

// ---------------------------------------------------------------------------
// Explorer runner
// ---------------------------------------------------------------------------

/**
 * Build the {@link TaskRunnerCommand} for the Explorer reconnaissance agent.
 *
 * @param objectiveGoal  The high-level Objective goal string.
 */
export const runExplorer = (objectiveGoal: string): TaskRunnerCommand => {
  const provider = providerRegistry.get("explorer");

  const stdin = [EXPLORER_PROMPT, "", "OBJECTIVE:", objectiveGoal].join("\n");

  return {
    command: provider.command,
    stdin,
    env: {
      BAKUDO_EXPLORER_MODE: "1",
    },
  };
};

/**
 * Build the {@link TaskRunnerCommand} for a retry Explorer run after a
 * Worker failure with `NEEDS_EXPLORATION` verdict.
 *
 * @param objectiveGoal  The high-level Objective goal string.
 * @param campaignId     The ID of the failed Campaign.
 * @param failureContext The Critic's failure analysis (without LESSON_LEARNED prefix).
 */
export const runExplorerRetry = (
  objectiveGoal: string,
  campaignId: string,
  failureContext: string,
): TaskRunnerCommand => {
  const provider = providerRegistry.get("explorer");

  const stdin = [
    EXPLORER_RETRY_PROMPT,
    "",
    "OBJECTIVE:",
    objectiveGoal,
    "",
    `FAILED CAMPAIGN: ${campaignId}`,
    "",
    "FAILURE CONTEXT:",
    failureContext,
  ].join("\n");

  return {
    command: provider.command,
    stdin,
    env: {
      BAKUDO_EXPLORER_MODE: "1",
      BAKUDO_EXPLORER_RETRY: "1",
    },
  };
};

// ---------------------------------------------------------------------------
// Intelligence Report helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an Explorer output string contains a valid Intelligence
 * Report. The report MUST contain at least one Markdown heading.
 */
export const isValidIntelligenceReport = (output: string): boolean => {
  return output.includes("#") && output.length > 100;
};

/**
 * Determine whether a Critic output string signals that the Explorer should
 * be re-run. The Critic signals this by including "NEEDS_EXPLORATION" in its
 * output instead of (or in addition to) "LESSON LEARNED:".
 */
export const criticNeedsExploration = (criticOutput: string): boolean => {
  return criticOutput.includes("NEEDS_EXPLORATION");
};
