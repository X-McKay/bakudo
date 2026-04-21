/**
 * Routing Classifier
 *
 * Classifies a user's natural-language input into one of four routing
 * categories by sending a `classify` task to the persistent
 * `MacroOrchestrationSession`. There are no regex patterns, no keyword lists,
 * and no heuristic fallbacks — the model is the sole decision-maker.
 *
 * Four categories:
 *
 * `simple`           — Single-shot SessionController path (questions, lookups,
 *                      slash commands, short factual requests).
 *
 * `complex`          — Meta-orchestrator path (multi-step engineering goals
 *                      that require decomposition into campaigns).
 *                      Routes to OrchestratorDriver → ObjectiveController.
 *
 * `status_query`     — Conversational status check about an in-progress or
 *                      completed objective ("how are things going?", "what's
 *                      the status?"). Answered by the ConversationalNarrator
 *                      without starting new work.
 *
 * `steering_command` — Mid-run directive to modify the active objective
 *                      ("skip campaign 2", "focus only on the auth module",
 *                      "abort"). Only meaningful when an objective is running.
 *
 * The `MacroOrchestrationSession` is a persistent Claude Code / Codex process
 * that lives for the duration of the bakudo interactive shell. It has full
 * context of the conversation, so classification decisions can reference prior
 * turns (e.g. "same reason as last time" is understood correctly).
 *
 * On session error, `classifyGoal` defaults to `"complex"` so goals are never
 * silently dropped.
 */

import type { MacroOrchestrationSession } from "./macroOrchestrationSession.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GoalComplexity =
  | "simple"
  | "complex"
  | "status_query"
  | "steering_command";

// ---------------------------------------------------------------------------
// Classification result schema
// ---------------------------------------------------------------------------

type ClassifyResult = {
  classification: string;
};

const VALID_CATEGORIES = new Set<string>([
  "simple",
  "complex",
  "status_query",
  "steering_command",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a user's natural-language goal using the macro session.
 *
 * @param text               - The raw user input (trimmed).
 * @param hasActiveObjective - Whether an objective is currently running.
 * @param session            - The active `MacroOrchestrationSession`.
 *
 * @returns The four-way classification. On session error, defaults to
 *          `"complex"` so goals are never silently dropped.
 */
export const classifyGoal = async (
  text: string,
  hasActiveObjective: boolean,
  session: MacroOrchestrationSession,
): Promise<GoalComplexity> => {
  try {
    const result = await session.send<ClassifyResult>({
      task: "classify",
      payload: { text, hasActiveObjective },
    });
    const value = result.classification;
    if (typeof value === "string" && VALID_CATEGORIES.has(value)) {
      return value as GoalComplexity;
    }
    // Unrecognised value — default to complex.
    return "complex";
  } catch {
    // Session unavailable — default to complex so the goal is not dropped.
    return "complex";
  }
};
