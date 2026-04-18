import {
  createSessionEvent,
  type SessionEventEnvelope,
  type SessionEventKind,
  type TaskProgressEvent,
  type TaskProgressEventKind,
} from "../protocol.js";
import type { WorkerTaskProgressEvent } from "../workerRuntime.js";

/**
 * Projects Phase 1 worker progress events onto the v2 session event envelope.
 *
 * The coalescer continues to consume raw {@link WorkerTaskProgressEvent}s on a
 * parallel sink; this projector feeds the persistent event log in
 * lock-step with each legacy emission. See the phase-2 PR3 brief for the
 * authoritative kind mapping.
 */

/**
 * Translate a legacy `task.*` event kind onto a v2 {@link SessionEventKind}.
 * `task.checkpoint` collapses onto `worker.attempt_progress`; producers must
 * also set `payload.subKind = "checkpoint"` so downstream consumers can tell
 * the two apart.
 */
export const mapLegacyKind = (kind: TaskProgressEventKind): SessionEventKind => {
  switch (kind) {
    case "task.queued":
      return "worker.attempt_started";
    case "task.started":
      return "worker.attempt_started";
    case "task.progress":
      return "worker.attempt_progress";
    case "task.checkpoint":
      return "worker.attempt_progress";
    case "task.completed":
      return "worker.attempt_completed";
    case "task.failed":
      return "worker.attempt_failed";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled legacy task kind: ${String(exhaustive)}`);
    }
  }
};

/**
 * Add a key/value pair to the payload only when `value` is neither `undefined`
 * nor `null`. Keeps serialized envelopes free of noisy absent fields.
 */
const assignDefined = <T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined | null,
): T & Partial<Record<K, V>> => {
  if (value !== undefined && value !== null) {
    (target as Record<string, unknown>)[key] = value;
  }
  return target as T & Partial<Record<K, V>>;
};

/**
 * Build a v2 envelope from a legacy worker event. The projector accepts both
 * the stricter {@link WorkerTaskProgressEvent} (bytes/elapsed fields set by
 * the worker runtime) and the base {@link TaskProgressEvent} (kind/status
 * only) — the union type simplifies adapter call sites.
 *
 * Invariants:
 *  - `actor` is always `"worker"` (the coalescer/projector pair never remap
 *    origin events to the host).
 *  - `sessionId`/`turnId`/`attemptId` are copied verbatim from the caller's
 *    context, not inferred from the legacy event.
 *  - Optional fields are omitted (not set to `undefined`) when absent.
 */
export const projectLegacyWorkerEvent = (
  sessionId: string,
  turnId: string,
  attemptId: string,
  event: WorkerTaskProgressEvent | TaskProgressEvent,
): SessionEventEnvelope => {
  const mappedKind = mapLegacyKind(event.kind);
  const payload: Record<string, unknown> = { attemptId, status: event.status };

  if (event.kind === "task.checkpoint") {
    payload.subKind = "checkpoint";
  }

  assignDefined(payload, "message", event.message);
  assignDefined(payload, "percentComplete", event.percentComplete);

  // Worker-only fields are optional on the union; access behind an `in`
  // narrowing guard to keep TaskProgressEvent callers type-safe.
  if ("stdoutBytes" in event) {
    assignDefined(payload, "stdoutBytes", event.stdoutBytes);
  }
  if ("stderrBytes" in event) {
    assignDefined(payload, "stderrBytes", event.stderrBytes);
  }
  if ("outputBytes" in event) {
    assignDefined(payload, "outputBytes", event.outputBytes);
  }
  if ("elapsedMs" in event) {
    assignDefined(payload, "elapsedMs", event.elapsedMs);
  }
  if ("exitCode" in event) {
    assignDefined(payload, "exitCode", event.exitCode);
  }
  if ("exitSignal" in event) {
    assignDefined(payload, "exitSignal", event.exitSignal);
  }
  if ("timedOut" in event) {
    assignDefined(payload, "timedOut", event.timedOut);
  }

  return createSessionEvent({
    kind: mappedKind,
    sessionId,
    turnId,
    attemptId,
    actor: "worker",
    payload: payload as never,
    timestamp: event.timestamp,
  });
};
