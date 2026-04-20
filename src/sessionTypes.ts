import type { AttemptSpec, DispatchPlan } from "./attemptProtocol.js";
import type { TaskRequest, TaskResult, TaskStatus } from "./protocol.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, isTerminalTaskStatus } from "./protocol.js";

export type SessionStatus =
  | "draft"
  | "planned"
  | "running"
  | "reviewing"
  | "awaiting_user"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type TerminalSessionStatus = Exclude<
  SessionStatus,
  "draft" | "planned" | "running" | "reviewing" | "awaiting_user"
>;

export type TurnStatus =
  | "queued"
  | "running"
  | "reviewing"
  | "completed"
  | "awaiting_user"
  | "failed"
  /**
   * Phase 4 PR6: user halted the turn via `applyFollowUpAction({ kind: "halt" })`.
   * Distinct from `failed` so inspect/timeline can show "user halted" separately
   * from a worker failure. Existing migrations that coerced task status
   * "cancelled" → turn "failed" continue to produce "failed"; only the explicit
   * host-side halt path writes "cancelled".
   */
  | "cancelled";

export type AttemptStatus = TaskStatus;

export type SessionReviewOutcome =
  | "success"
  | "retryable_failure"
  | "blocked_needs_user"
  | "policy_denied"
  | "incomplete_needs_follow_up";

export type SessionReviewAction = "accept" | "retry" | "ask_user" | "halt" | "follow_up";

export type CandidateState =
  | "ephemeral"
  | "candidate_ready"
  | "apply_staging"
  | "apply_verifying"
  | "needs_confirmation"
  | "apply_writeback"
  | "applied"
  | "apply_failed"
  | "discarded";

export type CandidateChangeKind = "clean" | "dirty" | "committed" | "mixed";

export type ApplyDriftDecision =
  | "not_checked"
  | "allowed"
  | "blocked_repo_mismatch"
  | "blocked_detached_head"
  | "blocked_branch_switched"
  | "blocked_baseline_not_ancestor"
  | "blocked_unrelated_history";

export type SourceBaselineRecord = {
  repoRoot: string;
  repoIdentity: string;
  headSha: string;
  branchName?: string;
  detachedHead: boolean;
  clean: boolean;
  capturedAt: string;
};

export type ApplyDispatchKind = "apply_verify" | "apply_resolve";

export type ApplyDispatchStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ApplyDispatchRecord = {
  kind: ApplyDispatchKind;
  attemptId: string;
  taskId: string;
  command?: string[];
  status: ApplyDispatchStatus;
  recordedAt: string;
  artifacts?: string[];
  error?: string;
};

export type ApplyResolutionConfidence = "high" | "medium" | "low";

export type ApplyResolutionStatus = "auto_applied" | "needs_confirmation" | "failed";

export type ApplyResolutionRecord = {
  path: string;
  confidence: ApplyResolutionConfidence;
  rationale: string;
  status: ApplyResolutionStatus;
  recordedAt: string;
  artifacts?: string[];
  reason?: string;
};

export type CandidateRecord = {
  state: CandidateState;
  candidateId?: string;
  sandboxTaskId?: string;
  branchName?: string;
  worktreePath?: string;
  reservedOutputDir?: string;
  changeKind?: CandidateChangeKind;
  changedFiles?: string[];
  dirtyFiles?: string[];
  committedFiles?: string[];
  outputArtifacts?: string[];
  fingerprint?: string;
  manifestArtifact?: string;
  sourceBaseline?: SourceBaselineRecord;
  driftDecision?: ApplyDriftDecision;
  applyDispatches?: ApplyDispatchRecord[];
  resolutions?: ApplyResolutionRecord[];
  updatedAt: string;
  reviewedAt?: string;
  stagedAt?: string;
  verifiedAt?: string;
  writebackAt?: string;
  appliedAt?: string;
  discardedAt?: string;
  failureAt?: string;
  applyError?: string;
  confirmationReason?: string;
};

/**
 * Structured host-side review of an attempt outcome. Persisted on the attempt
 * as the authoritative review record; `SessionTurnRecord.latestReview` mirrors
 * the tail attempt's record for summary/index surfaces.
 */
export type SessionReviewRecord = {
  reviewId: string;
  attemptId: string;
  /**
   * Phase 3 intent ID linking the review back to the intent that produced
   * the attempt. Present when the attempt was created by the Phase 3
   * planner; absent for legacy attempts.
   */
  intentId?: string;
  outcome: SessionReviewOutcome;
  action: SessionReviewAction;
  reason?: string;
  reviewedAt: string;
};

export type SessionAttemptRecord = {
  attemptId: string;
  status: AttemptStatus;
  request?: TaskRequest;
  result?: TaskResult;
  lastMessage?: string;
  metadata?: Record<string, unknown>;
  /**
   * Abox CLI invocation string array, hoisted out of `metadata.aboxCommand` for
   * first-class surfacing (inspect/sandbox views). Optional for migration
   * compatibility with pre-v2 attempts that stored it only in metadata.
   */
  dispatchCommand?: string[];
  /**
   * Phase 3 v3 attempt specification. Present when the attempt was created by
   * the Phase 3 dispatch pipeline; absent for legacy/v1 attempts.
   * @deprecated Prefer `dispatchPlan.spec`.
   */
  attemptSpec?: AttemptSpec;
  /**
   * Phase 7 control-plane planner payload. Host-owned plan envelope that wraps
   * the worker-facing AttemptSpec plus sandbox/candidate-policy decisions.
   */
  dispatchPlan?: DispatchPlan;
  reviewRecord?: SessionReviewRecord;
  candidateState?: CandidateState;
  candidate?: CandidateRecord;
  /**
   * Phase 4 PR3 lineage: predecessor attempt in the same turn when this
   * attempt was produced by a retry. Undefined for the first attempt of a
   * turn. Additive — older persisted records omit this field.
   */
  parentAttemptId?: string;
  /**
   * Phase 4 PR3 lineage: free-text rationale captured at retry submit time
   * (e.g. "tests failed, retrying with verbose"). The structured enum lives
   * on {@link TurnTransition.reason}; this field carries the author-supplied
   * free text that the enum cannot express. Additive — absent on older
   * persisted records and on non-retry attempts.
   */
  retryReason?: string;
};

