/**
 * Orchestrator Driver
 *
 * Bridges the interactive TUI and the Cognitive Meta-Orchestrator pipeline.
 * When the user types a complex goal, `runObjectiveInTUI()` is called instead
 * of the single-shot SessionController path.
 *
 * Responsibilities:
 * 1. Run a pre-flight clarification check via `ConversationalNarrator`.
 * 2. Create an `Objective` and an `ObjectiveController`.
 * 3. Dispatch `orchestrator_start` so the Sidebar shows the new objective.
 * 4. Emit warm, first-person prose narration at key lifecycle moments.
 * 5. Call `controller.advance()` in a loop until the objective is terminal.
 * 6. After each `advance()`, dispatch `orchestrator_objective_update` so the
 *    Sidebar reflects the latest campaign tree.
 * 7. Stream human-readable progress events into the transcript.
 * 8. On completion, record the objective in session memory and emit narration.
 * 9. On failure, record the objective in session memory and emit narration.
 *
 * Also exports `handleSteering()` for mid-run steering commands, and
 * `handleStatusQuery()` which delegates to `ConversationalNarrator`.
 *
 * Git Mutex:
 * The caller (interactive.ts) constructs a single `Mutex` instance and passes
 * it here. The same mutex is passed to `ObjectiveController` so all background
 * git writes are serialised across the whole session.
 *
 * Constraint: SessionController is NEVER touched from this file.
 */

import { randomUUID } from "node:crypto";
import type { ABoxTaskRunner } from "../../aboxTaskRunner.js";
import type { HostStore } from "../store/index.js";
import { ObjectiveController } from "./objectiveController.js";
import { createObjective } from "./objectiveState.js";
import type { Campaign } from "./objectiveState.js";
import {
  narrateObjectiveStart,
  narrateDecomposition,
  narrateCampaignComplete,
  narrateCampaignFailed,
  narrateObjectiveComplete,
  narrateObjectiveFailed,
  acknowledgeSteeringCommand,
  answerStatusQuery,
} from "./conversationalNarrator.js";
import type { MacroOrchestrationSession } from "./macroOrchestrationSession.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal mutex interface — compatible with `async-mutex`'s `Mutex`. */
export type GitWriteMutex = {
  acquire(): Promise<() => void>;
};

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

/**
 * Emit a human-readable event line into the transcript.
 * Uses the `append_event` action so it renders with the EventLine component.
 */
const emitEvent = (store: HostStore, label: string, detail?: string): void => {
  if (detail !== undefined) {
    store.dispatch({ type: "append_event", label, detail });
  } else {
    store.dispatch({ type: "append_event", label });
  }
};

/**
 * Emit a review card (Critic / Synthesizer verdict) into the transcript.
 */
const emitReview = (
  store: HostStore,
  outcome: string,
  summary: string,
  nextAction?: string,
): void => {
  if (nextAction !== undefined) {
    store.dispatch({ type: "append_review", outcome, summary, nextAction });
  } else {
    store.dispatch({ type: "append_review", outcome, summary });
  }
};

// ---------------------------------------------------------------------------
// Campaign status summary
// ---------------------------------------------------------------------------

const campaignStatusIcon = (status: string): string => {
  switch (status) {
    case "pending":
      return "⏳";
    case "running":
      return "▶";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "·";
  }
};

// ---------------------------------------------------------------------------
// Status query handler (public — called from interactive.ts)
// ---------------------------------------------------------------------------

/**
 * Answer a status query ("how are things going?") by synthesising the current
 * orchestrator state into a prose summary. Delegates to `answerStatusQuery`.
 */
export const handleStatusQuery = async (
  store: HostStore,
  session: MacroOrchestrationSession,
): Promise<void> => {
  await answerStatusQuery(store, session);
};

// ---------------------------------------------------------------------------
// Steering command handler (public — called from interactive.ts)
// ---------------------------------------------------------------------------

/**
 * Handle a mid-run steering command ("skip campaign 2", "focus on auth", etc.).
 *
 * In the current implementation the steering command is acknowledged and
 * recorded as a narration line. Full steering (actually cancelling or
 * redirecting a running campaign) requires ObjectiveController support that
 * is tracked as a P2 item. For now the acknowledgement ensures the user gets
 * feedback and the command is visible in the transcript.
 */
