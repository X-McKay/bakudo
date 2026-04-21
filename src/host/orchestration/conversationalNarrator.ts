/**
 * Conversational Narrator
 *
 * Provides the "voice" of the Cognitive Meta-Orchestrator in the interactive
 * shell. Three responsibilities:
 *
 * 1. **Pre-flight clarification** — Before decomposing a complex goal, send a
 *    `clarify` task to the `MacroOrchestrationSession`. If the session decides
 *    the goal is ambiguous, emit a clarifying question into the transcript and
 *    return `{ needsClarification: true }` so the caller can pause and wait
 *    for the user's answer before proceeding. The session is the sole
 *    decision-maker — there are no regex patterns or heuristic rules.
 *
 * 2. **Prose narration** — Translate raw orchestrator events (campaign started,
 *    worker running, synthesis complete) into warm, first-person prose that
 *    reads like a collaborator explaining its work rather than a log dump.
 *
 * 3. **Status query answering** — When the user asks "how are things going?",
 *    send a `status` task to the `MacroOrchestrationSession` with the full
 *    orchestrator state. The session generates a contextual, conversational
 *    prose summary that is aware of the full session history.
 *
 * All functions are pure with respect to side effects: they receive the store
 * and dispatch to it, but they never mutate state directly.
 */

import type { HostStore } from "../store/index.js";
import type { Campaign, Objective } from "./objectiveState.js";
import type { MacroOrchestrationSession } from "./macroOrchestrationSession.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClarificationResult =
  | { needsClarification: false }
  | { needsClarification: true; question: string };

// ---------------------------------------------------------------------------
// Pre-flight clarification — session-backed
// ---------------------------------------------------------------------------

type ClarifyResult = {
  needsClarification: boolean;
  question?: string;
};

/**
 * Ask the macro session whether the goal needs clarification before
 * decomposition begins.
 *
 * The session has full conversation context, so it can correctly handle
 * follow-up goals that reference prior turns ("same as before", "the one
 * we discussed earlier").
 *
 * @param goal    - The user's raw goal text.
 * @param session - The active `MacroOrchestrationSession`.
 *
 * @returns `{ needsClarification: false }` when the goal is clear enough,
 *          or `{ needsClarification: true, question }` when a clarification
 *          should be emitted and execution should pause.
 *          On session error, returns `{ needsClarification: false }` so the
 *          orchestrator is never blocked by a transient failure.
 */
export const checkClarification = async (
  goal: string,
  session: MacroOrchestrationSession,
): Promise<ClarificationResult> => {
  try {
    const result = await session.send<ClarifyResult>({
      task: "clarify",
      payload: { goal },
    });
    if (result.needsClarification === false) {
      return { needsClarification: false };
    }
    if (
      result.needsClarification === true &&
      typeof result.question === "string" &&
      result.question.length > 0
    ) {
      return { needsClarification: true, question: result.question };
    }
    // Malformed response — proceed without clarification.
    return { needsClarification: false };
  } catch {
    // Session unavailable — proceed without clarification.
    return { needsClarification: false };
  }
};

/**
 * Emit a clarifying question into the transcript as an assistant message.
 * The caller is responsible for waiting for the user's reply before calling
 * `runObjectiveInTUI`.
 */
export const emitClarification = (store: HostStore, question: string): void => {
  store.dispatch({
    type: "append_assistant",
    text: question,
    tone: "info",
  });
};

// ---------------------------------------------------------------------------
// Prose narration helpers
// (These emit fixed prose directly — no session call needed since they are
// triggered by known lifecycle events, not user input that requires reasoning.)
// ---------------------------------------------------------------------------

/**
 * Emit a warm, first-person narration line when a new objective is accepted.
 * Called once at the start of `runObjectiveInTUI`, before the first advance.
 */
export const narrateObjectiveStart = (store: HostStore, goal: string): void => {
  store.dispatch({
    type: "append_assistant",
    text: `On it. I'll break "${goal}" into parallel campaigns and work through them. You can track progress in the sidebar or ask me for a status update at any time.`,
    tone: "info",
  });
};

/**
 * Emit a narration line when the Architect has decomposed the objective into
 * campaigns. Describes the plan in plain English before execution begins.
 */
export const narrateDecomposition = (
  store: HostStore,
  campaigns: ReadonlyArray<Campaign>,
): void => {
  if (campaigns.length === 0) {
    return;
  }
  const count = campaigns.length;
  const descriptions = campaigns.map((c) => `"${c.description}"`);
  let text: string;
  if (count === 1) {
    text = `I've broken this down into one campaign: ${descriptions[0]}. Starting now.`;
  } else if (count === 2) {
    text = `I've decomposed this into ${count} campaigns: ${descriptions[0]} and ${descriptions[1]}. Running them in parallel.`;
  } else {
    const last = descriptions[descriptions.length - 1];
    const rest = descriptions.slice(0, -1).join(", ");
    text = `I've decomposed this into ${count} campaigns: ${rest}, and ${last}. Running them in parallel — I'll synthesise the results when they're done.`;
  }
  store.dispatch({ type: "append_assistant", text, tone: "info" });
};

