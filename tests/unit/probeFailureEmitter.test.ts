/**
 * Wave 6c PR9 carryover #6 — `worker.capability_probe_failed` emitter tests.
 *
 * W3 carried the `fallbackReason` on ProbeOutcome. This PR ships the
 * session-event emission deferred during W3. Rules:
 *  - Emit a `host.event_skipped` envelope with
 *    `payload.skippedKind === "worker.capability_probe_failed"` when the
 *    probe falls back.
 *  - Do NOT emit when the probe succeeds (even if successful probes return
 *    restrictive shapes that later fail negotiation — that path is a
 *    WorkerProtocolMismatchError, not a skipped-event diagnostic).
 *  - Fire exactly ONCE per runner lifetime even if multiple attempts are
 *    dispatched against the same runner.
 */

import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { ABoxAdapter } from "../../src/aboxAdapter.js";
import { ABoxTaskRunner } from "../../src/aboxTaskRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import {
  buildProbeFailedSkippedEnvelope,
  createSessionProbeFailureEmitter,
  PROBE_FAILED_SKIPPED_KIND,
  type ProbeOutcome,
} from "../../src/host/workerCapabilities.js";
import { hostDefaultFallbackCapabilities, type SessionEventEnvelope } from "../../src/protocol.js";

const buildSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "sess-pr9",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "do work",
  instructions: [],
  cwd: "/repo",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 30, maxOutputBytes: 1000, heartbeatIntervalMs: 1000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

const noopSpawn = (() => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    exitCode: number | null;
    signalCode: string | null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => undefined;
  queueMicrotask(() => child.emit("close", 0, null));
  return child;
}) as never;

// ---------------------------------------------------------------------------
// buildProbeFailedSkippedEnvelope — pure helper tests
// ---------------------------------------------------------------------------

test("envelope builder: returns envelope when probe fell back with a reason", () => {
  const outcome: ProbeOutcome = {
    capabilities: hostDefaultFallbackCapabilities(),
    fallbackReason: "abox does not support --capabilities",
  };
  const env = buildProbeFailedSkippedEnvelope({
    sessionId: "sess-1",
    bin: "/tmp/abox",
    outcome,
  });
  assert.ok(env !== null);
  assert.equal(env.kind, "host.event_skipped");
  assert.equal(env.sessionId, "sess-1");
  const payload = env.payload as {
    skippedKind?: string;
    reason?: string;
    bin?: string;
    fallbackSource?: string;
  };
  assert.equal(payload.skippedKind, PROBE_FAILED_SKIPPED_KIND);
  assert.equal(payload.skippedKind, "worker.capability_probe_failed");
  assert.equal(payload.reason, "abox does not support --capabilities");
  assert.equal(payload.bin, "/tmp/abox");
  assert.equal(payload.fallbackSource, "fallback_host_default");
});

test("envelope builder: returns null when the probe succeeded (source=probe)", () => {
  const outcome: ProbeOutcome = {
    capabilities: {
      protocolVersions: [3],
      taskKinds: ["assistant_job"],
      executionEngines: ["agent_cli"],
      source: "probe",
    },
  };
  const env = buildProbeFailedSkippedEnvelope({
    sessionId: "sess-1",
    bin: "/tmp/abox",
    outcome,
  });
  assert.equal(env, null, "successful probes must not produce a skipped-event diagnostic");
});

test("envelope builder: returns null when fallbackReason is missing", () => {
  const outcome: ProbeOutcome = {
    capabilities: hostDefaultFallbackCapabilities(),
    // fallbackReason intentionally omitted
  };
  const env = buildProbeFailedSkippedEnvelope({
    sessionId: "sess-1",
    bin: "/tmp/abox",
    outcome,
  });
  assert.equal(env, null);
});

// ---------------------------------------------------------------------------
// Runner-level: emitter fires on fallback, not on success, exactly once
// ---------------------------------------------------------------------------