export const handleSteering = (store: HostStore, command: string): void => {
  acknowledgeSteeringCommand(store, command);
  // Emit a structured event so it also appears in the sidebar's verdict area.
  emitEvent(store, "steering", command);
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Drive an `ObjectiveController` to completion, streaming live progress into
 * the TUI store with warm, first-person prose narration at each lifecycle
 * milestone.
 *
 * @param goal           - The user's natural-language goal string.
 * @param runner         - The shared `ABoxTaskRunner` for the session.
 * @param store          - The TUI host store (for dispatching progress events).
 * @param gitWriteMutex  - The session-scoped git write mutex.
 */
export const runObjectiveInTUI = async (
  goal: string,
  runner: ABoxTaskRunner,
  store: HostStore,
  gitWriteMutex: GitWriteMutex,
): Promise<void> => {
  const objectiveId = `obj-${randomUUID().slice(0, 8)}`;
  const objective = createObjective(objectiveId, goal);

  // Register the new objective in the store so the Sidebar shows it.
  store.dispatch({ type: "orchestrator_start", objective });

  // Emit warm, first-person opening narration.
  narrateObjectiveStart(store, goal);

  const controller = new ObjectiveController(objective, runner, gitWriteMutex);

  // Track campaign state across advances to detect transitions.
  let lastCampaignCount = 0;
  const campaignCompletedIds = new Set<string>();
  const campaignFailedIds = new Set<string>();
  let decompositionNarrated = false;

  let advanceCount = 0;
  const MAX_ADVANCES = 50; // safety cap — prevents infinite loops

  try {
    while (controller.isActive() && advanceCount < MAX_ADVANCES) {
      advanceCount += 1;

      // Signal git mutex lock before advance (conservative — actual lock is
      // inside ObjectiveController; we mirror it for the sidebar indicator).
      store.dispatch({ type: "orchestrator_git_mutex", locked: true });

      await controller.advance();

      store.dispatch({ type: "orchestrator_git_mutex", locked: false });

      // Snapshot the current state.
      const snap = controller.state;

      // Dispatch the updated objective so the Sidebar re-renders.
      store.dispatch({ type: "orchestrator_objective_update", objective: snap });

      // Narrate decomposition once, when campaigns first appear.
      if (!decompositionNarrated && snap.campaigns.length > 0) {
        decompositionNarrated = true;
        narrateDecomposition(store, snap.campaigns);
      }

      // Emit transcript events for newly-added campaigns (raw event lines,
      // complementing the prose narration above).
      if (snap.campaigns.length > lastCampaignCount) {
        const newCampaigns = snap.campaigns.slice(lastCampaignCount);
        for (const campaign of newCampaigns) {
          emitEvent(
            store,
            "campaign",
            `${campaignStatusIcon(campaign.status)} [${campaign.campaignId}] ${campaign.description}`,
          );
        }
        lastCampaignCount = snap.campaigns.length;
      }

      // Emit prose narration and status changes for newly-completed/failed campaigns.
      const remainingActive = snap.campaigns.filter(
        (c) => c.status === "pending" || c.status === "running",
      ).length;

      for (const campaign of snap.campaigns) {
        if (campaign.status === "completed" && !campaignCompletedIds.has(campaign.campaignId)) {
          campaignCompletedIds.add(campaign.campaignId);

          const verdict = campaign.synthesisRecord
            ? `Synthesizer: ${campaign.synthesisRecord.useCandidateId ?? "merged"}`
            : campaign.winnerCandidateId
              ? `Winner: ${campaign.winnerCandidateId}`
              : "completed";

          store.dispatch({ type: "orchestrator_verdict", verdict });

          // Prose narration replaces the bare event line for completions.
          narrateCampaignComplete(store, campaign, remainingActive);

        } else if (campaign.status === "failed" && !campaignFailedIds.has(campaign.campaignId)) {
          campaignFailedIds.add(campaign.campaignId);

          const verdict = `Campaign ${campaign.campaignId} failed`;
          store.dispatch({ type: "orchestrator_verdict", verdict });

          narrateCampaignFailed(store, campaign, remainingActive);
        }
      }

      // If the objective is now terminal, break out of the loop.
      if (snap.status === "completed" || snap.status === "failed") {
        break;
      }
    }

    const finalSnap = controller.state;

    // Dispatch the final state.
    store.dispatch({ type: "orchestrator_objective_update", objective: finalSnap });

    if (finalSnap.status === "completed") {
      store.dispatch({ type: "orchestrator_complete", objectiveId });

      // Prose narration for objective completion.
      narrateObjectiveComplete(store, finalSnap);

      // Record in session memory.
      const succeededCampaigns = finalSnap.campaigns.filter(
        (c: Campaign) => c.status === "completed",
      ).length;
      store.dispatch({
        type: "orchestrator_memory_record",
        entry: {
          objectiveId,
          goal,
          status: "completed",
          finishedAt: new Date().toISOString(),
          succeededCampaigns,
          totalCampaigns: finalSnap.campaigns.length,
          verdict: store.getSnapshot().orchestrator.lastVerdict,
        },
      });

      // Also emit a structured review card for the inspect screen.
      const completedCount = succeededCampaigns;
      const totalCount = finalSnap.campaigns.length;
      emitReview(
        store,
        "completed",
        `Objective complete — ${completedCount}/${totalCount} campaigns succeeded.`,
        completedCount < totalCount ? "Review failed campaigns in the sidebar." : undefined,
      );

    } else {
      const reason =
        finalSnap.status === "failed"
          ? "Objective failed — all campaigns exhausted without a winner."
          : `Objective stopped after ${MAX_ADVANCES} advance cycles.`;

      store.dispatch({ type: "orchestrator_failed", objectiveId, reason });

      // Prose narration for failure.
      narrateObjectiveFailed(store, reason);

      // Record in session memory.
      store.dispatch({
        type: "orchestrator_memory_record",
        entry: {
          objectiveId,
          goal,
          status: finalSnap.status === "failed" ? "failed" : "stopped",
          finishedAt: new Date().toISOString(),
          succeededCampaigns: finalSnap.campaigns.filter(
            (c: Campaign) => c.status === "completed",
          ).length,
          totalCampaigns: finalSnap.campaigns.length,
          verdict: reason,
        },
      });

      emitReview(store, "failed", reason, "Check the sidebar for per-campaign details.");
    }

  } catch (error) {
    store.dispatch({ type: "orchestrator_git_mutex", locked: false });

    const message = error instanceof Error ? error.message : String(error);
    const reason = `OrchestratorDriver error: ${message}`;

    store.dispatch({ type: "orchestrator_failed", objectiveId, reason });

    narrateObjectiveFailed(store, reason);

    store.dispatch({
      type: "orchestrator_memory_record",
      entry: {
        objectiveId,
        goal,
        status: "failed",
        finishedAt: new Date().toISOString(),
        succeededCampaigns: 0,
        totalCampaigns: 0,
        verdict: reason,
      },
    });

    emitReview(store, "failed", reason, "Check logs for details.");
  }
};
