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

export type SessionAttemptRecord = {
  attemptId: string;
  status: AttemptStatus;
  request?: TaskRequest;
  result?: TaskResult;
  lastMessage?: string;
  metadata?: Record<string, unknown>;
};

export type SessionTurnRecord = {
  turnId: string;
  prompt: string;
  mode: string;
  status: TurnStatus;
  attempts: SessionAttemptRecord[];
  createdAt: string;
  updatedAt: string;
};

export type SessionRecord = {
  schemaVersion: number;
  sessionId: string;
  repoRoot: string;
  goal: string;
  status: SessionStatus;
  assumeDangerousSkipPermissions: boolean;
  turns: SessionTurnRecord[];
  createdAt: string;
  updatedAt: string;
  /**
   * @deprecated retained only for v1 migration compatibility. Always empty in v2-originated records.
   */
  tasks?: SessionTaskRecord[];
};

export const CURRENT_SESSION_SCHEMA_VERSION = 2 as const;

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