test("runner: emitter fires when probe falls back", async () => {
  const received: Array<{ outcome: ProbeOutcome; bin: string; spec: AttemptSpec }> = [];
  const adapter = new ABoxAdapter("/tmp/abox", undefined, undefined, noopSpawn);
  const provider = async (): Promise<ProbeOutcome> => ({
    capabilities: hostDefaultFallbackCapabilities(),
    fallbackReason: "abox does not support --capabilities",
  });
  const runner = new ABoxTaskRunner(adapter, provider, undefined, undefined, (input) => {
    received.push(input);
  });
  await runner.runAttempt(buildSpec());
  assert.equal(received.length, 1, "emitter must fire exactly once on fallback");
  assert.equal(received[0]!.bin, "/tmp/abox");
  assert.equal(received[0]!.outcome.capabilities.source, "fallback_host_default");
  assert.equal(received[0]!.spec.sessionId, "sess-pr9");
});

test("runner: emitter does NOT fire when probe succeeds", async () => {
  const received: unknown[] = [];
  const adapter = new ABoxAdapter("/tmp/abox", undefined, undefined, noopSpawn);
  const provider = async (): Promise<ProbeOutcome> => ({
    capabilities: {
      protocolVersions: [3],
      taskKinds: ["assistant_job"],
      executionEngines: ["agent_cli"],
      source: "probe",
    },
  });
  const runner = new ABoxTaskRunner(adapter, provider, undefined, undefined, (input) => {
    received.push(input);
  });
  await runner.runAttempt(buildSpec());
  assert.equal(received.length, 0, "emitter MUST NOT fire on a successful probe");
});

test("runner: emitter fires exactly once across multiple runAttempt calls (dedupe)", async () => {
  let calls = 0;
  const adapter = new ABoxAdapter("/tmp/abox", undefined, undefined, noopSpawn);
  const provider = async (): Promise<ProbeOutcome> => ({
    capabilities: hostDefaultFallbackCapabilities(),
    fallbackReason: "fallback",
  });
  const runner = new ABoxTaskRunner(adapter, provider, undefined, undefined, () => {
    calls += 1;
  });
  await runner.runAttempt(buildSpec());
  await runner.runAttempt(buildSpec({ attemptId: "attempt-2" }));
  await runner.runAttempt(buildSpec({ attemptId: "attempt-3" }));
  assert.equal(calls, 1, "emitter must fire once per runner-instance lifetime");
});

// ---------------------------------------------------------------------------
// createSessionProbeFailureEmitter — factory test
// ---------------------------------------------------------------------------

test("factory: forwards a writer invocation with the envelope on fallback", async () => {
  const writes: Array<{ storageRoot: string; sessionId: string; envelope: SessionEventEnvelope }> =
    [];
  const writer = async (
    storageRoot: string,
    sessionId: string,
    envelope: SessionEventEnvelope,
  ): Promise<void> => {
    writes.push({ storageRoot, sessionId, envelope });
  };
  const emit = createSessionProbeFailureEmitter({
    storageRoot: "/data",
    emitSessionEvent: writer,
  });
  emit({
    outcome: {
      capabilities: hostDefaultFallbackCapabilities(),
      fallbackReason: "abox old",
    },
    bin: "/tmp/abox",
    spec: buildSpec(),
  });
  // factory is fire-and-forget — await the microtask queue.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.storageRoot, "/data");
  assert.equal(writes[0]!.sessionId, "sess-pr9");
  const payload = writes[0]!.envelope.payload as { skippedKind?: string };
  assert.equal(payload.skippedKind, "worker.capability_probe_failed");
});

test("factory: no-op on a successful probe (no writer invocation)", async () => {
  let writes = 0;
  const writer = async (): Promise<void> => {
    writes += 1;
  };
  const emit = createSessionProbeFailureEmitter({
    storageRoot: "/data",
    emitSessionEvent: writer,
  });
  emit({
    outcome: {
      capabilities: {
        protocolVersions: [3],
        taskKinds: ["assistant_job"],
        executionEngines: ["agent_cli"],
        source: "probe",
      },
    },
    bin: "/tmp/abox",
    spec: buildSpec(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("factory: swallows writer errors so dispatch keeps flowing", async () => {
  const writer = async (): Promise<void> => {
    throw new Error("boom");
  };
  const emit = createSessionProbeFailureEmitter({
    storageRoot: "/data",
    emitSessionEvent: writer,
  });
  // No throw expected.
  emit({
    outcome: {
      capabilities: hostDefaultFallbackCapabilities(),
      fallbackReason: "x",
    },
    bin: "/tmp/abox",
    spec: buildSpec(),
  });
  await new Promise((resolve) => setImmediate(resolve));
});
