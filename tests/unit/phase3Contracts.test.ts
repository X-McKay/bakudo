import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hydratePermissionRule,
  type AttemptExecutionResult,
  type AttemptSpec,
  type PermissionRule,
} from "../../src/attemptProtocol.js";
import { BakudoConfigDefaults } from "../../src/host/config.js";
import { evaluatePermission } from "../../src/host/permissionEvaluator.js";
import { planAttempt } from "../../src/host/planner.js";
import { reviewAttemptResult } from "../../src/reviewer.js";
import {
  type ABoxTaskRunner,
  type TaskExecutionRecord,
  type TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";
import type { EventLogWriter } from "../../src/host/eventLogWriter.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";

// -- Shared helpers ----------------------------------------------------------

const CTX = {
  sessionId: "session-phase3",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  repoRoot: "/tmp/repo",
  config: BakudoConfigDefaults,
};

const plan = (prompt: string, mode: "standard" | "plan" | "autopilot", opts = {}) =>
  planAttempt(prompt, mode, CTX, opts);

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-p3-"));

const baseArgs = (root: string): HostCliArgs => ({
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
  storageRoot: root,
  copilot: {},
});

const makeSpec = (sid: string, ov?: Partial<AttemptSpec>): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: sid,
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-p3",
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
  ...ov,
});

const workerResult = (sid: string) => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION as 1,
  taskId: "task-1",
  sessionId: sid,
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

const stubRunner = (sid: string): ABoxTaskRunner => {
  const base: WorkerTaskProgressEvent = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    kind: "task.progress",
    taskId: "task-1",
    sessionId: sid,
    status: "running",
    timestamp: "2026-04-15T00:00:00.500Z",
  };
  const events: WorkerTaskProgressEvent[] = [
    { ...base, kind: "task.started", status: "running" },
    { ...base, kind: "task.completed", status: "succeeded" },
  ];
  const exec: TaskExecutionRecord = {
    events,
    result: workerResult(sid),
    workerErrors: [],
    rawOutput: "hello",
    ok: true,
    metadata: { cmd: ["abox", "run"], taskId: "abox-stub-1" },
  };
  const h = async (_s: unknown, _o: unknown, hs: TaskRunnerHandlers = {}) => {
    for (const e of events) hs.onEvent?.(e);
    return exec;
  };
  return { runTask: h, runAttempt: h } as unknown as ABoxTaskRunner;
};

const nopWriter = (): EventLogWriter => ({
  append: async () => {},
  flush: async () => {},
  close: async () => {},
  getDroppedBatchCount: () => 0,
  getFilePath: () => "/dev/null",
});

