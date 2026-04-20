/**
 * Session crash-recovery state machine (Phase 6 Workstream 2).
 *
 * Classifies an on-disk session into a recovery verdict before any resume
 * path is allowed to proceed. The three required failure cases from plan
 * 167-175 map directly onto the three "active" verdicts:
 *
 *   - {@link Verdict.kind} `"queued_no_attempt"`
 *       Session has a queued turn with no attempt — safe to resume (the host
 *       simply crashed after session creation but before dispatch).
 *
 *   - `"running_incomplete"`
 *       An attempt is flagged `running` in storage but the event log carries
 *       no terminal event (completed / failed). Classified as
 *       `unknown_incomplete` per plan 208 — resume is **blocked** until the
 *       operator inspects. This is the hard-rule case: we must not discard a
 *       worker result that may have landed after host crash but before
 *       persistence.
 *
 *   - `"finished_no_review"`
 *       Worker produced a terminal event but the turn's `latestReview` is
 *       missing. Requires running review recovery before resume (plan 209).
 *
 *   - `"stale_lock"`
 *       Lock file exists with a dead-PID or age-exceeded marker; reclaim
 *       before proceeding (plan 187-196). Orthogonal to the three above —
 *       reported alongside when both apply, so the caller can emit a single
 *       `host.recovery_detected` line with both reasons.
 *
 *   - `"healthy"`
 *       No recovery needed; callers proceed without mutation.
 *
 * The verdict is a **pure** function of disk state + event log; side effects
 * (lock break, review recovery, operator prompts) are the caller's
 * responsibility. That keeps the state machine testable by injecting a
 * fake event loader.
 *
 * Event emission: the plan asks for `host.recovery_detected` and
 * `host.recovery_applied` envelopes, but v2 SessionEventKind is locked and
 * those kinds do not exist in the union. Rather than silently invent new
 * kinds (see brief Hard-constraints 3), we surface the verdict to the caller
 * and emit a structured stderr log line plus (optionally) a hook-dispatcher
 * notification. The final envelope-kind decision is flagged to the parent
 * orchestrator in the PR handoff.
 */

import type { SessionEventEnvelope, SessionEventKind } from "../protocol.js";
import type { SessionRecord, SessionTurnRecord } from "../sessionTypes.js";
import { stderrWrite } from "./io.js";
import {
  classifyLockStaleness,
  readSessionLock,
  type ReadLockResult,
  type StalenessVerdict,
} from "./lockFile.js";

/** Discriminated verdict for a single session. */
export type RecoveryVerdict =
  | { kind: "healthy" }
  | {
      kind: "queued_no_attempt";
      turnId: string;
      detail: string;
    }
  | {
      kind: "running_incomplete";
      turnId: string;
      attemptId: string;
      detail: string;
    }
  | {
      kind: "finished_no_review";
      turnId: string;
      attemptId: string;
      detail: string;
    }
  | {
      kind: "apply_incomplete";
      turnId: string;
      attemptId: string;
      detail: string;
    };

export type RecoveryLockReport =
  | { kind: "absent" }
  | { kind: "held_live"; ownerPid: number }
  | { kind: "stale"; ownerPid: number; reason: StalenessVerdict & { stale: true } }
  | { kind: "corrupt"; reason: string };

/** Full recovery report: primary verdict + auxiliary lock report. */
export type RecoveryReport = {
  sessionId: string;
  verdict: RecoveryVerdict;
  lock: RecoveryLockReport;
  /**
   * Whether the caller must block resume rather than continue. Derived from
   * the verdict: `running_incomplete` blocks; everything else is resolvable.
   */
  blocksResume: boolean;
  /** Stable machine-readable code for logs / error payloads. */
  code: RecoveryCode;
};

/**
 * Stable codes for log emission. Keep in sync with the error-taxonomy work in
 * W9 — the five codes below map onto exit code 5 ("session corruption or
 * recovery required"), except `healthy` which is not an error.
 */
export type RecoveryCode =
  | "recovery.healthy"
  | "recovery.queued_no_attempt"
  | "recovery.running_incomplete"
  | "recovery.finished_no_review"
  | "recovery.apply_incomplete"
  | "recovery.stale_lock_cleared"
  | "recovery.stale_lock_detected";

/**
 * Minimal view of a persisted session-event stream for recovery. The store
 * exposes an untyped reader (`readTaskEvents`) plus the v2 envelope log
 * (`eventLogFilePath`) — the adapter callback here converts either into a
 * kind set so the state machine stays decoupled from storage details.
 */
export type SessionEventKindLoader = (sessionId: string) => Promise<Set<SessionEventKind>>;

export type RecoverStateOptions = {
  /** Load the set of v2 kinds already emitted for a session. */
  loadEventKinds?: SessionEventKindLoader;
  /** Override the lock reader (tests). */
  readLock?: (sessionDir: string) => Promise<ReadLockResult>;
  /** Clock + PID-liveness overrides for tests. Forwarded to `classifyLockStaleness`. */
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  staleAfterMs?: number;
};