export type SessionTurnRecord = {
  turnId: string;
  prompt: string;
  mode: string;
  status: TurnStatus;
  attempts: SessionAttemptRecord[];
  createdAt: string;
  updatedAt: string;
  /**
   * Most recent structured review for this turn. Mirrors the tail attempt's
   * `reviewRecord` so list/summary paths do not need to scan every attempt.
   */
  latestReview?: SessionReviewRecord;
  /**
   * Inline token budget parsed from the user prompt (e.g. `+500k` → 500_000).
   * Set at turn creation; worker-side enforcement is deferred to Phase 3.
   */
  tokenBudget?: number;
  /**
   * Phase 4 PR4 lineage: predecessor turn when this turn was created by a
   * `/timeline` rewind (`user_rewind`). Undefined for turns that were
   * appended normally rather than branched from an earlier turn. Additive —
   * older persisted records and tolerant reads must treat absence as "not a
   * rewind".
   */
  parentTurnId?: string;
};

export type SessionRecord = {
  schemaVersion: number;
  sessionId: string;
  repoRoot: string;
  /**
   * Short human-readable label for the session, derived from the first turn's
   * prompt (truncated at 80 chars, with trailing `…` when truncated). Falls
   * back to `sessionId` when no turn/prompt is available.
   */
  title: string;
  status: SessionStatus;
  turns: SessionTurnRecord[];
  createdAt: string;
  updatedAt: string;
};

export const CURRENT_SESSION_SCHEMA_VERSION = 2 as const;

export const SESSION_TITLE_MAX_LENGTH = 80;

export const sessionTerminalStatuses: readonly TerminalSessionStatus[] = [
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;

export const isTerminalSessionStatus = (status: SessionStatus): status is TerminalSessionStatus =>
  sessionTerminalStatuses.includes(status as TerminalSessionStatus);

export const createSessionTaskKey = (sessionId: string, taskId: string): string =>
  `${BAKUDO_PROTOCOL_SCHEMA_VERSION}:${sessionId}:${taskId}`;

export const isCompletedAttemptRecord = (attempt: SessionAttemptRecord): boolean =>
  isTerminalTaskStatus(attempt.status) && attempt.status === "succeeded";

/**
 * Derive a session title from the first turn's prompt. Truncates at
 * {@link SESSION_TITLE_MAX_LENGTH} chars (trailing whitespace trimmed; `…`
 * suffix appended when truncated). Falls back to `goal` and then `sessionId`.
 */
export const deriveSessionTitle = (source: {
  sessionId: string;
  goal?: string | undefined;
  turns?: ReadonlyArray<Pick<SessionTurnRecord, "prompt">> | undefined;
}): string => {
  const firstPrompt = source.turns?.[0]?.prompt;
  // `goal` is accepted for migration callers (v1→v2), but not on SessionRecord.
  const candidates = [firstPrompt, source.goal, source.sessionId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length <= SESSION_TITLE_MAX_LENGTH) {
      return trimmed;
    }
    return `${trimmed.slice(0, SESSION_TITLE_MAX_LENGTH).replace(/\s+$/u, "")}…`;
  }
  return source.sessionId;
};

const SUCCESS_OUTCOME_TOKENS: readonly string[] = ["accepted", "accept"];
const RETRYABLE_OUTCOME_TOKENS: readonly string[] = ["retry", "failed", "retryable_failure"];
const BLOCKED_OUTCOME_TOKENS: readonly string[] = ["blocked", "blocked_needs_user", "ask"];

/**
 * Coerce a loose/legacy `reviewedOutcome` string into the structured
 * {@link SessionReviewOutcome} enum per the Phase 2 mapping table.
 */
export const coerceSessionReviewOutcome = (value: unknown): SessionReviewOutcome => {
  if (typeof value !== "string") {
    return "retryable_failure";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return "retryable_failure";
  }
  if (
    normalized === "success" ||
    normalized.includes("success") ||
    SUCCESS_OUTCOME_TOKENS.includes(normalized)
  ) {
    return "success";
  }
  if (normalized === "policy_denied") {
    return "policy_denied";
  }
  if (normalized === "incomplete_needs_follow_up") {
    return "incomplete_needs_follow_up";
  }
  if (BLOCKED_OUTCOME_TOKENS.includes(normalized)) {
    return "blocked_needs_user";
  }
  if (RETRYABLE_OUTCOME_TOKENS.includes(normalized)) {
    return "retryable_failure";
  }
  return "retryable_failure";
};

/**
 * Coerce a loose/legacy `reviewedAction` string into the structured
 * {@link SessionReviewAction} enum per the Phase 2 mapping table.
 */
export const coerceSessionReviewAction = (value: unknown): SessionReviewAction => {
  if (typeof value !== "string") {
    return "accept";
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "accept":
    case "accepted":
      return "accept";
    case "retry":
      return "retry";
    case "ask_user":
    case "ask":
      return "ask_user";
    case "halt":
    case "stop":
      return "halt";
    case "follow_up":
    case "followup":
      return "follow_up";
    default:
      return "accept";
  }
};