const seedSession = async (store: SessionStore, sid: string, prompt: string) =>
  store.createSession({
    sessionId: sid,
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

const ISO = "2026-04-15T00:00:00.000Z";

// -- 1. Normal prompt → implement_change / assistant_job ---------------------

test("phase3: normal prompt in standard mode", () => {
  const { intent, spec } = plan("add a retry button to the UI", "standard");
  assert.equal(intent.kind, "implement_change");
  assert.equal(spec.taskKind, "assistant_job");
  assert.equal(spec.execution.engine, "agent_cli");
  assert.equal(spec.mode, "build");
});

// -- 2. /run-command → explicit_command / shell ------------------------------

test("phase3: /run-command → explicit_command with bash -lc", () => {
  const { intent, spec } = plan("/run-command echo hi", "standard", { isExplicitCommand: true });
  assert.equal(intent.kind, "run_explicit_command");
  assert.equal(spec.taskKind, "explicit_command");
  assert.equal(spec.execution.engine, "shell");
  assert.deepEqual(spec.execution.command, ["bash", "-lc", "echo hi"]);
});

// -- 3. Check-like prompt → run_check / verification_check -------------------

test("phase3: check-like prompt → run_check / verification_check", () => {
  const { intent, spec } = plan("run tests", "standard");
  assert.equal(intent.kind, "run_check");
  assert.equal(spec.taskKind, "verification_check");
  assert.equal(spec.execution.engine, "shell");
  assert.equal(spec.execution.command, undefined);
  assert.deepEqual(spec.acceptanceChecks[0]?.command, ["bash", "-lc", "tests"]);
});

// -- 4. Plan mode → inspect_repository, shell/write denied -------------------

test("phase3: plan mode → inspect_repository with denied shell/write", () => {
  const { intent, spec } = plan("explain the architecture", "plan");
  assert.equal(intent.kind, "inspect_repository");
  assert.equal(spec.taskKind, "assistant_job");
  assert.equal(spec.mode, "plan");
  const shell = spec.permissions.rules.find((r) => r.tool === "shell");
  const write = spec.permissions.rules.find((r) => r.tool === "write");
  assert.equal(shell?.effect, "deny");
  assert.equal(write?.effect, "deny");
});

// -- 5. Autopilot mode → allowAllTools + noAskUser ---------------------------

test("phase3: autopilot mode → allowAllTools, noAskUser, all-allow", () => {
  const { spec } = plan("fix all the bugs", "autopilot");
  assert.equal(spec.permissions.allowAllTools, true);
  assert.equal(spec.permissions.noAskUser, true);
  const shell = spec.permissions.rules.find((r) => r.tool === "shell");
  assert.equal(shell?.effect, "allow");
});

// -- 6. Deny-precedence invariant --------------------------------------------

test("phase3: deny-precedence — deny overrides autopilot allow", () => {
  const rules: PermissionRule[] = [
    hydratePermissionRule({
      effect: "allow",
      tool: "shell",
      pattern: "*",
      source: "agent_profile",
    }),
    hydratePermissionRule({
      effect: "deny",
      tool: "shell",
      pattern: "rm -rf *",
      source: "repo_config",
    }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "rm -rf *"), "deny");
  assert.equal(evaluatePermission(rules, "shell", "echo hi"), "allow");
});

// -- 7. AttemptSpec.schemaVersion === 3 --------------------------------------

test("phase3: AttemptSpec.schemaVersion === 3", () => {
  assert.equal(plan("any prompt", "standard").spec.schemaVersion, 3);
});

// -- 8. attemptSpec persisted on SessionAttemptRecord -------------------------

test("phase3: attemptSpec persisted on SessionAttemptRecord", async () => {
  const rootDir = await createTempRoot();
  try {
    const sid = "session-persist-p3";
    const store = new SessionStore(rootDir);
    await seedSession(store, sid, "persist spec");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(rootDir),
      runner: stubRunner(sid),
      sessionId: sid,
      turnId: "turn-1",
      spec: makeSpec(sid),
      args: baseArgs(rootDir),
      eventLogWriterFactory: () => nopWriter(),
    });
    const session = await store.loadSession(sid);
    const attempt = session!.turns[0]!.attempts[0]!;
    assert.equal(attempt.attemptSpec?.schemaVersion, 3);
    assert.equal(attempt.attemptSpec?.taskKind, "assistant_job");
    assert.equal(attempt.attemptSpec?.intentId, "intent-p3");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// -- 9. Reviewer uses checkResults ------------------------------------------

test("phase3: reviewer uses checkResults for structured review", () => {
  const spec = makeSpec("session-review-checks");
  const ok: AttemptExecutionResult = {
    schemaVersion: 3,
    attemptId: "attempt-1",
    taskKind: "assistant_job",
    status: "succeeded",
    summary: "all good",
    exitCode: 0,
    startedAt: ISO,
    finishedAt: ISO,
    durationMs: 1000,
    artifacts: [],
    checkResults: [{ checkId: "check-0", passed: true, exitCode: 0, output: "ok" }],
  };
  const review = reviewAttemptResult(spec, ok);
  assert.equal(review.outcome, "success");
  assert.ok(review.checkResults);
  assert.equal(review.checkResults[0]!.passed, true);

  const fail: AttemptExecutionResult = {
    ...ok,
    status: "failed",
    exitCode: 1,
    checkResults: [{ checkId: "check-0", passed: false, exitCode: 1, output: "nope" }],
  };
  assert.equal(reviewAttemptResult(spec, fail).outcome, "retryable_failure");
});

// -- 10. intentId threads through intent → spec → review --------------------

test("phase3: intentId threads through intent → spec → review", async () => {
  const rootDir = await createTempRoot();
  try {
    const sid = "session-intent-thread";
    const store = new SessionStore(rootDir);
    await seedSession(store, sid, "intent thread test");
    const { intent } = plan("add a retry button", "standard");
    const spec = makeSpec(sid, { intentId: intent.intentId });
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(rootDir),
      runner: stubRunner(sid),
      sessionId: sid,
      turnId: "turn-1",
      spec,
      args: baseArgs(rootDir),
      eventLogWriterFactory: () => nopWriter(),
    });
    const session = await store.loadSession(sid);
    assert.equal(session!.turns[0]!.attempts[0]?.attemptSpec?.intentId, intent.intentId);
    assert.equal(session!.turns[0]!.latestReview?.intentId, intent.intentId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// -- 13. CURRENT_SESSION_SCHEMA_VERSION stays at 2 ---------------------------

test("phase3: CURRENT_SESSION_SCHEMA_VERSION remains 2", async () => {
  const { CURRENT_SESSION_SCHEMA_VERSION } = await import("../../src/sessionTypes.js");
  assert.equal(CURRENT_SESSION_SCHEMA_VERSION, 2);
});

// -- 14. Plan mode carries read-only constraints -----------------------------

test("phase3: plan mode intent carries read-only constraint", () => {
  const { intent } = plan("look at this code", "plan");
  assert.ok(intent.constraints.some((c) => c.includes("read-only")));
});
