import { randomUUID } from "node:crypto";

import { SessionStore } from "../sessionStore.js";
import type { SessionAttemptRecord, SessionRecord, SessionTurnRecord } from "../sessionTypes.js";
import { discardSandbox, mergeSandbox } from "./mergeController.js";
import {
  emitTurnTransition,
  findLatestTurnTransition,
  type TurnTransition,
} from "./transitionStore.js";

/**
 * Host-side follow-up actions recorded after a worker turn completes.
 *
 * Per Workstream 6 "Product Rule: These actions are host decisions, not
 * worker decisions." The worker may suggest one of these; the host is what
 * records the action taken.
 *
 * Shapes:
 *
 * - `retry`             — host decided to run the turn again unchanged.
 * - `retry_refine`      — host decided to run the turn again with refinement
 *                         text (e.g. "retry with --verbose").
 * - `ask_user`          — host decided to ask the user a clarifying question
 *                         before proceeding. No transition is emitted; the
 *                         caller is responsible for rendering the prompt.
 * - `accept`            — host accepted the attempt result; turn status
 *                         moves to `"completed"`.
 * - `halt`              — host aborted the turn; a `user_halt` transition is
 *                         emitted and the turn moves to `"cancelled"`.
 */
export type FollowUpAction =
  | { kind: "retry" }
  | { kind: "retry_refine"; refinement: string }
  | { kind: "ask_user"; question: string }
  | { kind: "accept" }
  | { kind: "halt" };

/**
 * Input for {@link applyFollowUpAction}.
 *
 * - `sourceAttemptId` is the attempt the follow-up decision is responding
 *   to. For retry/retry_refine this becomes the new attempt's
 *   `parentAttemptId`. For accept/halt it identifies which attempt the
 *   turn-level decision applies to.
 * - `storageRoot` points at the sessions root (e.g.
 *   `<repo>/.bakudo/sessions`). Both the transition log and the
 *   SessionStore live below it.
 */
export type FollowUpInput = {
  sessionId: string;
  turnId: string;
  sourceAttemptId: string;
  action: FollowUpAction;
  storageRoot: string;
  aboxBin?: string;
};

/**
 * Output of {@link applyFollowUpAction}.
 *
 * - `transition` is present only for paths that emit a transition: `retry`,
 *   `retry_refine`, and `halt`.
 * - `newAttemptId` is present only for retry paths; the caller is
 *   responsible for dispatching it. This module intentionally does NOT
 *   dispatch — it is a pure decision-recording surface.
 * - `message` is a user-visible sentence summarising the outcome.
 */
export type FollowUpResult = {
  recordedAt: string;
  transition?: TurnTransition;
  newAttemptId?: string;
  message: string;
};

const nowIso = (): string => new Date().toISOString();

const createRetryAttemptId = (turnId: string, count: number): string => {
  const trimmed = turnId.replace(/^turn-/, "");
  return `turn${trimmed}-attempt-${count + 1}-${randomUUID().slice(0, 8)}`;
};

const loadTurnOrThrow = async (
  store: SessionStore,
  sessionId: string,
  turnId: string,
): Promise<SessionTurnRecord> => {
  const session = await store.loadSession(sessionId);
  if (session === null) {
    throw new Error(`applyFollowUpAction: unknown session ${sessionId}`);
  }
  const turn = session.turns.find((entry) => entry.turnId === turnId);
  if (turn === undefined) {
    throw new Error(`applyFollowUpAction: unknown turn ${turnId} in session ${sessionId}`);
  }
  return turn;
};

const loadTurnAndAttemptOrThrow = async (
  store: SessionStore,
  sessionId: string,
  turnId: string,
  attemptId: string,
): Promise<{
  session: SessionRecord;
  turn: SessionTurnRecord;
  attempt: SessionAttemptRecord;
}> => {
  const session = await store.loadSession(sessionId);
  if (session === null) {
    throw new Error(`applyFollowUpAction: unknown session ${sessionId}`);
  }
  const turn = session.turns.find((entry) => entry.turnId === turnId);
  if (turn === undefined) {
    throw new Error(`applyFollowUpAction: unknown turn ${turnId} in session ${sessionId}`);
  }
  const attempt = turn.attempts.find((entry) => entry.attemptId === attemptId);
  if (attempt === undefined) {
    throw new Error(`applyFollowUpAction: unknown attempt ${attemptId} in turn ${turnId}`);
  }
  return { session, turn, attempt };
};

