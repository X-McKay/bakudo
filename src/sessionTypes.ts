import type { AttemptSpec } from "./attemptProtocol.js";
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
  | "failed";

export type AttemptStatus = TaskStatus;

/**
 * @deprecated v1 session task record. Kept for migration compatibility.
 * v2 uses {@link SessionAttemptRecord} inside {@link SessionTurnRecord}.
 */
export type SessionTaskRecord = {
  taskId: string;
  status: TaskStatus;
  request?: TaskRequest;
  result?: TaskResult;
  lastMessage?: string;
  metadata?: Record<string, unknown>;
};

export type SessionReviewOutcome =
  | "success"
  | "retryable_failure"
  | "blocked_needs_user"
  | "policy_denied"
  | "incomplete_needs_follow_up";

export type SessionReviewAction = "accept" | "retry" | "ask_user" | "halt" | "follow_up";

/**
 * Structured host-side review of an attempt outcome. Lives on the turn
 * (`SessionTurnRecord.latestReview`), not on the attempt, so a turn can carry
 * its most recent verdict even after multiple retry attempts accumulate.
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
   */
  attemptSpec?: AttemptSpec;
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
   * Most recent structured review for this turn. May be absent until the first
   * attempt completes a review pass.
   */
  latestReview?: SessionReviewRecord;
  /**
   * Inline token budget parsed from the user prompt (e.g. `+500k` → 500_000).
   * Set at turn creation; worker-side enforcement is deferred to Phase 3.
   */
  tokenBudget?: number;
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
  /** @deprecated v1 compatibility — do not read in host code */
  tasks?: SessionTaskRecord[];
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

/**
 * @deprecated use attempt/turn helpers. Retained for migration compatibility.
 */
export const isCompletedTaskRecord = (task: SessionTaskRecord): boolean =>
  isTerminalTaskStatus(task.status) && task.status === "succeeded";

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
