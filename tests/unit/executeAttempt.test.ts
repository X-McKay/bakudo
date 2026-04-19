import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  type ABoxTaskRunner,
  type TaskExecutionRecord,
  type TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type SessionEventEnvelope } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";
import type { EventLogWriter } from "../../src/host/eventLogWriter.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { executeAttempt, toAttemptExecutionResult } from "../../src/host/executeAttempt.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-ea-"));
const baseArgs = (storageRoot: string): HostCliArgs => ({
  command: "run",
  config: "config/default.json",
  aboxBin: "abox",
  mode: "build",
  yes: false,
  shell: "bash",
  timeoutSeconds: 120,
  maxOutputBytes: 256 * 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  storageRoot,
  copilot: {},
});

const makeSpec = (sessionId: string, overrides?: Partial<AttemptSpec>): AttemptSpec => ({
  schemaVersion: 3,
  sessionId,
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-123",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "implement a feature",
  instructions: ["User prompt: implement a feature"],
  cwd: ".",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 300, maxOutputBytes: 10_000_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-0", label: "make requested change" }],
  artifactRequests: [{ name: "result.json", kind: "result", required: true }],
  ...overrides,
});

const baseWorkerResult = (sessionId: string) => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION as 1,
  taskId: "task-1",
  sessionId,
  status: "succeeded" as const,
  summary: "done",
  startedAt: "2026-04-15T00:00:00.000Z",
  finishedAt: "2026-04-15T00:00:01.000Z",
  exitCode: 0,
  command: "echo",
  cwd: ".",
  shell: "bash",
  timeoutSeconds: 60,
  durationMs: 1000,
  exitSignal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  assumeDangerousSkipPermissions: false,
});

const stubRunner = (sessionId: string): ABoxTaskRunner => {
  const base: WorkerTaskProgressEvent = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    kind: "task.progress",
    taskId: "task-1",
    sessionId,
    status: "running",
    timestamp: "2026-04-15T00:00:00.500Z",
  };
  const events: WorkerTaskProgressEvent[] = [
    { ...base, kind: "task.started", status: "running" },
    { ...base, kind: "task.progress", message: "working" },
    { ...base, kind: "task.completed", status: "succeeded" },
  ];
  const execution: TaskExecutionRecord = {
    events,
    result: baseWorkerResult(sessionId),
    workerErrors: [],
    rawOutput: "hello",
    ok: true,
    metadata: { cmd: ["abox", "run"], taskId: "abox-stub-1" },
  };
  const handler = async (
    _s: unknown,
    _o: unknown,
    handlers: TaskRunnerHandlers = {},
  ): Promise<TaskExecutionRecord> => {
    for (const e of events) handlers.onEvent?.(e);
    return execution;
  };
  return { runTask: handler, runAttempt: handler } as unknown as ABoxTaskRunner;
};

const nopWriter = (): EventLogWriter => ({
  append: async () => {},
  flush: async () => {},
  close: async () => {},
  getDroppedBatchCount: () => 0,
  getFilePath: () => "/dev/null",
});

const seedSession = async (store: SessionStore, sessionId: string, prompt: string) =>
  store.createSession({
    sessionId,
    goal: prompt,
    repoRoot: "/tmp",
    assumeDangerousSkipPermissions: false,
    status: "running",
    turns: [
      {
        turnId: "turn-1",
        prompt,
        mode: "build",
        status: "running",
        attempts: [],
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      },
    ],
  });

test("toAttemptExecutionResult maps worker result to Phase 3 shape", () => {
  const spec = makeSpec("session-map-test");
  const execution: TaskExecutionRecord = {
    events: [],
    result: { ...baseWorkerResult("session-map-test"), artifacts: ["stdout"] },
    workerErrors: [],
    rawOutput: "",
    ok: true,
  };
  const result = toAttemptExecutionResult(spec, execution);
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.attemptId, "attempt-1");
  assert.equal(result.taskKind, "assistant_job");
  assert.equal(result.status, "succeeded");
  assert.equal(result.durationMs, 1000);
  assert.deepEqual(result.artifacts, ["stdout"]);
});

