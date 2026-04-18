import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type SessionEventEnvelope } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import type { DialogDispatcher } from "../../src/host/dialogLauncher.js";
import type { EventLogWriter } from "../../src/host/eventLogWriter.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import type {
  ABoxTaskRunner,
  TaskExecutionRecord,
  TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";

/**
 * Phase 4 PR7 — when the approval dialog resolves to `deny` (or when the
 * producer otherwise blocks), `executeAttempt` MUST NOT call the runner.
 * The turn surfaces a `"blocked"` status with the rationale attached.
 */

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-deny-"));

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

const makeDenySpec = (sessionId: string, repoRoot: string): AttemptSpec => ({
  schemaVersion: 3,
  sessionId,
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "explicit_command",
  prompt: "/run-command rm -rf /",
  instructions: ["User prompt: /run-command rm -rf /"],
  cwd: repoRoot,
  execution: { engine: "shell", command: ["bash", "-lc", "rm -rf /"] },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 60, maxOutputBytes: 10_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-0", label: "noop" }],
  artifactRequests: [{ name: "result.json", kind: "result", required: true }],
});

const captureWriter = (captured: SessionEventEnvelope[]): EventLogWriter => ({
  append: async (env) => {
    captured.push(env);
  },
  flush: async () => {},
  close: async () => {},
  getDroppedBatchCount: () => 0,
  getFilePath: () => "/dev/null",
});

const fakeDispatcher = (): DialogDispatcher => {
  let state: HostAppState = initialHostAppState();
  return { getState: () => state, setState: (next) => (state = next) };
};

/** Runner that throws if called — the test asserts the producer skipped it. */
const exploderRunner = (): ABoxTaskRunner => {
  const handler = async (
    _s: unknown,
    _o: unknown,
    _handlers: TaskRunnerHandlers = {},
  ): Promise<TaskExecutionRecord> => {
    throw new Error("runner.runAttempt must NOT be called on a blocked dispatch");
  };
  return { runTask: handler, runAttempt: handler } as unknown as ABoxTaskRunner;
};

const seedSession = async (store: SessionStore, sessionId: string, repoRoot: string) =>
  store.createSession({
    sessionId,
    goal: "deny-short-circuit",
    repoRoot,
    assumeDangerousSkipPermissions: false,
    status: "running",
    turns: [
      {
        turnId: "turn-1",
        prompt: "rm",
        mode: "build",
        status: "running",
        attempts: [],
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      },
    ],
  });

test("executeAttempt: dialog deny short-circuits — runner never invoked", async () => {
  const root = await createTempRoot();
  try {
    const sessionId = "session-deny-dialog";
    const sessionStore = new SessionStore(root);
    const artifactStore = new ArtifactStore(root);
    await seedSession(sessionStore, sessionId, root);

    const spec = makeDenySpec(sessionId, root);
    const captured: SessionEventEnvelope[] = [];

    const { reviewed, executionResult } = await executeAttempt({
      sessionStore,
      artifactStore,
      runner: exploderRunner(),
      sessionId,
      turnId: "turn-1",
      spec,
      args: baseArgs(root),
      eventLogWriterFactory: () => captureWriter(captured),
      repoRoot: root,
      approvalDispatcher: fakeDispatcher(),
      approvalOverride: async () => ({ status: "blocked", rationale: "User chose [3] deny" }),
    });

    assert.equal(reviewed.outcome, "policy_denied");
    assert.equal(reviewed.action, "halt");
    assert.equal(reviewed.reason, "User chose [3] deny");
    assert.equal(executionResult.status, "blocked");
    assert.equal(executionResult.exitCode, null);

    // `host.dispatch_started` must NOT have been emitted — the producer
    // short-circuited above it.
    const kinds = captured.map((env) => env.kind);
    assert.ok(!kinds.includes("host.dispatch_started"));
    assert.ok(!kinds.includes("worker.attempt_started"));

    // Turn-level attempt record carries the blocked status.
    const session = await sessionStore.loadSession(sessionId);
    const attempt = session?.turns[0]?.attempts.find((a) => a.attemptId === "attempt-1");
    assert.ok(attempt);
    assert.equal(attempt.status, "blocked");
    assert.match(attempt.lastMessage ?? "", /deny/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executeAttempt: producer block rationale carries into the review reason", async () => {
  const root = await createTempRoot();
  try {
    const sessionId = "session-deny-rationale";
    const sessionStore = new SessionStore(root);
    const artifactStore = new ArtifactStore(root);
    await seedSession(sessionStore, sessionId, root);

    const spec = makeDenySpec(sessionId, root);
    const captured: SessionEventEnvelope[] = [];

    const { reviewed } = await executeAttempt({
      sessionStore,
      artifactStore,
      runner: exploderRunner(),
      sessionId,
      turnId: "turn-1",
      spec,
      args: baseArgs(root),
      eventLogWriterFactory: () => captureWriter(captured),
      repoRoot: root,
      approvalDispatcher: fakeDispatcher(),
      approvalOverride: async () => ({
        status: "blocked",
        rationale: "blocked by deny rule rule-abc",
      }),
    });

    assert.match(reviewed.reason, /blocked by deny rule/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executeAttempt: absence of approvalDispatcher leaves existing non-interactive flow intact", async () => {
  const root = await createTempRoot();
  try {
    const sessionId = "session-no-dispatcher";
    const sessionStore = new SessionStore(root);
    const artifactStore = new ArtifactStore(root);
    await seedSession(sessionStore, sessionId, root);

    // Minimal runner that succeeds — proves the flow runs without approval.
    const ok = async (
      _s: unknown,
      _o: unknown,
      _handlers: TaskRunnerHandlers = {},
    ): Promise<TaskExecutionRecord> => ({
      events: [],
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
      metadata: { cmd: ["abox"], taskId: "abox-1" },
    });
    const runner = { runTask: ok, runAttempt: ok } as unknown as ABoxTaskRunner;

    const spec = makeDenySpec(sessionId, root);
    const captured: SessionEventEnvelope[] = [];

    const { reviewed } = await executeAttempt({
      sessionStore,
      artifactStore,
      runner,
      sessionId,
      turnId: "turn-1",
      spec,
      args: baseArgs(root),
      eventLogWriterFactory: () => captureWriter(captured),
      // No approvalDispatcher — the legacy path runs.
    });

    assert.equal(reviewed.outcome, "success");
    const kinds = captured.map((env) => env.kind);
    assert.ok(kinds.includes("host.dispatch_started"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