/**
 * Emit a narration line when a campaign completes successfully.
 */
export const narrateCampaignComplete = (
  store: HostStore,
  campaign: Campaign,
  remainingCount: number,
): void => {
  const verdict = campaign.synthesisRecord
    ? `The Synthesizer merged the best ideas from ${campaign.synthesisRecord.mergedFrom.length} candidates.`
    : campaign.winnerCandidateId
      ? `Candidate ${campaign.winnerCandidateId} was selected as the winner.`
      : "The campaign completed successfully.";

  const remaining =
    remainingCount > 0
      ? ` ${remainingCount} campaign${remainingCount !== 1 ? "s" : ""} still running.`
      : " That was the last one.";

  store.dispatch({
    type: "append_assistant",
    text: `✓ "${campaign.description}" is done. ${verdict}${remaining}`,
    tone: "success",
  });
};

/**
 * Emit a narration line when a campaign fails.
 */
export const narrateCampaignFailed = (
  store: HostStore,
  campaign: Campaign,
  remainingCount: number,
): void => {
  const remaining =
    remainingCount > 0
      ? ` ${remainingCount} campaign${remainingCount !== 1 ? "s" : ""} still running.`
      : " That was the last one.";

  store.dispatch({
    type: "append_assistant",
    text: `✗ "${campaign.description}" failed after exhausting all candidates. The Critic's notes are in the sidebar.${remaining}`,
    tone: "warning",
  });
};

/**
 * Emit a narration line when the entire objective completes.
 */
export const narrateObjectiveComplete = (
  store: HostStore,
  objective: Objective,
): void => {
  const succeeded = objective.campaigns.filter((c) => c.status === "completed").length;
  const total = objective.campaigns.length;
  const allGood = succeeded === total;

  const text = allGood
    ? `All done. ${total} campaign${total !== 1 ? "s" : ""} completed successfully. The changes are on a branch ready for your review.`
    : `Finished with ${succeeded}/${total} campaigns successful. The ${total - succeeded} that failed are documented in the sidebar — you may want to retry them or adjust the goal.`;

  store.dispatch({ type: "append_assistant", text, tone: allGood ? "success" : "warning" });
};

/**
 * Emit a narration line when the entire objective fails.
 */
export const narrateObjectiveFailed = (store: HostStore, reason: string): void => {
  store.dispatch({
    type: "append_assistant",
    text: `I wasn't able to complete this objective. ${reason} Check the sidebar for per-campaign details, or try rephrasing the goal.`,
    tone: "error",
  });
};

// ---------------------------------------------------------------------------
// Status query answering — session-backed
// ---------------------------------------------------------------------------

/**
 * Ask the macro session to generate a prose status summary from the current
 * orchestrator state and emit it as an assistant message.
 *
 * The session has full conversation context, so the summary can reference
 * prior turns and provide genuine narrative continuity rather than a generic
 * state dump.
 *
 * @param store   - The host store (used to read state and dispatch the reply).
 * @param session - The active `MacroOrchestrationSession`.
 */
export const answerStatusQuery = async (
  store: HostStore,
  session: MacroOrchestrationSession,
): Promise<void> => {
  const state = store.getSnapshot();
  // Serialise the orchestrator slice as the payload — the session has the
  // full context to interpret it correctly.
  const orchestratorState = state.orchestrator as unknown as Record<string, unknown>;

  try {
    const result = await session.send<{ summary: string }>({
      task: "status",
      payload: { orchestratorState },
    });
    const summary =
      typeof result.summary === "string" && result.summary.length > 0
        ? result.summary
        : "Nothing is running right now. Give me a complex goal and I'll get started.";
    store.dispatch({ type: "append_assistant", text: summary, tone: "info" });
  } catch {
    // Session unavailable — emit a minimal fallback.
    store.dispatch({
      type: "append_assistant",
      text: "I'm not able to check the status right now. Try again in a moment.",
      tone: "warning",
    });
  }
};

// ---------------------------------------------------------------------------
// Steering acknowledgement
// ---------------------------------------------------------------------------

/**
 * Emit a brief acknowledgement when a steering command is received.
 * The actual steering logic lives in `OrchestratorDriver.handleSteering()`.
 */
export const acknowledgeSteeringCommand = (store: HostStore, command: string): void => {
  store.dispatch({
    type: "append_assistant",
    text: `Got it — adjusting the plan: "${command}".`,
    tone: "info",
  });
};
