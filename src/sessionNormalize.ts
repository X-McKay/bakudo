import { randomUUID } from "node:crypto";

import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionReviewRecord,
  SessionTurnRecord,
} from "./sessionTypes.js";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  coerceSessionReviewAction,
  coerceSessionReviewOutcome,
  deriveSessionTitle,
} from "./sessionTypes.js";

export const createReviewId = (): string => `review-${Date.now()}-${randomUUID().slice(0, 8)}`;

export const extractDispatchCommand = (metadata: unknown): string[] | undefined => {
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const raw = (metadata as { aboxCommand?: unknown }).aboxCommand;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const command = raw.map((entry) => String(entry));
  return command.length === 0 ? undefined : command;
};

export const coerceLooseReviewRecord = (
  value: unknown,
  fallbackAttemptId: string,
  fallbackReviewedAt: string,
): SessionReviewRecord | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const attemptId =
    typeof record.attemptId === "string" && record.attemptId.length > 0
      ? record.attemptId
      : fallbackAttemptId;
  const reviewedAt =
    typeof record.reviewedAt === "string" && record.reviewedAt.length > 0
      ? record.reviewedAt
      : fallbackReviewedAt;
  const reviewId =
    typeof record.reviewId === "string" && record.reviewId.length > 0
      ? record.reviewId
      : createReviewId();
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  const intentId = typeof record.intentId === "string" ? record.intentId : undefined;
  return {
    reviewId,
    attemptId,
    ...(intentId === undefined ? {} : { intentId }),
    outcome: coerceSessionReviewOutcome(record.outcome),
    action: coerceSessionReviewAction(record.action),
    ...(reason === undefined ? {} : { reason }),
    reviewedAt,
  };
};

const attachTailReviewRecord = (
  attempts: SessionAttemptRecord[],
  reviewRecord: SessionReviewRecord | undefined,
): SessionAttemptRecord[] => {
  if (reviewRecord === undefined || attempts.length === 0) {
    return attempts;
  }
  return attempts.map((attempt, index) =>
    index === attempts.length - 1 ? { ...attempt, reviewRecord } : attempt,
  );
};

const normalizeV2Attempt = (attempt: SessionAttemptRecord): SessionAttemptRecord => {
  const dispatchCommand =
    attempt.dispatchCommand ??
    (attempt.metadata === undefined ? undefined : extractDispatchCommand(attempt.metadata));
  return {
    ...attempt,
    ...(dispatchCommand === undefined ? {} : { dispatchCommand }),
  };
};

const normalizeV2Turn = (turn: SessionTurnRecord): SessionTurnRecord => {
  const attempts = turn.attempts.map(normalizeV2Attempt);
  const fallbackAttemptId = attempts.at(-1)?.attemptId ?? `${turn.turnId}-attempt-1`;
  const fallbackReviewedAt = turn.updatedAt;
  const looseReview = turn.latestReview as unknown;
  const coercedReview =
    looseReview === undefined
      ? undefined
      : coerceLooseReviewRecord(looseReview, fallbackAttemptId, fallbackReviewedAt);
  const attemptsWithReview = attachTailReviewRecord(attempts, coercedReview);
  return {
    ...turn,
    attempts: attemptsWithReview,
    ...(coercedReview === undefined ? {} : { latestReview: coercedReview }),
  };
};

export type NormalizeOverrides = { createdAt?: string; updatedAt?: string };

export const normalizeV2Record = (
  record: SessionRecord,
  overrides: NormalizeOverrides = {},
): SessionRecord => {
  const turns = record.turns.map(normalizeV2Turn);
  // Previously-saved v2 files may still carry `goal` on disk; read it
  // loosely from the raw JSON to derive a title when `title` is missing.
  const rawGoal = (record as unknown as Record<string, unknown>).goal;
  const goalFallback = typeof rawGoal === "string" ? rawGoal : undefined;
  const title =
    typeof record.title === "string" && record.title.length > 0
      ? record.title
      : deriveSessionTitle({
          sessionId: record.sessionId,
          goal: goalFallback,
          turns,
        });
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    sessionId: record.sessionId,
    repoRoot: record.repoRoot ?? ".",
    title,
    status: record.status,
    turns,
    createdAt: overrides.createdAt ?? record.createdAt,
    updatedAt: overrides.updatedAt ?? record.updatedAt,
  };
};

/**
 * Parse a raw JSON object into a {@link SessionRecord}. The accepted contract
 * is the post-cutover v2 schema only: `schemaVersion` must equal
 * {@link CURRENT_SESSION_SCHEMA_VERSION} and `turns` must be an array. Any
 * other shape throws.
 */
export const loadSessionRecord = (raw: unknown): SessionRecord => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("unrecognized session record shape");
  }
  const candidate = raw as { schemaVersion?: unknown; turns?: unknown };
  if (
    candidate.schemaVersion === CURRENT_SESSION_SCHEMA_VERSION &&
    Array.isArray(candidate.turns)
  ) {
    return normalizeV2Record(raw as SessionRecord);
  }
  throw new Error("unrecognized session record shape");
};
