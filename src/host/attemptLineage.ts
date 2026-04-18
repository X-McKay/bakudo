import type { SessionAttemptRecord } from "../sessionTypes.js";
import type { TurnTransition, TurnTransitionReason } from "./transitionStore.js";

/**
 * Who initiated a retry: the human operator (`user_retry`) or the host's
 * automatic recovery pathway (`host_retry`, `recovery_required`,
 * `approval_denied_retry`, `protocol_mismatch_recovery`). Undefined on the
 * first attempt of a turn where no retry has occurred yet.
 */
export type RetryInitiator = "host" | "user";

/**
 * Derived view of an attempt's position within a retry chain. Not a persisted
 * record: reconstituted on demand from {@link SessionAttemptRecord} + the
 * turn's append-only {@link TurnTransition} log. The only delta persisted on
 * disk is the pair of optional fields added to `SessionAttemptRecord`:
 * `parentAttemptId` and `retryReason`.
 *
 * - `chainId` and `depth` come from the matching {@link TurnTransition} when
 *   one exists; for the first attempt they fall back to any available
 *   transition on the turn (e.g. the `next_turn` entry) or, failing that, a
 *   synthetic `chain-<attemptId>` so every lineage has a stable chainId.
 * - `retryInitiator` is derived from the matching transition's `reason`.
 *   Absent on the first attempt of a turn.
 * - `parentAttemptId` and `retryReason` are copied verbatim from the attempt
 *   record — they are attempt-granularity fields the transition log does not
 *   carry.
 */
export type AttemptLineage = {
  attemptId: string;
  parentAttemptId?: string;
  chainId: string;
  depth: number;
  retryReason?: string;
  retryInitiator?: RetryInitiator;
  transition?: TurnTransition;
};

const USER_RETRY_REASONS: ReadonlySet<TurnTransitionReason> = new Set<TurnTransitionReason>([
  "user_retry",
]);

const HOST_RETRY_REASONS: ReadonlySet<TurnTransitionReason> = new Set<TurnTransitionReason>([
  "host_retry",
  "recovery_required",
  "approval_denied_retry",
  "protocol_mismatch_recovery",
]);

/**
 * Classify a {@link TurnTransitionReason} as user-initiated, host-initiated,
 * or non-retry (`next_turn`). Returns `undefined` for transitions that are
 * not retries so the caller leaves {@link AttemptLineage.retryInitiator}
 * undefined on the first attempt of a turn.
 */
const classifyRetryInitiator = (reason: TurnTransitionReason): RetryInitiator | undefined => {
  if (USER_RETRY_REASONS.has(reason)) {
    return "user";
  }
  if (HOST_RETRY_REASONS.has(reason)) {
    return "host";
  }
  return undefined;
};

const isRetryReason = (reason: TurnTransitionReason): boolean =>
  USER_RETRY_REASONS.has(reason) || HOST_RETRY_REASONS.has(reason);

/**
 * Find the most-recent retry transition for the given turn's transitions.
 * "Most recent" = last element in write order; the callers pass transitions
 * already filtered to a single turn. Returns `undefined` when the list is
 * empty or contains no retry-reason entries.
 */
const findLatestRetryTransition = (
  transitions: readonly TurnTransition[],
): TurnTransition | undefined => {
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const candidate = transitions[index];
    if (candidate !== undefined && isRetryReason(candidate.reason)) {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Return any transition for the turn (preferring the latest in write order).
 * Used to recover a chainId for first attempts when the transition log
 * carries a `next_turn` entry but no retries yet.
 */
const findLatestTransition = (
  transitions: readonly TurnTransition[],
): TurnTransition | undefined => {
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const candidate = transitions[index];
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Pure projection from an attempt record + its turn's transition log to an
 * {@link AttemptLineage} view. See the type doc for the invariants.
 *
 * Derivation rules (from `plans/bakudo-ux/phase-4-record-design.md` §4.2):
 *
 * 1. First attempt of a turn — detected when `attempt.parentAttemptId` is
 *    undefined: no retry has occurred, `transition` stays undefined,
 *    `retryInitiator` stays undefined, `depth` is 0, and `chainId` is either
 *    pulled from any existing transition on the turn (typically `next_turn`)
 *    or synthesized as `chain-<attemptId>`.
 * 2. Retry attempt — detected when `attempt.parentAttemptId` is set: match
 *    the latest retry-reason transition for the turn. `chainId` and `depth`
 *    come from that transition; `retryInitiator` is derived from its
 *    `reason`. If no retry transitions exist yet (e.g. tolerant read of a
 *    partially-migrated log), fall back to the latest transition on the
 *    turn; if even that is absent, treat the attempt as a first attempt
 *    (synthetic chainId, depth 0).
 * 3. `parentAttemptId` and `retryReason` are always copied verbatim from
 *    the attempt record — they are the only attempt-granularity fields the
 *    transition log does not carry.
 */
export const deriveAttemptLineage = (
  attempt: SessionAttemptRecord,
  transitions: readonly TurnTransition[],
): AttemptLineage => {
  const fallbackChainId = `chain-${attempt.attemptId}`;
  const parentAttemptId = attempt.parentAttemptId;
  const retryReason = attempt.retryReason;

  if (parentAttemptId === undefined) {
    // First attempt: no retry has occurred. If a transition (typically
    // `next_turn`) already exists we reuse its chainId so a subsequent
    // retry's lineage lines up with this one; otherwise synthesize.
    const anyTransition = findLatestTransition(transitions);
    return {
      attemptId: attempt.attemptId,
      chainId: anyTransition?.chainId ?? fallbackChainId,
      depth: 0,
      ...(retryReason === undefined ? {} : { retryReason }),
    };
  }

  const matching = findLatestRetryTransition(transitions) ?? findLatestTransition(transitions);
  if (matching === undefined) {
    // Attempt claims a parent but no transitions were found. Tolerant
    // fallback: still surface the parent/reason, and synthesize a chainId.
    return {
      attemptId: attempt.attemptId,
      parentAttemptId,
      chainId: fallbackChainId,
      depth: 0,
      ...(retryReason === undefined ? {} : { retryReason }),
    };
  }

  const retryInitiator = classifyRetryInitiator(matching.reason);
  return {
    attemptId: attempt.attemptId,
    parentAttemptId,
    chainId: matching.chainId,
    depth: matching.depth,
    ...(retryReason === undefined ? {} : { retryReason }),
    ...(retryInitiator === undefined ? {} : { retryInitiator }),
    transition: matching,
  };
};
