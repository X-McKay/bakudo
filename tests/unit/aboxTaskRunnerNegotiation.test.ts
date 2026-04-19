/**
 * Phase 6 W3 — `ABoxTaskRunner.runAttempt` negotiation seam tests.
 *
 * Verifies plan §W3 hard rule 267 ("mismatch errors must happen before
 * dispatch, not halfway through execution"). The runner is wired with a
 * stub capabilities provider; on a mismatch, no spawn should fire.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { ABoxAdapter } from "../../src/aboxAdapter.js";
import { ABoxTaskRunner } from "../../src/aboxTaskRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { WorkerProtocolMismatchError } from "../../src/host/errors.js";
import type { ProbeOutcome } from "../../src/host/workerCapabilities.js";
import { hostDefaultFallbackCapabilities } from "../../src/protocol.js";

const buildSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "sess-1",
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

test("runAttempt: probe-fail fallback still dispatches (2026-04-18 plan amendment)", async () => {
  // Plan amendment: when the probe fails, the host falls back to its own
  // declared capability set and dispatch proceeds. Mismatches still fire
  // synchronously when a successful probe returns a restrictive shape
  // (see the next test).
  let spawnCalls = 0;
  const spawnFn = ((_file: string) => {
    spawnCalls += 1;
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

  const adapter = new ABoxAdapter("/tmp/abox", undefined, spawnFn);
  const provider = async (): Promise<ProbeOutcome> => ({
    capabilities: hostDefaultFallbackCapabilities(),
    fallbackReason: "abox does not support --capabilities",
  });
  // Wave 6c PR9 carryover #6 — capture the diagnostic emission alongside
  // the existing dispatch-proceeds assertion.
  const emitted: Array<{ outcome: ProbeOutcome; bin: string }> = [];
  const runner = new ABoxTaskRunner(adapter, provider, undefined, undefined, ({ outcome, bin }) => {
    emitted.push({ outcome, bin });
  });

  const result = await runner.runAttempt(buildSpec());
  assert.equal(spawnCalls, 1, "host-default fallback must not block dispatch");
  assert.equal(result.ok, true);
  assert.equal(emitted.length, 1, "probe-failure diagnostic must fire exactly once");
  assert.equal(emitted[0]!.outcome.capabilities.source, "fallback_host_default");
  assert.equal(emitted[0]!.outcome.fallbackReason, "abox does not support --capabilities");
});

test("runAttempt: restrictive successful probe still rejects synchronously (hard rule 267)", async () => {
  let spawnCalls = 0;
  const spawnFn = (() => {
    spawnCalls += 1;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    return child;
  }) as never;

  const adapter = new ABoxAdapter("/tmp/abox", undefined, spawnFn);
  const provider = async (): Promise<ProbeOutcome> => ({
    // Hypothetical future abox that advertises a restrictive shape over
    // --capabilities. Mismatch detection must still fire before dispatch.
    capabilities: {
      protocolVersions: [1],
      taskKinds: ["explicit_command"],
      executionEngines: ["shell"],
      source: "probe",
    },
  });
  const runner = new ABoxTaskRunner(adapter, provider);

  await assert.rejects(
    () => runner.runAttempt(buildSpec()),
    (err: unknown) => {
      assert.ok(err instanceof WorkerProtocolMismatchError);
      assert.equal(err.exitCode, 4);
      const rendered = err.toRendered();
      assert.equal(rendered.details?.workerCapabilitiesSource, "probe");
      return true;
    },
  );
  assert.equal(spawnCalls, 0, "must NOT spawn when a successful probe surfaces a mismatch");
});

test("runAttempt: proceeds to spawn when capabilities cover the spec", async () => {
  let spawnCalls = 0;
  const spawnFn = ((_file: string) => {
    spawnCalls += 1;
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

  const adapter = new ABoxAdapter("/tmp/abox", undefined, spawnFn);
  const provider = async (): Promise<ProbeOutcome> => ({
    capabilities: {
      protocolVersions: [3],
      taskKinds: ["assistant_job"],
      executionEngines: ["agent_cli"],
      source: "probe",
    },
  });
  const runner = new ABoxTaskRunner(adapter, provider);

  const result = await runner.runAttempt(buildSpec());
  assert.equal(spawnCalls, 1);
  assert.equal(result.ok, true);
});

test("runAttempt: queries the provider with the adapter's bin path", async () => {
  const seenBins: string[] = [];
  const spawnFn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as never;

  const adapter = new ABoxAdapter("/opt/abox-custom", undefined, spawnFn);
  const provider = async (bin: string): Promise<ProbeOutcome> => {
    seenBins.push(bin);
    return {
      capabilities: {
        protocolVersions: [3],
        taskKinds: ["assistant_job"],
        executionEngines: ["agent_cli"],
        source: "probe",
      },
    };
  };
  const runner = new ABoxTaskRunner(adapter, provider);

  await runner.runAttempt(buildSpec());
  assert.deepEqual(seenBins, ["/opt/abox-custom"]);
});
