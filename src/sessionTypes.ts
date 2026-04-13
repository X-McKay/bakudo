import type { ProtocolSchemaVersion, TaskRequest, TaskResult, TaskStatus } from "./protocol.js";
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

export type SessionTaskRecord = {
  taskId: string;
  status: TaskStatus;
  request?: TaskRequest;
  result?: TaskResult;
  lastMessage?: string;
  metadata?: Record<string, unknown>;
};

export type SessionRecord = {
  schemaVersion: ProtocolSchemaVersion;
  sessionId: string;
  goal: string;
  status: SessionStatus;
  assumeDangerousSkipPermissions: boolean;
  tasks: SessionTaskRecord[];
  createdAt: string;
  updatedAt: string;
};

export const sessionTerminalStatuses: readonly TerminalSessionStatus[] = [
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;

export const isTerminalSessionStatus = (
  status: SessionStatus,
): status is TerminalSessionStatus => sessionTerminalStatuses.includes(status as TerminalSessionStatus);

export const createSessionTaskKey = (sessionId: string, taskId: string): string =>
  `${BAKUDO_PROTOCOL_SCHEMA_VERSION}:${sessionId}:${taskId}`;

export const isCompletedTaskRecord = (task: SessionTaskRecord): boolean =>
  isTerminalTaskStatus(task.status) && task.status === "succeeded";
