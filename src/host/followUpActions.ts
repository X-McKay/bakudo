import { randomUUID } from "node:crypto";

import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner } from "../aboxTaskRunner.js";
import { ArtifactStore } from "../artifactStore.js";
import { createAttemptReviewRecord } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionReviewAction,
  SessionReviewOutcome,
  SessionTurnRecord,
} from "../sessionTypes.js";
import { applyPreservedCandidate } from "./candidateApplier.js";
import { inspectWorktree } from "./worktreeInspector.js";
import { upsertTurnLatestReview } from "./orchestrationSupport.js";
import { resolveEnvPolicyForHost } from "./envPolicy.js";
import { discardSandbox } from "./sandboxCleanup.js";
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
  runner?: ABoxTaskRunner;
  artifactStore?: ArtifactStore;
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

const persistCandidateAttempt = async (args: {
  store: SessionStore;
  input: FollowUpInput;
  attempt: SessionAttemptRecord;
  status: SessionAttemptRecord["status"];
  message: string;
  candidateState: NonNullable<SessionAttemptRecord["candidateState"]>;
  recordedAt: string;
  extra?: Record<string, unknown>;
}): Promise<void> => {
  const { store, input, attempt, status, message, candidateState, recordedAt, extra } = args;
  await store.upsertAttempt(input.sessionId, input.turnId, {
    ...attempt,
    status,
    lastMessage: message,
    candidateState,
    candidate: {
      ...(attempt.candidate ?? { state: candidateState }),
      state: candidateState,
      updatedAt: recordedAt,
      ...(candidateState === "discarded" ? { discardedAt: recordedAt } : {}),
      ...(candidateState === "apply_staging" ? { stagedAt: recordedAt } : {}),
      ...(candidateState === "apply_failed" ? { failureAt: recordedAt, applyError: message } : {}),
      ...(extra ?? {}),
    },
  });
};

const buildFollowUpReview = (args: {
  attempt: SessionAttemptRecord;
  decision: "accept" | "halt";
}): {
  outcome: SessionReviewOutcome;
  action: SessionReviewAction;
  reason?: string;
} => {
  const { attempt, decision } = args;
  const reason = attempt.lastMessage ?? attempt.candidate?.confirmationReason ?? attempt.candidate?.applyError;
  switch (attempt.candidateState) {
    case "applied":
      return {
        outcome: "success",
        action: "accept",
        reason: reason ?? "candidate applied into the source checkout",
      };
    case "needs_confirmation":
      return {
        outcome: "blocked_needs_user",
        action: "ask_user",
        reason: reason ?? "candidate apply needs explicit confirmation",
      };
    case "apply_failed":
      return {
        outcome: "retryable_failure",
        action: "retry",
        reason: reason ?? "candidate apply failed",
      };
    case "discarded":
      return {
        outcome: "blocked_needs_user",
        action: "halt",
        reason: reason ?? "preserved candidate discarded",
      };
    default:
      return decision === "halt"
        ? {
            outcome: "blocked_needs_user",
            action: "halt",
            reason: reason ?? "turn halted by follow-up action",
          }
        : {
            outcome: "success",
            action: "accept",
            reason: reason ?? "turn accepted",
          };
  }
};

const persistFollowUpReview = async (args: {
  store: SessionStore;
  sessionId: string;
  turnId: string;
  attempt: SessionAttemptRecord;
  decision: "accept" | "halt";
  recordedAt: string;
}): Promise<void> => {
  const { store, sessionId, turnId, attempt, decision, recordedAt } = args;
  const reviewed = buildFollowUpReview({ attempt, decision });
  const spec = attempt.dispatchPlan?.spec ?? attempt.attemptSpec;
  const reviewRecord =
    spec !== undefined
      ? createAttemptReviewRecord({
          spec,
          reviewed: {
            outcome: reviewed.outcome,
            action: reviewed.action,
            reason: reviewed.reason ?? "",
          },
          reviewedAt: recordedAt,
        })
      : {
          reviewId: `review-${Date.now()}-${randomUUID().slice(0, 8)}`,
          attemptId: attempt.attemptId,
          outcome: reviewed.outcome,
          action: reviewed.action,
          ...(reviewed.reason === undefined ? {} : { reason: reviewed.reason }),
          reviewedAt: recordedAt,
        };
  await store.upsertAttempt(sessionId, turnId, { ...attempt, reviewRecord });
  await upsertTurnLatestReview(store, sessionId, turnId, reviewRecord);
};

