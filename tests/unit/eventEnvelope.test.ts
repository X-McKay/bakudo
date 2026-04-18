import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_EVENT_SCHEMA_VERSION,
  createSessionEvent,
  eventIdFor,
  isSessionEventKind,
  sessionEventKinds,
  type SessionEventEnvelope,
  type SessionEventKind,
} from "../../src/protocol.js";

test("eventIdFor produces the event-<epochMs>-<rand8> shape", () => {
  const eventId = eventIdFor();
  assert.match(eventId, /^event-\d+-[0-9a-f]{8}$/u);
  const another = eventIdFor();
  assert.notEqual(eventId, another);
});

test("createSessionEvent stamps schemaVersion 2 and fills defaults", () => {
  const envelope = createSessionEvent({
    kind: "host.dispatch_started",
    sessionId: "session-a",
    turnId: "turn-1",
    attemptId: "attempt-1",
    actor: "host",
    payload: {
      attemptId: "attempt-1",
      goal: "say hello",
      mode: "plan",
      assumeDangerousSkipPermissions: false,
    },
  });

  assert.equal(envelope.schemaVersion, SESSION_EVENT_SCHEMA_VERSION);
  assert.equal(envelope.schemaVersion, 2);
  assert.match(envelope.eventId, /^event-\d+-[0-9a-f]{8}$/u);
  assert.equal(envelope.kind, "host.dispatch_started");
  assert.equal(envelope.actor, "host");
  assert.equal(envelope.sessionId, "session-a");
  assert.equal(envelope.turnId, "turn-1");
  assert.equal(envelope.attemptId, "attempt-1");
  assert.equal(typeof envelope.timestamp, "string");
  assert.equal(envelope.payload.goal, "say hello");
});

test("createSessionEvent honours explicit timestamp and eventId overrides", () => {
  const envelope = createSessionEvent({
    kind: "host.review_started",
    sessionId: "session-b",
    turnId: "turn-1",
    attemptId: "attempt-2",
    actor: "host",
    payload: { attemptId: "attempt-2" },
    timestamp: "2026-04-15T00:00:00.000Z",
    eventId: "event-override-1",
  });
  assert.equal(envelope.timestamp, "2026-04-15T00:00:00.000Z");
  assert.equal(envelope.eventId, "event-override-1");
});

test("createSessionEvent omits absent optional fields instead of inserting undefined", () => {
  const envelope = createSessionEvent({
    kind: "user.turn_submitted",
    sessionId: "session-c",
    actor: "user",
    payload: { prompt: "hi", mode: "plan" },
  });
  // turnId/attemptId intentionally absent.
  assert.equal("turnId" in envelope, false);
  assert.equal("attemptId" in envelope, false);
});

test("JSON serialization of an envelope contains no embedded newlines", () => {
  const envelope = createSessionEvent({
    kind: "worker.attempt_progress",
    sessionId: "session-d",
    turnId: "turn-1",
    attemptId: "attempt-1",
    actor: "worker",
    payload: {
      attemptId: "attempt-1",
      status: "running",
      message: "line1\nline2\nline3",
    },
  });
  const serialized = JSON.stringify(envelope);
  // The outer JSON line must be exactly one line; inner `\n` characters are
  // escaped as `\\n` in the serialized form.
  assert.equal(serialized.includes("\n"), false);
  assert.ok(serialized.includes("\\n"));
});

test("sessionEventKinds runtime array matches the SessionEventKind union", () => {
  const expected: readonly SessionEventKind[] = [
    "user.turn_submitted",
    "host.turn_queued",
    "host.plan_started",
    "host.plan_completed",
    "host.approval_requested",
    "host.approval_resolved",
    "host.dispatch_started",
    "worker.attempt_started",
    "worker.attempt_progress",
    "worker.attempt_completed",
    "worker.attempt_failed",
    "host.review_started",
    "host.review_completed",
    "host.artifact_registered",
    "host.event_skipped",
  ];
  assert.deepEqual(sessionEventKinds, expected);
  for (const kind of expected) {
    assert.equal(isSessionEventKind(kind), true);
  }
  assert.equal(isSessionEventKind("definitely.not.a.kind"), false);
});

test("compile-time narrowing: wrong payload shape is rejected", () => {
  // Positive control: the correct shape type-checks.
  const ok: SessionEventEnvelope = createSessionEvent({
    kind: "host.turn_queued",
    sessionId: "session-e",
    actor: "host",
    payload: { turnId: "turn-1", prompt: "x", mode: "plan" },
  });
  assert.equal(ok.kind, "host.turn_queued");

  // Negative control: missing required fields on a mapped kind should fail to
  // compile. Captured here with @ts-expect-error so a future regression
  // (accidentally widening the map) will turn into a compile error.
  createSessionEvent({
    kind: "host.turn_queued",
    sessionId: "session-e",
    actor: "host",
    // @ts-expect-error payload.mode is required for host.turn_queued
    payload: { turnId: "turn-1", prompt: "x" },
  });
});
