/**
 * Regression: `ABoxTaskRunner` must stage the worker runtime import closure
 * into the guest tempdir before executing `workerCli.js`.
 *
 * A live Phase 0 smoke run reached the VM, then failed with
 * `ERR_MODULE_NOT_FOUND` because `workerCli.js` imported `mainModule.js`
 * from the temp bundle and that file was never staged.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ABoxAdapter } from "../../src/aboxAdapter.js";
import { ABoxTaskRunner } from "../../src/aboxTaskRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import type { ProbeOutcome } from "../../src/host/workerCapabilities.js";

const buildSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "sess-stage",
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

test("runAttempt: stages the runtime worker module bundle before launch", async () => {
  let capturedArgs: readonly string[] | undefined;
  const spawnFn = ((_file: string, args: readonly string[]) => {
    capturedArgs = [...args];
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

  const adapter = new ABoxAdapter("/tmp/abox", undefined, undefined, spawnFn);
  const provider = async (): Promise<ProbeOutcome> => ({
    capabilities: {
      protocolVersions: [3],
      taskKinds: ["assistant_job"],
      executionEngines: ["agent_cli"],
      source: "probe",
    },
  });
  const runner = new ABoxTaskRunner(adapter, provider);

  await runner.runAttempt(buildSpec());

  assert.ok(capturedArgs, "expected a spawn invocation");
  const launchScript = capturedArgs.at(-1);
  assert.equal(capturedArgs.at(-2), "-lc");
  assert.ok(typeof launchScript === "string" && launchScript.length > 0);

  assert.match(launchScript, /mkdir -p "\$tmpdir\/worker"/);
  assert.match(launchScript, /> "\$tmpdir\/protocol\.js"/);
  assert.match(launchScript, /> "\$tmpdir\/mainModule\.js"/);
  assert.match(launchScript, /> "\$tmpdir\/workerRuntime\.js"/);
  assert.match(launchScript, /> "\$tmpdir\/worker\/taskKinds\.js"/);
  assert.match(launchScript, /> "\$tmpdir\/worker\/assistantJobRunner\.js"/);
  assert.match(launchScript, /> "\$tmpdir\/worker\/commandRunner\.js"/);
  assert.match(launchScript, /> "\$tmpdir\/worker\/checkRunner\.js"/);
  assert.match(launchScript, /node "\$tmpdir\/workerCli\.js"/);
});
