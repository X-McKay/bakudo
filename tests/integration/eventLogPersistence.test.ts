import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import type {
  ABoxTaskRunner,
  TaskExecutionRecord,
  TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import { SessionStore } from "../../src/sessionStore.js";
import {
  BAKUDO_PROTOCOL_SCHEMA_VERSION,
  createSessionEvent,
  type SessionEventEnvelope,
  type SessionEventKind,
} from "../../src/protocol.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import {
  createSessionEventLogWriter,
  eventLogFilePath,
  eventLogLegacyPath,
  readSessionEventLog,
} from "../../src/host/eventLogWriter.js";
import { loadEventLog } from "../../src/host/timeline.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-eventlog-int-"));

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

test("appending N envelopes round-trips through readSessionEventLog", async () => {
  const rootDir = await createTempRoot();
  try {
    const writer = createSessionEventLogWriter(rootDir, "session-rt");
    for (let i = 0; i < 10; i += 1) {
      await writer.append(
        createSessionEvent({
          kind: "worker.attempt_progress",
          sessionId: "session-rt",
          turnId: "turn-1",
          attemptId: "attempt-1",
          actor: "worker",
          payload: { attemptId: "attempt-1", status: "running", message: `n=${i}` },
        }),
      );
    }
    await writer.close();
    const envelopes = await readSessionEventLog(rootDir, "session-rt");
    assert.equal(envelopes.length, 10);
    assert.equal(envelopes[0]?.payload.message, "n=0");
    assert.equal(envelopes[9]?.payload.message, "n=9");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("legacy events.ndjson is renamed to events.v1.ndjson on first v2 write", async () => {
  const rootDir = await createTempRoot();
  try {
    const filePath = eventLogFilePath(rootDir, "session-legacy");
    const legacyPath = eventLogLegacyPath(rootDir, "session-legacy");
    await mkdir(dirname(filePath), { recursive: true });
    const legacyLine = JSON.stringify({
      schemaVersion: 1,
      kind: "task.progress",
      taskId: "t1",
      sessionId: "session-legacy",
      status: "running",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(filePath, `${legacyLine}\n`, "utf8");

    const writer = createSessionEventLogWriter(rootDir, "session-legacy");
    await writer.append(
      createSessionEvent({
        kind: "host.dispatch_started",
        sessionId: "session-legacy",
        turnId: "turn-1",
        attemptId: "attempt-1",
        actor: "host",
        payload: {
          attemptId: "attempt-1",
          goal: "goal",
          mode: "plan",
          assumeDangerousSkipPermissions: false,
        },
      }),
    );
    await writer.close();

    const renamed = await readFile(legacyPath, "utf8");
    assert.ok(renamed.includes('"schemaVersion":1'));

    const fresh = await readFile(filePath, "utf8");
    const lines = fresh.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { schemaVersion: number; kind: string };
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.kind, "host.dispatch_started");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadEventLog reports malformedLineCount separately from parsed envelopes", async () => {
  const rootDir = await createTempRoot();
  try {
    const writer = createSessionEventLogWriter(rootDir, "session-corrupt");
    for (let i = 0; i < 3; i += 1) {
      await writer.append(
        createSessionEvent({
          kind: "worker.attempt_progress",
          sessionId: "session-corrupt",
          actor: "worker",
          payload: { attemptId: "attempt-1", status: "running", message: `i=${i}` },
        }),
      );
    }
    await writer.close();

    const filePath = eventLogFilePath(rootDir, "session-corrupt");
    const content = await readFile(filePath, "utf8");
    await writeFile(filePath, `${content}{ not-json\n`, "utf8");

    const loaded = await loadEventLog(rootDir, "session-corrupt");
    assert.equal(loaded.envelopes.length, 3);
    assert.equal(loaded.malformedLineCount, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadEventLog returns empty state when the log file is absent", async () => {
  const rootDir = await createTempRoot();
  try {
    const loaded = await loadEventLog(rootDir, "session-missing");
    assert.deepEqual(loaded, { envelopes: [], malformedLineCount: 0 });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

const stubRunnerEmitting = (events: WorkerTaskProgressEvent[]): ABoxTaskRunner => {
  const execution: TaskExecutionRecord = {
    events,
    result: {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      taskId: "attempt-1",
      sessionId: "session-exec",
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
  return {
    runAttempt: async (
      _spec: AttemptSpec,
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

test("executeAttempt round-trip writes the expected envelope sequence", async () => {
  const rootDir = await createTempRoot();
  try {
    const sessionId = "session-exec";
    const sessionStore = new SessionStore(rootDir);
    const artifactStore = new ArtifactStore(rootDir);
    await sessionStore.createSession({
      sessionId,
      goal: "exec-goal",
      repoRoot: ".",
      assumeDangerousSkipPermissions: false,
      status: "running",
      turns: [
        {
          turnId: "turn-1",
          prompt: "exec-goal",
          mode: "plan",
          status: "running",
          attempts: [],
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    });

    const baseProgress: WorkerTaskProgressEvent = {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      kind: "task.progress",
      taskId: "attempt-1",
      sessionId,
      status: "running",
      timestamp: "2026-04-15T00:00:00.500Z",
    };
    const events: WorkerTaskProgressEvent[] = [
      { ...baseProgress, kind: "task.started", status: "running" },
      { ...baseProgress, kind: "task.progress", message: "step 1" },
      { ...baseProgress, kind: "task.progress", message: "step 2" },
      { ...baseProgress, kind: "task.progress", message: "step 3" },
      { ...baseProgress, kind: "task.completed", status: "succeeded" },
    ];
    const runner = stubRunnerEmitting(events);

    const args: HostCliArgs = {
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
      storageRoot: rootDir,
      copilot: {},
    };

    await executeAttempt({
      sessionStore,
      artifactStore,
      runner,
      sessionId,
      turnId: "turn-1",
      spec: buildAttemptSpec(sessionId, "exec-goal"),
      args,
    });

    const envelopes: SessionEventEnvelope[] = await readSessionEventLog(rootDir, sessionId);
    const kinds = envelopes.map((envelope) => envelope.kind);
    // Artifact-registered envelopes are interleaved after the executeAttempt
    // lifecycle finishes (three per run: result, worker-output, dispatch).
    // Check the prefix ordering, then the trailing artifact block.
    const expectedPrefix: SessionEventKind[] = [
      "host.dispatch_started",
      "host.provenance_started",
      "worker.attempt_started",
      "worker.attempt_progress",
      "worker.attempt_progress",
      "worker.attempt_progress",
      "worker.attempt_completed",
      "host.provenance_finalized",
      "host.review_started",
      "host.review_completed",
    ];
    assert.deepEqual(kinds.slice(0, expectedPrefix.length), expectedPrefix);

    const artifactEnvelopes = envelopes.filter(
      (envelope) => envelope.kind === "host.artifact_registered",
    );
    assert.equal(artifactEnvelopes.length, 3);
    const artifactKindsSeen = artifactEnvelopes.map((envelope) => envelope.payload.kind);
    assert.deepEqual(artifactKindsSeen.sort(), ["dispatch", "log", "result"]);
    for (const envelope of artifactEnvelopes) {
      assert.equal(envelope.turnId, "turn-1");
      assert.equal(envelope.attemptId, "attempt-1");
      assert.equal(typeof envelope.payload.artifactId, "string");
      assert.match(envelope.payload.artifactId as string, /^artifact-\d+-[0-9a-f]{8}$/u);
      assert.equal(typeof envelope.payload.path, "string");
    }

    // Every envelope must carry v2 schemaVersion and the expected actor.
    for (const envelope of envelopes) {
      assert.equal(envelope.schemaVersion, 2);
      if (envelope.kind.startsWith("worker.")) {
        assert.equal(envelope.actor, "worker");
      } else if (envelope.kind.startsWith("host.")) {
        assert.equal(envelope.actor, "host");
      }
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
