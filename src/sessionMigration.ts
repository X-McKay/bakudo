import { randomUUID } from "node:crypto";

import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionReviewRecord,
  SessionStatus,
  SessionTaskRecord,
  SessionTurnRecord,
  TurnStatus,
} from "./sessionTypes.js";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  coerceSessionReviewAction,
  coerceSessionReviewOutcome,
  deriveSessionTitle,
} from "./sessionTypes.js";

export const createReviewId = (): string => `review-${Date.now()}-${randomUUID().slice(0, 8)}`;

export const taskStatusToTurnStatus = (status: string): TurnStatus => {
  switch (status) {
    case "queued":
    case "running":
    case "failed":
      return status;
    case "succeeded":
      return "completed";
    case "needs_review":
      return "reviewing";
    case "blocked":
      return "awaiting_user";
    case "cancelled":
      return "failed";
    default:
      return "queued";
  }
};

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

export const synthesizeReviewFromMetadata = (
  attemptId: string,
  metadata: unknown,
  reviewedAt: string,
  lastMessage: string | undefined,
): SessionReviewRecord | undefined => {
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const outcomeRaw = (metadata as { reviewedOutcome?: unknown }).reviewedOutcome;
  const actionRaw = (metadata as { reviewedAction?: unknown }).reviewedAction;
  if (outcomeRaw === undefined && actionRaw === undefined) {
    return undefined;
  }
  return {
    reviewId: createReviewId(),
    attemptId,
    outcome: coerceSessionReviewOutcome(outcomeRaw),
    action: coerceSessionReviewAction(actionRaw),
    ...(typeof lastMessage === "string" && lastMessage.length > 0 ? { reason: lastMessage } : {}),
    reviewedAt,
  };
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

export const migrateV1TaskToAttempt = (task: SessionTaskRecord): SessionAttemptRecord => {
  const dispatchCommand = extractDispatchCommand(task.metadata);
  return {
    attemptId: task.taskId,
    status: task.status,
    ...(task.request === undefined ? {} : { request: task.request }),
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.lastMessage === undefined ? {} : { lastMessage: task.lastMessage }),
    ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
    ...(dispatchCommand === undefined ? {} : { dispatchCommand }),
  };
};

export type V1RawSession = {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  assumeDangerousSkipPermissions: boolean;
  tasks?: SessionTaskRecord[];
  createdAt: string;
  updatedAt: string;
};

export const migrateV1ToV2 = (raw: V1RawSession): SessionRecord => {
  const tasks = raw.tasks ?? [];
  const attempts = tasks.map(migrateV1TaskToAttempt);
  const latestStatus = tasks.at(-1)?.status ?? "queued";
  const latestTask = tasks.at(-1);
  const latestAttemptId = attempts.at(-1)?.attemptId ?? latestTask?.taskId ?? "task-1";
  const latestReview =
    latestTask === undefined
      ? undefined
      : synthesizeReviewFromMetadata(
          latestAttemptId,
          latestTask.metadata,
          raw.updatedAt,
          latestTask.lastMessage,
        );
  const turn: SessionTurnRecord = {
    turnId: "turn-1",
    prompt: raw.goal,
    mode: tasks[0]?.request?.mode ?? "build",
    status: taskStatusToTurnStatus(latestStatus),
    attempts,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(latestReview === undefined ? {} : { latestReview }),
  };
  const turns = attempts.length === 0 ? [] : [turn];
  const title = deriveSessionTitle({
    sessionId: raw.sessionId,
    goal: raw.goal,
    turns,
  });
  return {
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    sessionId: raw.sessionId,
    repoRoot: ".",
    title,
    status: raw.status,
    turns,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
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
  return {
    ...turn,
    attempts,
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

export const loadSessionRecord = (raw: unknown): SessionRecord => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("unrecognized session record shape");
  }
  const candidate = raw as {
    schemaVersion?: unknown;
    turns?: unknown;
    tasks?: unknown;
    goal?: unknown;
  };
  if (
    candidate.schemaVersion === CURRENT_SESSION_SCHEMA_VERSION &&
    Array.isArray(candidate.turns)
  ) {
    return normalizeV2Record(raw as SessionRecord);
  }
  if (Array.isArray(candidate.tasks) && typeof candidate.goal === "string") {
    return migrateV1ToV2(raw as V1RawSession);
  }
  throw new Error("unrecognized session record shape");
};
