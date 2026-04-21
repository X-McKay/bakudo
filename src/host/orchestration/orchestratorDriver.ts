/**
 * Orchestrator Driver
 *
 * Bridges the interactive TUI and the Cognitive Meta-Orchestrator pipeline.
 * When the user types a complex goal, `runObjectiveInTUI()` is called instead
 * of the single-shot SessionController path.
 *
 * Responsibilities:
 * 1. Create an `Objective` and an `ObjectiveController`.
 * 2. Dispatch `orchestrator_start` so the Sidebar shows the new objective.
 * 3. Call `controller.advance()` in a loop until the objective is terminal.
 * 4. After each `advance()`, dispatch `orchestrator_objective_update` so the
 *    Sidebar reflects the latest campaign tree.
 * 5. Stream human-readable progress events into the transcript.
 * 6. On completion, dispatch `orchestrator_complete` and push a ReviewCard.
 * 7. On failure, dispatch `orchestrator_failed` and push an error message.
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
// Main export
// ---------------------------------------------------------------------------

/**
 * Drive an `ObjectiveController` to completion, streaming live progress into
 * the TUI store.
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

  // Announce to the transcript.
  emitEvent(store, "orchestrator", `Starting meta-orchestrator for: ${goal}`);

  const controller = new ObjectiveController(objective, runner, gitWriteMutex);

  // Track the last-seen campaign count to detect when new campaigns appear.
  let lastCampaignCount = 0;
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

      // Emit transcript events for newly-added campaigns.
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

      // Emit status changes for existing campaigns.
      for (const campaign of snap.campaigns) {
        if (campaign.status === "completed") {
          const verdict = campaign.synthesisRecord
            ? `Synthesizer: ${campaign.synthesisRecord.useCandidateId ?? "merged"}`
            : campaign.winnerCandidateId
              ? `Winner: ${campaign.winnerCandidateId}`
              : "completed";
          store.dispatch({ type: "orchestrator_verdict", verdict });
          emitEvent(store, "success", `✓ [${campaign.campaignId}] ${verdict}`);
        } else if (campaign.status === "failed") {
          const verdict = `Campaign ${campaign.campaignId} failed`;
          store.dispatch({ type: "orchestrator_verdict", verdict });
          emitEvent(store, "fail", `✗ [${campaign.campaignId}] failed — Critic/Curator notified`);
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

      const completedCount = finalSnap.campaigns.filter((c) => c.status === "completed").length;
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

      emitReview(store, "failed", reason, "Check the sidebar for per-campaign details.");
    }
  } catch (error) {
    store.dispatch({ type: "orchestrator_git_mutex", locked: false });

    const message = error instanceof Error ? error.message : String(error);
    const reason = `OrchestratorDriver error: ${message}`;

    store.dispatch({ type: "orchestrator_failed", objectiveId, reason });

    emitReview(store, "failed", reason, "Check logs for details.");
  }
};