const TERMINAL_WORKER_KINDS: readonly SessionEventKind[] = [
  "worker.attempt_completed",
  "worker.attempt_failed",
];

const REVIEW_COMPLETED_KIND: SessionEventKind = "host.review_completed";

/**
 * Inspect the session's most-recent turn + attempt and translate into a
 * verdict. The rules follow plan 205-210 verbatim:
 *
 *  1. queued turn, no attempt started -> `queued_no_attempt`
 *  2. running attempt, no terminal event -> `running_incomplete`
 *  3. finished attempt, no review -> `finished_no_review`
 *
 * Turns earlier than the last are assumed already reconciled — only the tail
 * can be "in flight" at crash time. This is the same shape `sessionController`
 * uses when computing `nextTurnId` / `nextAttemptId`, so recovery and resume
 * agree on "which turn are we talking about".
 */
export const classifyRecoveryVerdict = (
  session: SessionRecord,
  emittedKinds: ReadonlySet<SessionEventKind>,
): RecoveryVerdict => {
  const lastTurn = session.turns.at(-1);
  if (lastTurn === undefined) {
    return { kind: "healthy" };
  }

  // Rule 1: queued turn with zero attempts.
  if (lastTurn.status === "queued" && lastTurn.attempts.length === 0) {
    return {
      kind: "queued_no_attempt",
      turnId: lastTurn.turnId,
      detail: "turn was queued but no attempt had started when the host crashed",
    };
  }

  const lastAttempt = lastTurn.attempts.at(-1);
  if (lastAttempt === undefined) {
    // Turn non-queued but no attempts: effectively healthy for our purposes —
    // `running`/`reviewing` without attempts is a caller bug, not a crash.
    return { kind: "healthy" };
  }

  const attemptStatus = lastAttempt.status;
  const candidateState = lastAttempt.candidateState;
  const hasTerminalWorkerEvent = TERMINAL_WORKER_KINDS.some((kind) => emittedKinds.has(kind));
  const hasReviewCompleted = emittedKinds.has(REVIEW_COMPLETED_KIND);

  // Rule 2: worker recorded as running/queued but no terminal event observed.
  if ((attemptStatus === "running" || attemptStatus === "queued") && !hasTerminalWorkerEvent) {
    return {
      kind: "running_incomplete",
      turnId: lastTurn.turnId,
      attemptId: lastAttempt.attemptId,
      detail:
        "attempt marked running in storage but no terminal worker event was logged; " +
        "inspect required before resume",
    };
  }

  // Rule 3: worker terminal recorded (either via attempt status, via event log,
  // or both) but no review event observed and no review record on the turn.
  const attemptReachedTerminal =
    attemptStatus === "succeeded" ||
    attemptStatus === "failed" ||
    attemptStatus === "cancelled" ||
    hasTerminalWorkerEvent;
  if (
    attemptReachedTerminal &&
    !hasReviewCompleted &&
    needsReviewRecovery(lastTurn, lastAttempt.attemptId)
  ) {
    return {
      kind: "finished_no_review",
      turnId: lastTurn.turnId,
      attemptId: lastAttempt.attemptId,
      detail:
        "worker completed but the review pass did not persist; run review recovery before resume",
    };
  }

  if (
    candidateState === "apply_staging" ||
    candidateState === "apply_verifying" ||
    candidateState === "apply_writeback"
  ) {
    return {
      kind: "apply_incomplete",
      turnId: lastTurn.turnId,
      attemptId: lastAttempt.attemptId,
      detail: `host crashed during ${candidateState}; inspect before resuming apply`,
    };
  }

  return { kind: "healthy" };
};

const needsReviewRecovery = (turn: SessionTurnRecord, attemptId: string): boolean => {
  if (turn.latestReview === undefined) {
    return true;
  }
  return turn.latestReview.attemptId !== attemptId;
};

/**
 * Translate a lock-read result + staleness check into a {@link RecoveryLockReport}.
 */
export const classifyLockReport = (
  read: ReadLockResult,
  options: {
    now?: () => number;
    pidAlive?: (pid: number) => boolean;
    staleAfterMs?: number;
  } = {},
): RecoveryLockReport => {
  if (read.kind === "missing") {
    return { kind: "absent" };
  }
  if (read.kind === "corrupt") {
    return { kind: "corrupt", reason: read.reason };
  }
  const staleness = classifyLockStaleness({
    lock: read.lock,
    mtimeMs: read.mtimeMs,
    ...(options.now ? { now: options.now } : {}),
    ...(options.pidAlive ? { pidAlive: options.pidAlive } : {}),
    ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
  });
  if (staleness.stale) {
    return { kind: "stale", ownerPid: read.lock.ownerPid, reason: staleness };
  }
  return { kind: "held_live", ownerPid: read.lock.ownerPid };
};

