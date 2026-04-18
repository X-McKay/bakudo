import assert from "node:assert/strict";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { parseWorkerArgs, workerSelfCapabilities } from "../../src/workerCli.js";
import {
  decodeWorkerTaskSpec,
  encodeWorkerEnvelope,
  runWorkerTask,
  serializeWorkerResult,
  WORKER_EVENT_PREFIX,
  type WorkerTaskSpec,
} from "../../src/workerRuntime.js";

const encodeTaskSpec = (spec: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(spec), "utf8").toString("base64");

const testCwd = ".";

test("worker cli parses the base64 task spec transport", () => {
  const specB64 = encodeTaskSpec({
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    taskId: "task-1",
    sessionId: "session-1",
    goal: "printf hello",
    assumeDangerousSkipPermissions: true,
  });

  const args = parseWorkerArgs([
    `--task-spec-b64=${specB64}`,
    "--shell",
    "bash",
    "--timeout-seconds",
    "7",
    "--max-output-bytes",
    "4096",
    "--heartbeat-ms",
    "25",
    "--kill-grace-ms",
    "300",
  ]);

  assert.equal(args.taskSpecB64, specB64);
  assert.equal(args.shell, "bash");
  assert.equal(args.timeoutSeconds, 7);
  assert.equal(args.maxOutputBytes, 4096);
  assert.equal(args.heartbeatIntervalMs, 25);
  assert.equal(args.killGraceMs, 300);
  assert.equal(args.capabilities, false);
});

test("worker cli parses --capabilities and the self-report shape covers the host's compile surface", () => {
  // Phase 6 W3: a `bakudo-worker --capabilities` invocation produces a
  // JSON document whose protocolVersions/taskKinds/executionEngines align
  // with what the host advertises in protocol.ts. The probe parser on the
  // host side rejects anything narrower without falling back to v1.
  const args = parseWorkerArgs(["--capabilities"]);
  assert.equal(args.capabilities, true);

  const caps = workerSelfCapabilities();
  assert.equal(caps.source, "probe");
  assert.ok(caps.protocolVersions.includes(3), "advertises v3 (current host contract)");
  assert.ok(caps.taskKinds.includes("assistant_job"));
  assert.ok(caps.taskKinds.includes("explicit_command"));
  assert.ok(caps.taskKinds.includes("verification_check"));
  assert.ok(caps.executionEngines.includes("agent_cli"));
  assert.ok(caps.executionEngines.includes("shell"));
});

test("worker runtime decodes task specs and emits machine-parsable envelopes", () => {
  const specB64 = encodeTaskSpec({
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    taskId: "task-2",
    sessionId: "session-2",
    goal: "printf 'worker spec'",
    cwd: testCwd,
    assumeDangerousSkipPermissions: true,
  });

  const decoded = decodeWorkerTaskSpec(specB64);
  assert.equal(decoded.taskId, "task-2");
  assert.equal(decoded.goal, "printf 'worker spec'");

  const eventLine = encodeWorkerEnvelope(WORKER_EVENT_PREFIX, {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    kind: "task.started",
    taskId: "task-2",
    sessionId: "session-2",
    status: "running",
    timestamp: "2026-04-13T00:00:00.000Z",
  });
  assert.match(eventLine, /^BAKUDO_WORKER_EVENT /);

  const resultLine = serializeWorkerResult({
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    taskId: "task-2",
    sessionId: "session-2",
    status: "succeeded",
    summary: "command completed successfully",
    finishedAt: "2026-04-13T00:00:01.000Z",
    command: "printf 'worker spec'",
    cwd: testCwd,
    shell: "bash",
    timeoutSeconds: 120,
    durationMs: 1,
    exitCode: 0,
    exitSignal: null,
    stdout: "worker spec",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    assumeDangerousSkipPermissions: true,
  });

  assert.match(resultLine, /^BAKUDO_WORKER_RESULT /);
});

test("worker runtime executes a bounded shell goal and returns structured output", async () => {
  const spec = decodeWorkerTaskSpec(
    encodeTaskSpec({
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      taskId: "task-3",
      sessionId: "session-3",
      goal: "printf 'hello worker'",
      cwd: testCwd,
      assumeDangerousSkipPermissions: true,
    }),
  );

  const events: string[] = [];
  const result = await runWorkerTask(spec, {
    shell: "bash",
    timeoutSeconds: 10,
    maxOutputBytes: 4096,
    heartbeatIntervalMs: 25,
    killGraceMs: 100,
    emit: (event) => {
      events.push(`${event.kind}:${event.status}`);
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "hello worker");
  assert.equal(result.stderr, "");
  assert.ok(events.includes("task.queued:queued"));
  assert.ok(events.includes("task.started:running"));
  assert.ok(events.includes("task.progress:running"));
  assert.ok(events.includes("task.completed:succeeded"));
  assert.equal(result.schemaVersion, BAKUDO_PROTOCOL_SCHEMA_VERSION);
  assert.equal(result.assumeDangerousSkipPermissions, true);
  assert.equal(result.artifacts?.includes("stdout"), true);
  assert.equal(result.artifacts?.includes("stderr"), true);
});

// ---------------------------------------------------------------------------
// Task-kind dispatch (Commit 2 — AttemptSpec dispatch + legacy fallback)
// ---------------------------------------------------------------------------

const attemptSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "session-dispatch",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-dispatch",
  intentId: "intent-1",
  mode: "build",
  taskKind: "explicit_command",
  prompt: "echo dispatched",
  instructions: [],
  cwd: testCwd,
  execution: { engine: "shell", command: ["printf", "dispatched"] },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 10, maxOutputBytes: 4096, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

test("workerRuntime dispatches explicit_command via task-kind when taskKind present", async () => {
  const spec = attemptSpec();
  // Pass the AttemptSpec as a WorkerTaskSpec (duck-typed via the runtime check)
  const events: string[] = [];
  const result = await runWorkerTask(spec as unknown as WorkerTaskSpec, {
    timeoutSeconds: 10,
    maxOutputBytes: 4096,
    heartbeatIntervalMs: 25,
    killGraceMs: 100,
    emit: (event) => {
      events.push(`${event.kind}:${event.status}`);
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "dispatched");
  assert.ok(events.includes("task.completed:succeeded"));
});

test("workerRuntime falls back to legacy bash -lc when no taskKind present", async () => {
  const legacySpec = decodeWorkerTaskSpec(
    encodeTaskSpec({
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      taskId: "task-legacy",
      sessionId: "session-legacy",
      goal: "printf 'legacy path'",
      cwd: testCwd,
      assumeDangerousSkipPermissions: true,
    }),
  );

  const result = await runWorkerTask(legacySpec, {
    shell: "bash",
    timeoutSeconds: 10,
    maxOutputBytes: 4096,
    heartbeatIntervalMs: 25,
    killGraceMs: 100,
    emit: () => undefined,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.stdout.trim(), "legacy path");
  assert.equal(result.command, "printf 'legacy path'");
});

test("workerRuntime uses budget.timeoutSeconds from AttemptSpec", async () => {
  const spec = attemptSpec({
    execution: { engine: "shell", command: ["printf", "budget-test"] },
    budget: { timeoutSeconds: 5, maxOutputBytes: 2048, heartbeatIntervalMs: 1000 },
  });

  const result = await runWorkerTask(spec as unknown as WorkerTaskSpec, {
    killGraceMs: 100,
    emit: () => undefined,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.timeoutSeconds, 5);
});