const resolvePreservedSandbox = async (args: {
  store: SessionStore;
  input: FollowUpInput;
  session: SessionRecord;
  turn: SessionTurnRecord;
  attempt: SessionAttemptRecord;
  decision: "accept" | "halt";
}): Promise<"merged" | "discarded" | null> => {
  const { store, input, session, turn, attempt, decision } = args;
  if (attempt.sandbox?.state !== "preserved_active") {
    return null;
  }

  const sandboxTaskId = attempt.sandbox.sandboxTaskId;
  if (sandboxTaskId === undefined) {
    throw new Error(
      `applyFollowUpAction: preserved attempt ${attempt.attemptId} is missing sandboxTaskId`,
    );
  }

  const recordedAt = nowIso();
  const aboxBin = input.aboxBin ?? "abox";
  try {
    if (decision === "accept") {
      await mergeSandbox(aboxBin, session.repoRoot, sandboxTaskId);
      await discardSandbox(aboxBin, session.repoRoot, sandboxTaskId);
      await store.upsertAttempt(input.sessionId, turn.turnId, {
        ...attempt,
        status: "succeeded",
        lastMessage: "preserved candidate merged and cleaned up by follow-up accept",
        sandboxLifecycleState: "preserved_merged",
        sandbox: {
          ...attempt.sandbox,
          state: "preserved_merged",
          updatedAt: recordedAt,
          mergedAt: recordedAt,
          discardedAt: recordedAt,
        },
      });
      return "merged";
    }

    await discardSandbox(aboxBin, session.repoRoot, sandboxTaskId);
    await store.upsertAttempt(input.sessionId, turn.turnId, {
      ...attempt,
      status: "cancelled",
      lastMessage: "preserved candidate discarded by follow-up halt",
      sandboxLifecycleState: "preserved_discarded",
      sandbox: {
        ...attempt.sandbox,
        state: "preserved_discarded",
        updatedAt: recordedAt,
        discardedAt: recordedAt,
      },
    });
    return "discarded";
  } catch (error) {
    const message =
      decision === "accept"
        ? `follow-up merge failed: ${error instanceof Error ? error.message : String(error)}`
        : `follow-up discard failed: ${error instanceof Error ? error.message : String(error)}`;
    await store.upsertAttempt(input.sessionId, turn.turnId, {
      ...attempt,
      status: "failed",
      lastMessage: message,
      sandboxLifecycleState: "merge_failed",
      sandbox: {
        ...attempt.sandbox,
        state: "merge_failed",
        updatedAt: recordedAt,
        mergeError: message,
      },
    });
    throw new Error(message);
  }
};

/**
 * Emit a transition extending the turn's existing chain (or starting a
 * fresh one when no prior transition is logged — tolerant fallback for
 * partially-migrated sessions).
 */
const emitExtendingTransition = async (
  input: FollowUpInput,
  reason: "host_retry" | "host_retry_refine" | "user_halt",
  fromStatus: SessionTurnRecord["status"],
  toStatus: SessionTurnRecord["status"],
): Promise<TurnTransition> => {
  const prior = await findLatestTurnTransition(input.storageRoot, input.sessionId, input.turnId);
  const extend = prior === null ? {} : { chainId: prior.chainId, depth: prior.depth + 1 };
  return emitTurnTransition({
    storageRoot: input.storageRoot,
    sessionId: input.sessionId,
    turnId: input.turnId,
    fromStatus,
    toStatus,
    reason,
    ...extend,
  });
};

/**
 * Append a new attempt record for `retry` / `retry_refine`. The record is
 * `queued` with `parentAttemptId = sourceAttemptId` and the supplied
 * `retryReason`. This function does NOT dispatch the attempt — it is a
 * pure decision-recording surface per the PR6 contract.
 */
const appendRetryAttempt = async (
  store: SessionStore,
  sessionId: string,
  turn: SessionTurnRecord,
  sourceAttemptId: string,
  retryReason: string,
): Promise<string> => {
  const attemptId = createRetryAttemptId(turn.turnId, turn.attempts.length);
  const attempt: SessionAttemptRecord = {
    attemptId,
    status: "queued",
    parentAttemptId: sourceAttemptId,
    retryReason,
  };
  await store.upsertAttempt(sessionId, turn.turnId, attempt);
  return attemptId;
};

