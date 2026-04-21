import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ABoxTaskRunner,
  type TaskExecutionRecord,
  type TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type SessionEventEnvelope } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";
import type { EventLogWriter } from "../../src/host/eventLogWriter.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { listSessionProvenance, loadProvenance } from "../../src/host/provenance.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-eap-"));

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
  intentId: "intent-p2",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "test provenance",
  instructions: ["User prompt: test provenance"],
  cwd: "/tmp/repo",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 300, maxOutputBytes: 10_000_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-0", label: "changes made" }],
  artifactRequests: [{ name: "result.json", kind: "result", required: true }],
  ...overrides,
});

const stubRunner = (sessionId: string): ABoxTaskRunner => {
  const events: WorkerTaskProgressEvent[] = [
    {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      kind: "task.started",
      taskId: "task-1",
      sessionId,
      status: "running",
      timestamp: "2026-04-15T00:00:00.500Z",
    },
    {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      kind: "task.completed",
      taskId: "task-1",
      sessionId,
      status: "succeeded",
      timestamp: "2026-04-15T00:00:01.000Z",
    },
  ];
  const execution: TaskExecutionRecord = {
    events,
    result: {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      taskId: "task-1",
      sessionId,
      status: "succeeded",
      summary: "ok",
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
    },
    workerErrors: [],
    rawOutput: "",
    ok: true,
    metadata: { cmd: ["abox", "run", "--task", "xyz"], taskId: "sandbox-task-xyz" },
  };
  const handler = async (
    _s: unknown,
    _o: unknown,
    hs: TaskRunnerHandlers = {},
  ): Promise<TaskExecutionRecord> => {
    for (const e of events) hs.onEvent?.(e);
    return execution;
  };
  return { runTask: handler, runAttempt: handler } as unknown as ABoxTaskRunner;
};

const seedSession = async (store: SessionStore, sessionId: string, prompt: string) =>
  store.createSession({
    sessionId,
    goal: prompt,
    repoRoot: "/tmp",
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

const captureWriterFactory = (captured: SessionEventEnvelope[]) => (): EventLogWriter => ({
  append: async (env: SessionEventEnvelope) => {
    captured.push(env);
  },
  flush: async () => {},
  close: async () => {},
  getDroppedBatchCount: () => 0,
  getFilePath: () => "/dev/null",
});

// ---------------------------------------------------------------------------

test("executeAttempt emits provenance_started after dispatch_started", async () => {
  const root = await createTempRoot();
  try {
    const captured: SessionEventEnvelope[] = [];
    const store = new SessionStore(root);
    await seedSession(store, "session-ap1", "test");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ap1"),
      sessionId: "session-ap1",
      turnId: "turn-1",
      spec: makeSpec("session-ap1"),
      args: baseArgs(root),
      eventLogWriterFactory: captureWriterFactory(captured),
    });
    const dispatchIdx = captured.findIndex((e) => e.kind === "host.dispatch_started");
    const provStartIdx = captured.findIndex((e) => e.kind === "host.provenance_started");
    assert.ok(dispatchIdx >= 0 && provStartIdx > dispatchIdx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executeAttempt emits provenance_finalized after the worker terminal event", async () => {
  const root = await createTempRoot();
  try {
    const captured: SessionEventEnvelope[] = [];
    const store = new SessionStore(root);
    await seedSession(store, "session-ap2", "test");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ap2"),
      sessionId: "session-ap2",
      turnId: "turn-1",
      spec: makeSpec("session-ap2"),
      args: baseArgs(root),
      eventLogWriterFactory: captureWriterFactory(captured),
    });
    const completedIdx = captured.findIndex((e) => e.kind === "worker.attempt_completed");
    const provFinalIdx = captured.findIndex((e) => e.kind === "host.provenance_finalized");
    assert.ok(completedIdx >= 0);
    assert.ok(provFinalIdx >= 0);
    assert.ok(provFinalIdx > completedIdx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provenance_started payload carries provenanceId + attemptId + empty initial dispatchCommand", async () => {
  const root = await createTempRoot();
  try {
    const captured: SessionEventEnvelope[] = [];
    const store = new SessionStore(root);
    await seedSession(store, "session-ap3", "test");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ap3"),
      sessionId: "session-ap3",
      turnId: "turn-1",
      spec: makeSpec("session-ap3"),
      args: baseArgs(root),
      eventLogWriterFactory: captureWriterFactory(captured),
    });
    const started = captured.find((e) => e.kind === "host.provenance_started");
    assert.ok(started);
    const payload = started.payload as {
      provenanceId: string;
      attemptId: string;
      dispatchCommand: string[];
    };
    assert.ok(payload.provenanceId.startsWith("provenance-"));
    assert.equal(payload.attemptId, "attempt-1");
    assert.deepEqual(payload.dispatchCommand, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provenance_finalized payload carries exitCode + elapsedMs + shared provenanceId", async () => {
  const root = await createTempRoot();
  try {
    const captured: SessionEventEnvelope[] = [];
    const store = new SessionStore(root);
    await seedSession(store, "session-ap4", "test");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ap4"),
      sessionId: "session-ap4",
      turnId: "turn-1",
      spec: makeSpec("session-ap4"),
      args: baseArgs(root),
      eventLogWriterFactory: captureWriterFactory(captured),
    });
    const started = captured.find((e) => e.kind === "host.provenance_started");
    const finalized = captured.find((e) => e.kind === "host.provenance_finalized");
    assert.ok(started && finalized);
    const startId = (started.payload as { provenanceId: string }).provenanceId;
    const finalizeId = (finalized.payload as { provenanceId: string }).provenanceId;
    assert.equal(startId, finalizeId, "start and finalize share the same provenanceId");
    const payload = finalized.payload as {
      exitCode: number | null;
      elapsedMs: number;
      timedOut: boolean;
    };
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.elapsedMs, 1000);
    assert.equal(payload.timedOut, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted provenance record reflects finalized state (last-write-wins)", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root);
    await seedSession(store, "session-ap5", "test");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ap5"),
      sessionId: "session-ap5",
      turnId: "turn-1",
      spec: makeSpec("session-ap5"),
      args: baseArgs(root),
    });
    const rec = await loadProvenance(root, "session-ap5", "attempt-1");
    assert.ok(rec);
    assert.deepEqual(rec.dispatchCommand, ["abox", "run", "--task", "xyz"]);
    assert.equal(rec.sandboxTaskId, "sandbox-task-xyz");
    assert.equal(rec.exit?.exitCode, 0);
    assert.equal(rec.composerMode, "standard");
    assert.equal(rec.taskMode, "build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("autopilot spec persists composerMode=autopilot on the record", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root);
    await seedSession(store, "session-ap6", "test");
    const spec = makeSpec("session-ap6", {
      permissions: { rules: [], allowAllTools: true, noAskUser: true },
    });
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ap6"),
      sessionId: "session-ap6",
      turnId: "turn-1",
      spec,
      args: baseArgs(root),
    });
    const rec = await loadProvenance(root, "session-ap6", "attempt-1");
    assert.equal(rec?.composerMode, "autopilot");
    assert.equal(rec?.agentProfile.autopilot, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listSessionProvenance returns one folded record per attempt after execution", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root);
    await seedSession(store, "session-ap7", "test");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ap7"),
      sessionId: "session-ap7",
      turnId: "turn-1",
      spec: makeSpec("session-ap7"),
      args: baseArgs(root),
    });
    const all = await listSessionProvenance(root, "session-ap7");
    assert.equal(all.length, 1);
    assert.ok(all[0]?.finishedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
