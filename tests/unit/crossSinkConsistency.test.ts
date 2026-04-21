import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import type {
  ABoxTaskRunner,
  TaskExecutionRecord,
  TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type SessionEventEnvelope } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
import type { EventLogWriter } from "../../src/host/eventLogWriter.js";
import type { HostCliArgs } from "../../src/host/parsing.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-crosssink-"));

const buildAttemptSpec = (sessionId: string, prompt: string): AttemptSpec => ({
  schemaVersion: 3,
  sessionId,
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "attempt-1",
  intentId: "intent-1",
  mode: "plan",
  taskKind: "assistant_job",
  prompt,
  instructions: [],
  cwd: ".",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 60, maxOutputBytes: 1024, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
});

/**
 * Build a stub ABoxTaskRunner that emits exactly `N` task.progress events
 * bracketed by a task.started and task.completed pair.
 */
const stubRunnerEmitting = (
  sessionId: string,
  n: number,
): { runner: ABoxTaskRunner; emittedEvents: WorkerTaskProgressEvent[] } => {
  const base: WorkerTaskProgressEvent = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    kind: "task.progress",
    taskId: "attempt-1",
    sessionId,
    status: "running",
    timestamp: "2026-04-15T00:00:00.500Z",
  };
  const emittedEvents: WorkerTaskProgressEvent[] = [
    { ...base, kind: "task.started", status: "running" },
    ...Array.from({ length: n }, (_, i) => ({
      ...base,
      kind: "task.progress" as const,
      message: `step ${i}`,
    })),
    { ...base, kind: "task.completed", status: "succeeded" },
  ];
  const execution: TaskExecutionRecord = {
    events: emittedEvents,
    result: {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      taskId: "attempt-1",
      sessionId,
      status: "succeeded",
      summary: "ok",
      finishedAt: "2026-04-15T00:00:01.000Z",
      exitCode: 0,
      command: "echo",
      cwd: ".",
      shell: "bash",
      timeoutSeconds: 60,
      durationMs: 10,
      exitSignal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      assumeDangerousSkipPermissions: false,
    },
    workerErrors: [],
    rawOutput: "",
    ok: true,
    metadata: { cmd: ["abox", "run"], taskId: "abox-task-1" },
  };
  const runner = {
    runAttempt: async (
      _spec: AttemptSpec,
      _overrides: Record<string, unknown>,
      handlers: TaskRunnerHandlers = {},
    ): Promise<TaskExecutionRecord> => {
      for (const event of emittedEvents) {
        handlers.onEvent?.(event);
      }
      return execution;
    },
  } as unknown as ABoxTaskRunner;
  return { runner, emittedEvents };
};

const baseArgs: HostCliArgs = {
  command: "run",
  config: "config/default.json",
  aboxBin: "abox",
  mode: "plan",
  yes: false,
  shell: "bash",
  timeoutSeconds: 60,
  maxOutputBytes: 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  copilot: {},
};

/**
 * Create a mock EventLogWriter factory that captures every envelope appended
 * through the scoped writer into an in-memory list.
 */
const createCapturingWriterFactory = () => {
  const captured: SessionEventEnvelope[] = [];
  const factory = (_storageRoot: string, _sessionId: string): EventLogWriter => ({
    append: async (envelope: SessionEventEnvelope): Promise<void> => {
      captured.push(envelope);
    },
    flush: async () => {},
    close: async () => {},
    getDroppedBatchCount: () => 0,
    getFilePath: () => "/dev/null",
  });
  return { factory, captured };
};

test("cross-sink: writer.append and coalescer.onProgress see matching raw event counts", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-xsink";
    const N = 7;
    const sessionStore = new SessionStore(rootDir);
    const artifactStore = new ArtifactStore(rootDir);

    await sessionStore.createSession({
      sessionId,
      goal: "cross-sink",
      repoRoot: ".",
      status: "running",
      turns: [
        {
          turnId: "turn-1",
          prompt: "cross-sink",
          mode: "plan",
          status: "running",
          attempts: [],
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    });

    const { runner, emittedEvents } = stubRunnerEmitting(sessionId, N);
    const { factory, captured } = createCapturingWriterFactory();

    // Parallel sink: coalescer-style onProgress counter.
    const progressEvents: WorkerTaskProgressEvent[] = [];
    const onProgress = (event: WorkerTaskProgressEvent): void => {
      progressEvents.push(event);
    };

    await executeAttempt({
      sessionStore,
      artifactStore,
      runner,
      sessionId,
      turnId: "turn-1",
      spec: buildAttemptSpec(sessionId, "cross-sink"),
      args: { ...baseArgs, storageRoot: rootDir },
      eventLogWriterFactory: factory,
      onProgress,
    });

    // --- Assertions ---

    // onProgress receives exactly the raw worker events the runner emitted.
    assert.equal(
      progressEvents.length,
      emittedEvents.length,
      "onProgress count matches runner events",
    );

    // The scoped writer receives:
    //   1 host.dispatch_started
    //   1 host.provenance_started
    //   N+2 projected worker envelopes (started + N progress + completed)
    //   1 host.provenance_finalized
    //   1 host.review_started
    //   1 host.review_completed
    // = N+7 total through the scoped writer.
    const expectedWriterCount = N + 7;
    assert.equal(captured.length, expectedWriterCount, "writer.append count matches expected");

    // Raw worker event envelopes projected through the writer:
    const workerEnvelopes = captured.filter((e) => e.kind.startsWith("worker."));
    assert.equal(
      workerEnvelopes.length,
      emittedEvents.length,
      "projected worker envelopes match raw event count",
    );

    // The coalescer onProgress count must exactly equal the worker envelope
    // count in the writer — this is the cross-sink consistency assertion.
    assert.equal(
      progressEvents.length,
      workerEnvelopes.length,
      "cross-sink: onProgress count equals writer worker-envelope count",
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("cross-sink: zero-progress run still emits lifecycle envelopes", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-xsink-zero";
    const sessionStore = new SessionStore(rootDir);
    const artifactStore = new ArtifactStore(rootDir);

    await sessionStore.createSession({
      sessionId,
      goal: "zero",
      repoRoot: ".",
      status: "running",
      turns: [
        {
          turnId: "turn-1",
          prompt: "zero",
          mode: "plan",
          status: "running",
          attempts: [],
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    });

    const { runner } = stubRunnerEmitting(sessionId, 0);
    const { factory, captured } = createCapturingWriterFactory();
    const progressCount: number[] = [];

    await executeAttempt({
      sessionStore,
      artifactStore,
      runner,
      sessionId,
      turnId: "turn-1",
      spec: buildAttemptSpec(sessionId, "zero"),
      args: { ...baseArgs, storageRoot: rootDir },
      eventLogWriterFactory: factory,
      onProgress: () => {
        progressCount.push(1);
      },
    });

    // 2 worker envelopes, 1 dispatch, 2 provenance, 2 review = 7.
    assert.equal(captured.length, 7);
    // Coalescer sees started + completed = 2.
    assert.equal(progressCount.length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