/**
 * Apply a follow-up action and record its durable artefacts (transition,
 * attempt, or turn status change). Returns a pure summary — the caller is
 * responsible for any downstream dispatch / rendering.
 *
 * Idempotency: `accept` on an already-`completed` turn is a no-op and
 * returns the same summary shape the first call produced (no second
 * transition is emitted). `halt` on an already-`cancelled` turn behaves
 * the same way.
 */
export const applyFollowUpAction = async (input: FollowUpInput): Promise<FollowUpResult> => {
  const store = new SessionStore(input.storageRoot);

  if (input.action.kind === "retry") {
    const turn = await loadTurnOrThrow(store, input.sessionId, input.turnId);
    const transition = await emitExtendingTransition(input, "host_retry", turn.status, "queued");
    const newAttemptId = await appendRetryAttempt(
      store,
      input.sessionId,
      turn,
      input.sourceAttemptId,
      "host retry requested",
    );
    return {
      recordedAt: nowIso(),
      transition,
      newAttemptId,
      message: `Retry queued as ${newAttemptId}.`,
    };
  }

  if (input.action.kind === "retry_refine") {
    const turn = await loadTurnOrThrow(store, input.sessionId, input.turnId);
    const transition = await emitExtendingTransition(
      input,
      "host_retry_refine",
      turn.status,
      "queued",
    );
    const newAttemptId = await appendRetryAttempt(
      store,
      input.sessionId,
      turn,
      input.sourceAttemptId,
      input.action.refinement,
    );
    return {
      recordedAt: nowIso(),
      transition,
      newAttemptId,
      message: `Retry (refined) queued as ${newAttemptId}: ${input.action.refinement}`,
    };
  }

  if (input.action.kind === "ask_user") {
    return {
      recordedAt: nowIso(),
      message: `Paused: asked user: ${input.action.question}`,
    };
  }

  if (input.action.kind === "accept") {
    const { session, turn, attempt } = await loadTurnAndAttemptOrThrow(
      store,
      input.sessionId,
      input.turnId,
      input.sourceAttemptId,
    );
    if (turn.status === "completed") {
      return {
        recordedAt: nowIso(),
        message: `Turn ${input.turnId} already accepted (status=completed).`,
      };
    }
    const preservedOutcome = await resolvePreservedSandbox({
      store,
      input,
      session,
      turn,
      attempt,
      decision: "accept",
    });
    const refreshedTurn = await loadTurnOrThrow(store, input.sessionId, input.turnId);
    const updated = await store.upsertTurn(input.sessionId, {
      ...refreshedTurn,
      status: "completed",
      updatedAt: nowIso(),
    });
    await store.saveSession({ ...updated, status: "completed" });
    return {
      recordedAt: nowIso(),
      message:
        preservedOutcome === "merged"
          ? `Turn ${input.turnId} accepted and preserved sandbox merged.`
          : `Turn ${input.turnId} accepted.`,
    };
  }

  // halt
  const { session, turn, attempt } = await loadTurnAndAttemptOrThrow(
    store,
    input.sessionId,
    input.turnId,
    input.sourceAttemptId,
  );
  if (turn.status === "cancelled") {
    return {
      recordedAt: nowIso(),
      message: `Turn ${input.turnId} already halted (status=cancelled).`,
    };
  }
  const preservedOutcome = await resolvePreservedSandbox({
    store,
    input,
    session,
    turn,
    attempt,
    decision: "halt",
  });
  const refreshedTurn = await loadTurnOrThrow(store, input.sessionId, input.turnId);
  const transition = await emitExtendingTransition(
    input,
    "user_halt",
    refreshedTurn.status,
    "cancelled",
  );
  const updated = await store.upsertTurn(input.sessionId, {
    ...refreshedTurn,
    status: "cancelled",
    updatedAt: nowIso(),
  });
  await store.saveSession({ ...updated, status: "cancelled" });
  return {
    recordedAt: nowIso(),
    transition,
    message:
      preservedOutcome === "discarded"
        ? `Turn ${input.turnId} halted and preserved sandbox discarded.`
        : `Turn ${input.turnId} halted.`,
  };
};
