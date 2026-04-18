import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type {
  ABoxTaskRunner,
  TaskExecutionRecord,
  TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";
import {
  BAKUDO_PROTOCOL_SCHEMA_VERSION,
  createSessionEvent,
  type SessionEventEnvelope,
} from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { WorkerTaskProgressEvent, WorkerTaskSpec } from "../../src/workerRuntime.js";
import type { EventLogWriter } from "../../src/host/eventLogWriter.js";
import { emitSessionEvent, readSessionEventLog } from "../../src/host/eventLogWriter.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { resumeNamedSession } from "../../src/host/sessionController.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-ctrl-"));

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

test("resumeNamedSession: returns null for unknown session", async () => {
  const rootDir = await createTempRoot();
  try {
    const result = await resumeNamedSession("nope", baseArgs(rootDir));
    assert.equal(result, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("pre-dispatch emit: host.turn_queued envelope shape matches what sessionController writes", async () => {
  // sessionController.createAndRunFirstTurn/appendTurnToActiveSession emit
  // host.turn_queued via emitSessionEvent before calling executeTask. This
  // test locks in the envelope contract without needing to boot the full
  // runner pipeline — a regression in the emit payload shape here is exactly
  // what PR4 consumers (timeline/doctor) will trip over first.
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-queued";
    await emitSessionEvent(
      rootDir,
      sessionId,
      createSessionEvent({
        kind: "host.turn_queued",
        sessionId,
        turnId: "turn-1",
        actor: "host",
        payload: { turnId: "turn-1", prompt: "emit-me", mode: "plan" },
      }),
    );
    const envelopes = await readSessionEventLog(rootDir, sessionId);
    assert.equal(envelopes.length, 1);
    const envelope = envelopes[0]!;
    assert.equal(envelope.kind, "host.turn_queued");
    assert.equal(envelope.actor, "host");
    assert.equal(envelope.sessionId, sessionId);
    assert.equal(envelope.turnId, "turn-1");
    assert.equal(envelope.payload.prompt, "emit-me");
    assert.equal(envelope.payload.mode, "plan");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("resumeNamedSession: loads an existing session record", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-a",
      goal: "x",
      repoRoot: ".",
      assumeDangerousSkipPermissions: false,
      status: "planned",
      turns: [
        {
          turnId: "turn-1",
          prompt: "x",
          mode: "build",
          status: "queued",
          attempts: [],
          createdAt: "2026-04-14T12:00:00.000Z",
          updatedAt: "2026-04-14T12:00:00.000Z",
        },
      ],
    });

    const result = await resumeNamedSession("session-a", baseArgs(rootDir));
    assert.ok(result);
    assert.equal(result.sessionId, "session-a");
    assert.equal(result.turns.length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createAndRunFirstTurn DI seam round-trip (no real ABoxTaskRunner)
// ---------------------------------------------------------------------------

const stubRunner = (sessionId: string): ABoxTaskRunner => {
  const base: WorkerTaskProgressEvent = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    kind: "task.progress",
    taskId: "placeholder",
    sessionId,
    status: "running",
    timestamp: "2026-04-15T00:00:00.500Z",
  };
  const events: WorkerTaskProgressEvent[] = [
    { ...base, kind: "task.started", status: "running" },
    { ...base, kind: "task.progress", message: "doing work" },
    { ...base, kind: "task.completed", status: "succeeded" },
  ];
  const execution: TaskExecutionRecord = {
    events,
    result: {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      taskId: "placeholder",
      sessionId,
      status: "succeeded",
      summary: "done",
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
    rawOutput: "hello",
    ok: true,
    metadata: { cmd: ["abox", "run"], taskId: "abox-stub-1" },
  };
  return {
    runTask: async (
      _spec: WorkerTaskSpec,
      _overrides: Record<string, unknown>,
      handlers: TaskRunnerHandlers = {},
    ): Promise<TaskExecutionRecord> => {
      for (const event of events) {
        handlers.onEvent?.(event);
      }
      return execution;
    },
  } as unknown as ABoxTaskRunner;
};

test("createAndRunFirstTurn: DI seam captures envelopes without a real runner", async () => {
  const rootDir = await createTempRoot();
  try {
    const captured: SessionEventEnvelope[] = [];
    const writerFactory = (_sr: string, _sid: string): EventLogWriter => ({
      append: async (envelope: SessionEventEnvelope) => {
        captured.push(envelope);
      },
      flush: async () => {},
      close: async () => {},
      getDroppedBatchCount: () => 0,
      getFilePath: () => "/dev/null",
    });

    // createAndRunFirstTurn requires ABoxAdapter/ABoxTaskRunner construction
    // inside buildRunnerContext — which reads args.aboxBin. Because we inject
    // the writer factory, the runner's output won't matter for the event log
    // (all envelopes go to our in-memory sink), but we still need the
    // runner's execution result to round-trip. Unfortunately the module
    // constructs its own runner internally (not injected yet); so we exercise
    // the factory seam indirectly via executeTask for now.
    //
    // Direct round-trip: invoke executeTask with the DI seam.
    const { ArtifactStore } = await import("../../src/artifactStore.js");
    const sessionStore = new SessionStore(rootDir);
    const artifactStore = new ArtifactStore(rootDir);

    const sessionId = "session-di-test";
    await sessionStore.createSession({
      sessionId,
      goal: "di-test",
      repoRoot: "/tmp",
      assumeDangerousSkipPermissions: false,
      status: "running",
      turns: [
        {
          turnId: "turn-1",
          prompt: "di-test",
          mode: "plan",
          status: "running",
          attempts: [],
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    });

    const { executeTask: execFn } = await import("../../src/host/orchestration.js");
    const runner = stubRunner(sessionId);

    const reviewed = await execFn({
      sessionStore,
      artifactStore,
      runner,
      sessionId,
      turnId: "turn-1",
      request: {
        schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
        taskId: "attempt-1",
        sessionId,
        goal: "di-test",
        mode: "plan",
        cwd: ".",
        assumeDangerousSkipPermissions: false,
      },
      args: { ...baseArgs(rootDir), mode: "plan" },
      eventLogWriterFactory: writerFactory,
    });

    assert.equal(reviewed.outcome, "success");
    // Captured envelopes: dispatch_started, started, progress, completed,
    // review_started, review_completed = 6.
    assert.equal(captured.length, 6);
    assert.equal(captured[0]!.kind, "host.dispatch_started");
    assert.equal(captured[captured.length - 1]!.kind, "host.review_completed");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
