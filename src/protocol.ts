export const BAKUDO_PROTOCOL_SCHEMA_VERSION = 1 as const;

export type ProtocolSchemaVersion = typeof BAKUDO_PROTOCOL_SCHEMA_VERSION;
export type TaskMode = "build" | "plan";

export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "needs_review";

export type TerminalTaskStatus = Exclude<TaskStatus, "queued" | "running">;

export type TaskProgressEventKind =
  | "task.queued"
  | "task.started"
  | "task.progress"
  | "task.checkpoint"
  | "task.completed"
  | "task.failed";

export type TaskRequest = {
  schemaVersion: ProtocolSchemaVersion;
  taskId: string;
  sessionId: string;
  goal: string;
  mode?: TaskMode;
  streamId?: string;
  cwd?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
  assumeDangerousSkipPermissions: boolean;
};

export type TaskProgressEvent = {
  schemaVersion: ProtocolSchemaVersion;
  kind: TaskProgressEventKind;
  taskId: string;
  sessionId: string;
  status: TaskStatus;
  message?: string;
  percentComplete?: number;
  timestamp: string;
};

export type TaskResult = {
  schemaVersion: ProtocolSchemaVersion;
  taskId: string;
  sessionId: string;
  status: TerminalTaskStatus;
  summary: string;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt: string;
  artifacts?: string[];
};

export const terminalTaskStatuses: readonly TerminalTaskStatus[] = [
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "needs_review",
] as const;

export const taskProgressEventKinds: readonly TaskProgressEventKind[] = [
  "task.queued",
  "task.started",
  "task.progress",
  "task.checkpoint",
  "task.completed",
  "task.failed",
] as const;

export const isTerminalTaskStatus = (status: TaskStatus): status is TerminalTaskStatus =>
  terminalTaskStatuses.includes(status as TerminalTaskStatus);

export const isTaskProgressEventKind = (kind: string): kind is TaskProgressEventKind =>
  taskProgressEventKinds.includes(kind as TaskProgressEventKind);

export const createTaskSessionKey = (sessionId: string, taskId: string): string =>
  `${sessionId}:${taskId}`;
