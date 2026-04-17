import assert from "node:assert/strict";
import test from "node:test";

import {
  BAKUDO_PROTOCOL_SCHEMA_VERSION,
  type TaskProgressEvent,
  type TaskProgressEventKind,
} from "../../src/protocol.js";
import { mapLegacyKind, projectLegacyWorkerEvent } from "../../src/host/eventProjector.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";

const baseEvent = (overrides: Partial<TaskProgressEvent> = {}): TaskProgressEvent => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
  kind: "task.progress",
  taskId: "task-1",
  sessionId: "session-1",
  status: "running",
  timestamp: "2026-04-15T00:00:00.000Z",
  ...overrides,
});

test("mapLegacyKind routes every TaskProgressEventKind onto a v2 kind", () => {
  const expected: Record<TaskProgressEventKind, string> = {
    "task.queued": "worker.attempt_started",
    "task.started": "worker.attempt_started",
    "task.progress": "worker.attempt_progress",
    "task.checkpoint": "worker.attempt_progress",
    "task.completed": "worker.attempt_completed",
    "task.failed": "worker.attempt_failed",
  };
  for (const [legacy, v2] of Object.entries(expected)) {
    assert.equal(mapLegacyKind(legacy as TaskProgressEventKind), v2);
  }
});

test("projectLegacyWorkerEvent: task.checkpoint sets payload.subKind and collapses onto progress", () => {
  const envelope = projectLegacyWorkerEvent(
    "session-x",
    "turn-1",
    "attempt-1",
    baseEvent({ kind: "task.checkpoint", status: "running" }),
  );
  assert.equal(envelope.kind, "worker.attempt_progress");
  assert.equal(envelope.payload.subKind, "checkpoint");
  assert.equal(envelope.actor, "worker");
});

test("projectLegacyWorkerEvent: actor is always 'worker' regardless of origin", () => {
  const kinds: TaskProgressEventKind[] = [
    "task.queued",
    "task.started",
    "task.progress",
    "task.checkpoint",
    "task.completed",
    "task.failed",
  ];
  for (const kind of kinds) {
    const envelope = projectLegacyWorkerEvent(
      "s",
      "t",
      "a",
      baseEvent({ kind, status: kind === "task.failed" ? "failed" : "running" }),
    );
    assert.equal(envelope.actor, "worker");
  }
});

test("projectLegacyWorkerEvent: copies sessionId/turnId/attemptId verbatim", () => {
  const envelope = projectLegacyWorkerEvent(
    "session-custom",
    "turn-custom",
    "attempt-custom",
    baseEvent({ kind: "task.started", status: "running" }),
  );
  assert.equal(envelope.sessionId, "session-custom");
  assert.equal(envelope.turnId, "turn-custom");
  assert.equal(envelope.attemptId, "attempt-custom");
});

test("projectLegacyWorkerEvent: optional worker fields pass through when set", () => {
  const workerEvent: WorkerTaskProgressEvent = {
    ...baseEvent({ kind: "task.completed", status: "succeeded" }),
    exitCode: 0,
    exitSignal: null,
    stdoutBytes: 123,
    stderrBytes: 7,
    elapsedMs: 1500,
    timedOut: false,
  };
  const envelope = projectLegacyWorkerEvent("s", "t", "a", workerEvent);
  assert.equal(envelope.payload.exitCode, 0);
  assert.equal(envelope.payload.stdoutBytes, 123);
  assert.equal(envelope.payload.stderrBytes, 7);
  assert.equal(envelope.payload.elapsedMs, 1500);
  assert.equal(envelope.payload.timedOut, false);
  // exitSignal is null → excluded by assignDefined.
  assert.equal("exitSignal" in envelope.payload, false);
});

test("projectLegacyWorkerEvent: undefined worker fields are omitted", () => {
  const envelope = projectLegacyWorkerEvent(
    "s",
    "t",
    "a",
    baseEvent({ kind: "task.progress", status: "running" }),
  );
  assert.equal("exitCode" in envelope.payload, false);
  assert.equal("stdoutBytes" in envelope.payload, false);
  assert.equal("stderrBytes" in envelope.payload, false);
  assert.equal("elapsedMs" in envelope.payload, false);
});

test("projectLegacyWorkerEvent: message and percentComplete flow into payload when present", () => {
  const envelope = projectLegacyWorkerEvent(
    "s",
    "t",
    "a",
    baseEvent({
      kind: "task.progress",
      status: "running",
      message: "halfway",
      percentComplete: 50,
    }),
  );
  assert.equal(envelope.payload.message, "halfway");
  assert.equal(envelope.payload.percentComplete, 50);
});

test("projectLegacyWorkerEvent: preserves legacy timestamp on the envelope", () => {
  const envelope = projectLegacyWorkerEvent(
    "s",
    "t",
    "a",
    baseEvent({ timestamp: "2026-03-01T12:00:00.000Z" }),
  );
  assert.equal(envelope.timestamp, "2026-03-01T12:00:00.000Z");
});

test("projectLegacyWorkerEvent: schemaVersion on envelope is 2 regardless of legacy schema", () => {
  const envelope = projectLegacyWorkerEvent(
    "s",
    "t",
    "a",
    baseEvent({ kind: "task.started", status: "running" }),
  );
  assert.equal(envelope.schemaVersion, 2);
});