const resolvePreservedCandidate = async (args: {
  store: SessionStore;
  input: FollowUpInput;
  session: SessionRecord;
  attempt: SessionAttemptRecord;
  decision: "accept" | "halt";
}): Promise<"apply_failed" | "discarded" | "needs_confirmation" | null> => {
  const { store, input, session, attempt, decision } = args;
  const candidate = attempt.candidate;
  const candidateState = attempt.candidateState ?? candidate?.state;
  if (
    candidateState !== "candidate_ready" &&
    candidateState !== "needs_confirmation" &&
    candidateState !== "apply_failed"
  ) {
    return null;
  }

  const sandboxTaskId = candidate?.sandboxTaskId;

  const recordedAt = nowIso();
  const aboxBin = input.aboxBin ?? "abox";
  try {
    if (decision === "halt") {
      if (sandboxTaskId === undefined) {
        await persistCandidateAttempt({
          store,
          input,
          attempt,
          status: "failed",
          message: "candidate discard failed: preserved candidate is missing sandboxTaskId",
          candidateState: "apply_failed",
          recordedAt,
        });
        return "apply_failed";
      }
      await discardSandbox(aboxBin, session.repoRoot, sandboxTaskId);
      await persistCandidateAttempt({
        store,
        input,
        attempt,
        status: "cancelled",
        message: "preserved candidate discarded by follow-up halt",
        candidateState: "discarded",
        recordedAt,
      });
      return "discarded";
    }

    const sourceBaseline = candidate?.sourceBaseline;
    if (sourceBaseline === undefined) {
      await persistCandidateAttempt({
        store,
        input,
        attempt,
        status: "failed",
        message: "candidate apply failed: preserved candidate is missing source baseline metadata",
        candidateState: "apply_failed",
        recordedAt,
      });
      return "apply_failed";
    }
    const attemptSpec = attempt.dispatchPlan?.spec ?? attempt.attemptSpec;
    if (attemptSpec === undefined) {
      await persistCandidateAttempt({
        store,
        input,
        attempt,
        status: "failed",
        message: "candidate apply failed: preserved candidate is missing attempt spec metadata",
        candidateState: "apply_failed",
        recordedAt,
      });
      return "apply_failed";
    }
    const aboxRunner =
      input.runner ??
      new ABoxTaskRunner(
        new ABoxAdapter(aboxBin),
        undefined,
        resolveEnvPolicyForHost({}),
      );
    const artifactStore = input.artifactStore ?? new ArtifactStore(input.storageRoot);
    const refreshedInspection =
      sandboxTaskId === undefined || candidate?.worktreePath === undefined || candidate?.branchName === undefined
        ? undefined
        : await inspectWorktree({
            snapshot: {
              path: candidate.worktreePath,
              branch: candidate.branchName,
              head: "",
            },
            taskId: sandboxTaskId,
            attemptId: attempt.attemptId,
            baselineHeadSha: sourceBaseline.headSha,
          });
    const applied = await applyPreservedCandidate({
      sessionStore: store,
      artifactStore,
      runner: aboxRunner,
      storageRoot: input.storageRoot,
      session,
      turnId: input.turnId,
      attempt,
      attemptSpec,
      aboxBin,
      explicitConfirmation: candidateState === "needs_confirmation",
      sourceBaseline,
      ...(refreshedInspection === undefined ? {} : { inspection: refreshedInspection }),
      ...(candidate?.fingerprint === undefined
        ? {}
        : { expectedFingerprint: candidate.fingerprint }),
    });
    await persistCandidateAttempt({
      store,
      input,
      attempt: (await loadTurnAndAttemptOrThrow(store, input.sessionId, input.turnId, input.sourceAttemptId))
        .attempt,
      status:
        applied.candidateState === "applied"
          ? "succeeded"
          : applied.candidateState === "needs_confirmation"
            ? "blocked"
            : "failed",
      message: applied.message,
      candidateState: applied.candidateState,
      recordedAt: nowIso(),
      extra: applied.candidateUpdates,
    });
    return applied.candidateState === "applied"
      ? null
      : applied.candidateState === "needs_confirmation"
        ? "needs_confirmation"
        : "apply_failed";
  } catch (error) {
    const message =
      decision === "accept"
        ? `candidate apply failed: ${error instanceof Error ? error.message : String(error)}`
        : `follow-up discard failed: ${error instanceof Error ? error.message : String(error)}`;
    await persistCandidateAttempt({
      store,
      input,
      attempt,
      status: "failed",
      message,
      candidateState: "apply_failed",
      recordedAt,
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
    const preservedOutcome = await resolvePreservedCandidate({
      store,
      input,
      session,
      attempt,
      decision: "accept",
    });
    const reviewedAttempt = (
      await loadTurnAndAttemptOrThrow(store, input.sessionId, input.turnId, input.sourceAttemptId)
    ).attempt;
    if (reviewedAttempt.candidateState !== undefined) {
      await persistFollowUpReview({
        store,
        sessionId: input.sessionId,
        turnId: input.turnId,
        attempt: reviewedAttempt,
        decision: "accept",
        recordedAt: nowIso(),
      });
    }
    const refreshedTurn = await loadTurnOrThrow(store, input.sessionId, input.turnId);
    const turnStatus =
      preservedOutcome === "needs_confirmation"
        ? "awaiting_user"
        : preservedOutcome === "apply_failed"
          ? "failed"
          : "completed";
    const updated = await store.upsertTurn(input.sessionId, {
      ...refreshedTurn,
      status: turnStatus,
      updatedAt: nowIso(),
    });
    const sessionStatus =
      preservedOutcome === "needs_confirmation"
        ? "awaiting_user"
        : preservedOutcome === "apply_failed"
          ? "failed"
          : "completed";
    await store.saveSession({ ...updated, status: sessionStatus });
    return {
      recordedAt: nowIso(),
      message:
        preservedOutcome === "needs_confirmation"
          ? `Turn ${input.turnId} needs confirmation before candidate apply can continue.`
          : preservedOutcome === "apply_failed"
            ? `Turn ${input.turnId} could not apply the preserved candidate.`
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
  const preservedOutcome = await resolvePreservedCandidate({
    store,
    input,
    session,
    attempt,
    decision: "halt",
  });
  const reviewedAttempt = (
    await loadTurnAndAttemptOrThrow(store, input.sessionId, input.turnId, input.sourceAttemptId)
  ).attempt;
  await persistFollowUpReview({
    store,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attempt: reviewedAttempt,
    decision: "halt",
    recordedAt: nowIso(),
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
        ? `Turn ${input.turnId} halted and preserved candidate discarded.`
        : `Turn ${input.turnId} halted.`,
  };
};
