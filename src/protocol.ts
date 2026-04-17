import { randomUUID } from "node:crypto";

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

/**
 * Session event envelope v2 — the common wrapper shared by every producer in
 * the host/worker/reviewer pipeline. See `.bakudo-ux-briefs/phase2-pr3-*.md`.
 */

export const SESSION_EVENT_SCHEMA_VERSION = 2 as const;

export type SessionEventSchemaVersion = typeof SESSION_EVENT_SCHEMA_VERSION;

export type EventActor = "user" | "host" | "worker" | "reviewer";

/**
 * Declared kinds for v2 session events. `host.event_skipped` is reserved for
 * Phase 2 PR6+ (no producer in PR3). Producers in PR3: `user.turn_submitted`,
 * `host.turn_queued`, `host.dispatch_started`, `worker.attempt_started`,
 * `worker.attempt_progress`, `worker.attempt_completed`,
 * `worker.attempt_failed`, `host.review_started`, `host.review_completed`.
 */
export type SessionEventKind =
  | "user.turn_submitted"
  | "host.turn_queued"
  | "host.dispatch_started"
  | "host.dispatch_completed"
  | "host.review_started"
  | "host.review_completed"
  | "host.event_skipped"
  | "worker.attempt_started"
  | "worker.attempt_progress"
  | "worker.attempt_completed"
  | "worker.attempt_failed"
  | "reviewer.decision"
  | "reviewer.guidance"
  | "host.turn_completed"
  | "host.session_completed";

export const sessionEventKinds: readonly SessionEventKind[] = [
  "user.turn_submitted",
  "host.turn_queued",
  "host.dispatch_started",
  "host.dispatch_completed",
  "host.review_started",
  "host.review_completed",
  "host.event_skipped",
  "worker.attempt_started",
  "worker.attempt_progress",
  "worker.attempt_completed",
  "worker.attempt_failed",
  "reviewer.decision",
  "reviewer.guidance",
  "host.turn_completed",
  "host.session_completed",
] as const;

export const isSessionEventKind = (kind: string): kind is SessionEventKind =>
  sessionEventKinds.includes(kind as SessionEventKind);

export type SessionEventEnvelope = {
  schemaVersion: SessionEventSchemaVersion;
  eventId: string;
  sessionId: string;
  turnId?: string;
  attemptId?: string;
  actor: EventActor;
  kind: SessionEventKind;
  timestamp: string;
  payload: Record<string, unknown>;
};

/**
 * Narrowed per-kind payload shapes. Intentionally partial: only PR3 producer
 * kinds are present. Unmapped kinds fall back to `Record<string, unknown>` in
 * {@link createSessionEvent}.
 */
export type SessionEventPayloadMap = {
  "user.turn_submitted": {
    prompt: string;
    mode: string;
  };
  "host.turn_queued": {
    turnId: string;
    prompt: string;
    mode: string;
  };
  "host.dispatch_started": {
    attemptId: string;
    goal: string;
    mode: TaskMode;
    assumeDangerousSkipPermissions: boolean;
  };
  "worker.attempt_started": {
    attemptId: string;
    status: TaskStatus;
    message?: string;
  };
  "worker.attempt_progress": {
    attemptId: string;
    status: TaskStatus;
    message?: string;
    subKind?: "checkpoint";
    percentComplete?: number;
    stdoutBytes?: number;
    stderrBytes?: number;
    outputBytes?: number;
    elapsedMs?: number;
  };
  "worker.attempt_completed": {
    attemptId: string;
    status: TaskStatus;
    exitCode?: number | null;
    exitSignal?: string | null;
    elapsedMs?: number;
    timedOut?: boolean;
  };
  "worker.attempt_failed": {
    attemptId: string;
    status: TaskStatus;
    exitCode?: number | null;
    exitSignal?: string | null;
    elapsedMs?: number;
    timedOut?: boolean;
    message?: string;
  };
  "host.review_started": {
    attemptId: string;
  };
  "host.review_completed": {
    attemptId: string;
    outcome: string;
    action: string;
    reason: string;
  };
};

type PayloadOf<K extends SessionEventKind> = K extends keyof SessionEventPayloadMap
  ? SessionEventPayloadMap[K]
  : Record<string, unknown>;

export type CreateSessionEventInput<K extends SessionEventKind> = {
  kind: K;
  sessionId: string;
  turnId?: string;
  attemptId?: string;
  actor: EventActor;
  payload: PayloadOf<K>;
  timestamp?: string;
  eventId?: string;
};

/**
 * Generate an `eventId` with the conventional `event-<epochMs>-<rand8>` shape
 * used across the v2 envelope surface. Mirrors `transition-`/`review-` IDs.
 */
export const eventIdFor = (): string => `event-${Date.now()}-${randomUUID().slice(0, 8)}`;

/**
 * Build a v2 {@link SessionEventEnvelope}. Callers pass a narrowed payload per
 * `SessionEventPayloadMap`; unmapped kinds accept any `Record<string, unknown>`.
 * The helper fills `schemaVersion`, `eventId`, and `timestamp` defaults.
 */
export const createSessionEvent = <K extends SessionEventKind>(
  input: CreateSessionEventInput<K>,
): SessionEventEnvelope => {
  const envelope: SessionEventEnvelope = {
    schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
    eventId: input.eventId ?? eventIdFor(),
    sessionId: input.sessionId,
    actor: input.actor,
    kind: input.kind,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload as Record<string, unknown>,
  };
  if (input.turnId !== undefined) {
    envelope.turnId = input.turnId;
  }
  if (input.attemptId !== undefined) {
    envelope.attemptId = input.attemptId;
  }
  return envelope;
};
