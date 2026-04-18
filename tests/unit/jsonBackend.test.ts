import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import {
  createSessionEventLogWriter,
  emitSessionEvent,
  readSessionEventLog,
  type JsonEventSink,
} from "../../src/host/eventLogWriter.js";
import { selectRenderFrame, type RenderFrame } from "../../src/host/renderModel.js";
import type { RendererStdout } from "../../src/host/rendererBackend.js";
import {
  buildJsonErrorEnvelope,
  JsonBackend,
  type JsonErrorEnvelope,
} from "../../src/host/renderers/jsonBackend.js";
import { createSessionEvent, type SessionEventEnvelope } from "../../src/protocol.js";

/**
 * Phase 5 PR3 — JsonBackend full wiring.
 *
 * The JSON backend has two orthogonal channels:
 *   1. `render(frame)` is a documented no-op (TTY-only concern).
 *   2. `emitJsonEnvelope` / `emitJsonError` write one JSONL line each.
 *
 * These tests cover the event-driven contract end to end, including the tee
 * from `eventLogWriter` → `JsonBackend` that the one-shot path relies on.
 */

const captureStdout = (): RendererStdout & { chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY: false,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
};

const buildFrame = (): RenderFrame =>
  selectRenderFrame({
    state: initialHostAppState(),
    transcript: [],
    repoLabel: "my-repo",
  });

const sampleEnvelope = (attemptId: string): SessionEventEnvelope =>
  createSessionEvent({
    kind: "host.dispatch_started",
    sessionId: "session-pr3",
    turnId: "turn-1",
    attemptId,
    actor: "host",
    payload: {
      attemptId,
      goal: "test goal",
      mode: "build",
      assumeDangerousSkipPermissions: false,
    },
  });

test("JsonBackend.render is a no-op (no stdout write) — render state is TTY-only", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);
  const frame = buildFrame();

  backend.render(frame);
  backend.render(frame);

  assert.equal(stdout.chunks.length, 0, "render must not write to stdout");
});

test("emitJsonEnvelope writes one JSONL line per call, terminated with \\n", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);

  backend.emitJsonEnvelope(sampleEnvelope("attempt-1"));
  backend.emitJsonEnvelope(sampleEnvelope("attempt-2"));
  backend.emitJsonEnvelope(sampleEnvelope("attempt-3"));

  assert.equal(stdout.chunks.length, 3, "one line per envelope");
  for (const chunk of stdout.chunks) {
    assert.ok(chunk.endsWith("\n"), "chunk ends with bare newline");
    assert.ok(!chunk.slice(0, -1).includes("\n"), "no embedded newlines in the JSON body");
  }
});

test("emitJsonEnvelope output round-trips through JSON.parse and preserves the envelope", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);
  const envelope = sampleEnvelope("attempt-round-trip");

  backend.emitJsonEnvelope(envelope);

  assert.equal(stdout.chunks.length, 1);
  const parsed = JSON.parse(stdout.chunks[0]!.trimEnd()) as SessionEventEnvelope;
  assert.deepEqual(parsed, envelope);
  assert.equal(parsed.kind, "host.dispatch_started");
  assert.equal(parsed.sessionId, "session-pr3");
});

test("emitJsonError produces a single-line error envelope with code + message + details", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);

  backend.emitJsonError({
    code: "policy_denied",
    message: "write to /etc/passwd rejected",
    details: { tool: "shell_write", path: "/etc/passwd" },
  });

  assert.equal(stdout.chunks.length, 1);
  const line = stdout.chunks[0]!;
  assert.ok(line.endsWith("\n"));
  const parsed = JSON.parse(line.trimEnd()) as JsonErrorEnvelope;
  assert.equal(parsed.kind, "error");
  assert.equal(parsed.code, "policy_denied");
  assert.equal(parsed.message, "write to /etc/passwd rejected");
  assert.deepEqual(parsed.details, { tool: "shell_write", path: "/etc/passwd" });
});

test("emitJsonError defaults details to an empty object when omitted", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);

  backend.emitJsonError({ code: "user_input", message: "bad CLI args" });

  const parsed = JSON.parse(stdout.chunks[0]!.trimEnd()) as JsonErrorEnvelope;
  assert.deepEqual(parsed.details, {});
});

test("buildJsonErrorEnvelope (pure builder) matches the emit-shape for every taxonomy code", () => {
  const codes = [
    "user_input",
    "approval_denied",
    "policy_denied",
    "worker_protocol_mismatch",
    "worker_execution",
  ] as const;
  for (const code of codes) {
    const envelope = buildJsonErrorEnvelope({ code, message: `m:${code}` });
    assert.equal(envelope.kind, "error");
    assert.equal(envelope.code, code);
    assert.equal(envelope.message, `m:${code}`);
    assert.deepEqual(envelope.details, {});
  }
});

test("eventLogWriter tees through JsonEventSink: same line stream as the disk log", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-tee-"));
  try {
    const stdout = captureStdout();
    const backend = new JsonBackend(stdout);
    const sink: JsonEventSink = backend;
    const writer = createSessionEventLogWriter(root, "session-tee", { sink });

    await writer.append(sampleEnvelope("attempt-tee-1"));
    await writer.append(sampleEnvelope("attempt-tee-2"));
    await writer.close();

    // Stdout received two JSONL lines.
    assert.equal(stdout.chunks.length, 2);
    const stdoutLines = stdout.chunks.map((chunk) => chunk.trimEnd());

    // Disk received the same two envelopes (in the same order).
    const fromDisk = await readSessionEventLog(root, "session-tee");
    assert.equal(fromDisk.length, 2);
    const fromStdout = stdoutLines.map((line) => JSON.parse(line) as SessionEventEnvelope);
    assert.deepEqual(fromStdout, fromDisk);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eventLogWriter tees even when the sink throws (disk persistence is protected)", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-sink-throws-"));
  try {
    let attempts = 0;
    const sink: JsonEventSink = {
      emitJsonEnvelope: () => {
        attempts += 1;
        throw new Error("EPIPE simulated");
      },
    };
    const writer = createSessionEventLogWriter(root, "session-throw", { sink });
    await writer.append(sampleEnvelope("attempt-throw-1"));
    await writer.close();

    assert.equal(attempts, 1, "sink was invoked exactly once");
    const fromDisk = await readSessionEventLog(root, "session-throw");
    assert.equal(fromDisk.length, 1, "durable write must not be affected by a throwing sink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("emitSessionEvent (one-shot helper) forwards to the sink when supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-oneshot-"));
  try {
    const stdout = captureStdout();
    const backend = new JsonBackend(stdout);

    const envelope = sampleEnvelope("attempt-oneshot");
    await emitSessionEvent(root, "session-oneshot", envelope, backend);

    assert.equal(stdout.chunks.length, 1);
    const parsed = JSON.parse(stdout.chunks[0]!.trimEnd()) as SessionEventEnvelope;
    assert.deepEqual(parsed, envelope);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("emitSessionEvent without a sink still persists the envelope to disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-nosink-"));
  try {
    const envelope = sampleEnvelope("attempt-nosink");
    await emitSessionEvent(root, "session-nosink", envelope);

    const fromDisk = await readSessionEventLog(root, "session-nosink");
    assert.equal(fromDisk.length, 1);
    assert.equal(fromDisk[0]!.attemptId, "attempt-nosink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