test("toAttemptExecutionResult maps failed status", () => {
  const spec = makeSpec("session-fail");
  const execution: TaskExecutionRecord = {
    events: [],
    result: {
      ...baseWorkerResult("session-fail"),
      status: "failed" as const,
      summary: "command exited with code 1",
      exitCode: 1,
      durationMs: 100,
    },
    workerErrors: [],
    rawOutput: "",
    ok: false,
  };
  const result = toAttemptExecutionResult(spec, execution);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 1);
});

test("executeAttempt: lifecycle envelopes emitted in correct sequence", async () => {
  const rootDir = await createTempRoot();
  try {
    const captured: SessionEventEnvelope[] = [];
    const writerFactory = (): EventLogWriter => ({
      ...nopWriter(),
      append: async (env: SessionEventEnvelope) => {
        captured.push(env);
      },
    });
    const sessionId = "session-attempt-test";
    const sessionStore = new SessionStore(rootDir);
    const artifactStore = new ArtifactStore(rootDir);
    await seedSession(sessionStore, sessionId, "attempt-test");

    const { reviewed, executionResult } = await executeAttempt({
      sessionStore,
      artifactStore,
      runner: stubRunner(sessionId),
      sessionId,
      turnId: "turn-1",
      spec: makeSpec(sessionId),
      args: baseArgs(rootDir),
      eventLogWriterFactory: writerFactory,
    });
    assert.equal(reviewed.outcome, "success");
    assert.equal(executionResult.schemaVersion, 3);
    assert.equal(executionResult.status, "succeeded");
    // Phase 4 PR2 added provenance_started (after dispatch_started) and
    // provenance_finalized (before review_started), extending the lifecycle
    // envelope sequence from 6 to 8.
    assert.equal(captured.length, 8);
    assert.equal(captured[0]!.kind, "host.dispatch_started");
    assert.equal(captured[1]!.kind, "host.provenance_started");
    assert.equal(
      captured.some((env) => env.kind === "host.provenance_finalized"),
      true,
    );
    assert.equal(captured[captured.length - 1]!.kind, "host.review_completed");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("executeAttempt: attemptSpec persisted on attempt record", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-spec-persist";
    const sessionStore = new SessionStore(rootDir);
    await seedSession(sessionStore, sessionId, "spec-persist");

    await executeAttempt({
      sessionStore,
      artifactStore: new ArtifactStore(rootDir),
      runner: stubRunner(sessionId),
      sessionId,
      turnId: "turn-1",
      spec: makeSpec(sessionId),
      args: baseArgs(rootDir),
      eventLogWriterFactory: () => nopWriter(),
    });
    const session = await sessionStore.loadSession(sessionId);
    assert.ok(session);
    const attempt = session.turns[0]!.attempts[0];
    assert.ok(attempt?.attemptSpec);
    assert.equal(attempt.attemptSpec.intentId, "intent-123");
    assert.equal(attempt.attemptSpec.taskKind, "assistant_job");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("executeAttempt: review record includes intentId", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-intent-review";
    const sessionStore = new SessionStore(rootDir);
    await seedSession(sessionStore, sessionId, "intent-review");

    await executeAttempt({
      sessionStore,
      artifactStore: new ArtifactStore(rootDir),
      runner: stubRunner(sessionId),
      sessionId,
      turnId: "turn-1",
      spec: makeSpec(sessionId, { intentId: "intent-xyz" }),
      args: baseArgs(rootDir),
      eventLogWriterFactory: () => nopWriter(),
    });
    const session = await sessionStore.loadSession(sessionId);
    assert.ok(session);
    const review = session.turns[0]!.latestReview;
    assert.ok(review);
    assert.equal(review.intentId, "intent-xyz");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