/**
 * Compute a full {@link RecoveryReport}. Pure w.r.t. the event loader and
 * lock reader; callers wire real readers via `sessionStore` / `eventLogWriter`.
 */
export const recoverState = async (
  session: SessionRecord,
  sessionDir: string,
  options: RecoverStateOptions = {},
): Promise<RecoveryReport> => {
  const loadEventKinds = options.loadEventKinds ?? (async () => new Set<SessionEventKind>());
  const readLock = options.readLock ?? readSessionLock;

  const [emittedKinds, lockRead] = await Promise.all([
    loadEventKinds(session.sessionId),
    readLock(sessionDir),
  ]);

  const verdict = classifyRecoveryVerdict(session, emittedKinds);
  const lock = classifyLockReport(lockRead, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.pidAlive ? { pidAlive: options.pidAlive } : {}),
    ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
  });

  const blocksResume = verdict.kind === "running_incomplete" || verdict.kind === "apply_incomplete";
  const code = codeForReport(verdict, lock);

  return { sessionId: session.sessionId, verdict, lock, blocksResume, code };
};

const codeForReport = (verdict: RecoveryVerdict, lock: RecoveryLockReport): RecoveryCode => {
  if (verdict.kind === "queued_no_attempt") return "recovery.queued_no_attempt";
  if (verdict.kind === "running_incomplete") return "recovery.running_incomplete";
  if (verdict.kind === "finished_no_review") return "recovery.finished_no_review";
  if (verdict.kind === "apply_incomplete") return "recovery.apply_incomplete";
  if (lock.kind === "stale") return "recovery.stale_lock_detected";
  return "recovery.healthy";
};

/**
 * Emit a single-line recovery notice to stderr. This is the interim log
 * surface until the plan authorizes `host.recovery_detected` / `_applied`
 * envelope kinds.
 */
export const logRecoveryNotice = (report: RecoveryReport): void => {
  const parts = [`[bakudo.recovery] code=${report.code}`, `session=${report.sessionId}`];
  if (report.verdict.kind !== "healthy") {
    parts.push(`turn=${report.verdict.turnId}`);
    if ("attemptId" in report.verdict) {
      parts.push(`attempt=${report.verdict.attemptId}`);
    }
    parts.push(`detail=${JSON.stringify(report.verdict.detail)}`);
  }
  if (report.lock.kind === "stale") {
    parts.push(`lock=stale ownerPid=${report.lock.ownerPid} reason=${report.lock.reason.reason}`);
  } else if (report.lock.kind === "corrupt") {
    parts.push(`lock=corrupt reason=${JSON.stringify(report.lock.reason)}`);
  }
  stderrWrite(`${parts.join(" ")}\n`);
};

/**
 * Build a "notification-shaped" envelope for hook dispatch. Uses the generic
 * `host.event_skipped` kind (reserved for host-internal notices per
 * `protocol.ts:107-110`) with a `recoveryCode` payload discriminator. If W9
 * later authorises `host.recovery_detected` / `_applied`, swap the kind here
 * without changing call sites.
 */
export const buildRecoveryEnvelope = (
  report: RecoveryReport,
  makeEventId: () => string,
  nowIso: () => string,
): SessionEventEnvelope => {
  const payload: Record<string, unknown> = {
    recoveryCode: report.code,
    verdict: report.verdict.kind,
    lock: report.lock.kind,
    blocksResume: report.blocksResume,
  };
  if (report.verdict.kind !== "healthy") {
    payload.turnId = report.verdict.turnId;
    if ("attemptId" in report.verdict) {
      payload.attemptId = report.verdict.attemptId;
    }
    payload.detail = report.verdict.detail;
  }
  if (report.lock.kind === "stale") {
    payload.lockOwnerPid = report.lock.ownerPid;
    payload.lockStaleReason = report.lock.reason.reason;
  }
  const envelope: SessionEventEnvelope = {
    schemaVersion: 2,
    eventId: makeEventId(),
    sessionId: report.sessionId,
    actor: "host",
    kind: "host.event_skipped",
    timestamp: nowIso(),
    payload,
  };
  return envelope;
};

/**
 * Adapter that the session store can supply: reads the v2 event log and
 * returns the set of envelope kinds. Kept here so recovery owns the "what
 * counts as a terminal event" invariant.
 */
export const buildEventKindLoader = (
  readEnvelopes: (sessionId: string) => Promise<ReadonlyArray<SessionEventEnvelope>>,
): SessionEventKindLoader => {
  return async (sessionId) => {
    const envelopes = await readEnvelopes(sessionId);
    const kinds = new Set<SessionEventKind>();
    for (const envelope of envelopes) {
      kinds.add(envelope.kind);
    }
    return kinds;
  };
};
