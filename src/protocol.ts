import { randomUUID } from "node:crypto";

import type { PermissionRule } from "./attemptProtocol.js";

export * from "./attemptProtocol.js";

export const BAKUDO_PROTOCOL_SCHEMA_VERSION = 1 as const;

export type ProtocolSchemaVersion = typeof BAKUDO_PROTOCOL_SCHEMA_VERSION;
export type TaskMode = "build" | "plan";

// ---------------------------------------------------------------------------
// Phase 6 W3 — Host/Worker Version Negotiation surface
// ---------------------------------------------------------------------------

/**
 * Protocol versions the host can speak when dispatching to a worker. The host
 * compiles {@link AttemptSpec} v3 (the Phase 3 contract that supersedes the
 * legacy {@link TaskRequest} v1), so it advertises both. A worker must include
 * at least one of these in its `protocolVersions` to accept dispatch.
 */
export const BAKUDO_HOST_PROTOCOL_VERSIONS: readonly number[] = [1, 3] as const;

/**
 * Highest protocol the host knows how to compile. Used in
 * {@link WorkerProtocolMismatchError} messages so operators can read the
 * "host wants v3, worker offers [1]" line directly.
 */
export const BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION = 3 as const;

/** Task kinds the host can compile {@link AttemptSpec}s for. */
export const BAKUDO_HOST_TASK_KINDS: readonly string[] = [
  "assistant_job",
  "explicit_command",
  "verification_check",
] as const;

/** Execution engines the host knows how to dispatch through. */
export const BAKUDO_HOST_EXECUTION_ENGINES: readonly string[] = ["agent_cli", "shell"] as const;

/**
 * Capabilities a worker advertises in response to a `--capabilities` probe.
 * Shape mirrors the plan's suggested JSON (lines 239–262); the three core
 * arrays are required so the parser can validate before dispatch. `source`
 * is host-side metadata — `"probe"` when the worker emitted JSON,
 * `"fallback_host_default"` when the probe failed and the host fell back
 * to its own declared capability set (per the 2026-04-18 plan amendment;
 * see `plans/bakudo-ux/phase-6-w3-capability-probe-finding.md`).
 */
export type WorkerCapabilities = {
  protocolVersions: number[];
  taskKinds: string[];
  executionEngines: string[];
  source: "probe" | "fallback_host_default";
};

/**
 * Compose the host-default fallback capabilities used when the worker
 * capability probe fails. Reflects the invariant that bakudo ships both
 * host and worker-in-rootfs today — what the host can compile, the
 * shipped worker can accept. A successful probe returning a restrictive
 * shape still takes precedence, so mismatches remain detectable whenever
 * they are observable.
 */
export const hostDefaultFallbackCapabilities = (): WorkerCapabilities => ({
  protocolVersions: [...BAKUDO_HOST_PROTOCOL_VERSIONS],
  taskKinds: [...BAKUDO_HOST_TASK_KINDS],
  executionEngines: [...BAKUDO_HOST_EXECUTION_ENGINES],
  source: "fallback_host_default",
});

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
  | "host.plan_started"
  | "host.plan_completed"
  | "host.approval_requested"
  | "host.approval_resolved"
  | "host.dispatch_started"
  | "host.provenance_started"
  | "host.provenance_finalized"
  | "worker.attempt_started"
  | "worker.attempt_progress"
  | "worker.attempt_completed"
  | "worker.attempt_failed"
  | "host.review_started"
  | "host.review_completed"
  | "host.artifact_registered"
  | "host.event_skipped";

export const sessionEventKinds: readonly SessionEventKind[] = [
  "user.turn_submitted",
  "host.turn_queued",
  "host.plan_started",
  "host.plan_completed",
  "host.approval_requested",
  "host.approval_resolved",
  "host.dispatch_started",
  "host.provenance_started",
  "host.provenance_finalized",
  "worker.attempt_started",
  "worker.attempt_progress",
  "worker.attempt_completed",
  "worker.attempt_failed",
  "host.review_started",
  "host.review_completed",
  "host.artifact_registered",
  "host.event_skipped",
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
  "host.provenance_started": {
    provenanceId: string;
    attemptId: string;
    sandboxTaskId?: string;
    dispatchCommand: string[];
  };
  "host.provenance_finalized": {
    provenanceId: string;
    attemptId: string;
    exitCode: number | null;
    timedOut: boolean;
    elapsedMs: number;
  };
  "host.approval_requested": {
    approvalId: string;
    request: {
      tool: string;
      argument: string;
      displayCommand: string;
    };
    /**
     * `composerMode` and `autopilot` inlined as string literals rather than
     * importing `ComposerMode` from `src/host/appState.ts` — keeps the
     * protocol module free of host-side imports (see the comment on
     * `host.artifact_registered` for the same pattern).
     */
    policySnapshot: {
      agent: string;
      composerMode: "standard" | "plan" | "autopilot";
      autopilot: boolean;
    };
    requestedAt: string;
  };
  "host.approval_resolved": {
    approvalId: string;
    decision: "approved" | "denied" | "auto_approved" | "auto_denied";
    decidedBy: "user_prompt" | "hook_sync" | "autopilot" | "recorded_rule";
    /**
     * Denormalised PermissionRule shape — mirrors {@link PermissionRule}
     * from `./attemptProtocol.ts` (which `protocol.ts` already re-exports
     * at the top of this module).
     */
    matchedRule: PermissionRule;
    persistedRule?: PermissionRule;
    rationale: string;
    decidedAt: string;
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
  "host.artifact_registered": {
    artifactId: string;
    // String-union inlined to keep `src/protocol.ts` free of host-side
    // imports; mirrors the `ArtifactKind` type exported from
    // `src/host/artifactStore.ts`.
    kind: "result" | "log" | "dispatch" | "patch" | "summary" | "diff" | "report";
    name: string;
    path: string;
    turnId: string;
    attemptId?: string;
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
