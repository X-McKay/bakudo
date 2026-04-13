import assert from "node:assert/strict";
import test from "node:test";

import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { parseWorkerArgs } from "../../src/workerCli.js";
import {
  decodeWorkerTaskSpec,
  encodeWorkerEnvelope,
  runWorkerTask,
  serializeWorkerResult,
  WORKER_EVENT_PREFIX,
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
