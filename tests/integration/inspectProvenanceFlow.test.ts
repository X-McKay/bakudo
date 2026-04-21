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
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { formatInspectProvenance, formatInspectTab } from "../../src/host/inspectTabs.js";
import { loadAttemptProvenance } from "../../src/host/timeline.js";

/**
 * End-to-end smoke test for Phase 4 PR4: drive a stub runner through
 * `executeAttempt`, load the persisted {@link ProvenanceRecord} back, then
 * render the provenance tab and assert the 8 documented sections surface in
 * order. Mirrors the stub-runner pattern from `executeAttemptProvenance.test.ts`.
 */

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-ipflow-"));

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

const makeSpec = (sessionId: string): AttemptSpec => ({
  schemaVersion: 3,
  sessionId,
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-flow",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "integration test prompt",
  instructions: ["User prompt: integration test prompt"],
  cwd: "/tmp/repo",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 300, maxOutputBytes: 10_000_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-0", label: "changes made" }],
  artifactRequests: [{ name: "result.json", kind: "result", required: true }],
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
    for (const event of events) hs.onEvent?.(event);
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

// ---------------------------------------------------------------------------

test("inspectProvenanceFlow: execute → load → render 8 sections in order", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root);
    await seedSession(store, "session-ipf-1", "run the attempt");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ipf-1"),
      sessionId: "session-ipf-1",
      turnId: "turn-1",
      spec: makeSpec("session-ipf-1"),
      args: baseArgs(root),
    });
    const session = await store.loadSession("session-ipf-1");
    assert.ok(session);
    const turn = session!.turns[0]!;
    const attempt = turn.attempts[0]!;
    const provenance = await loadAttemptProvenance(root, "session-ipf-1", attempt.attemptId);
    assert.ok(provenance, "provenance record must be persisted post-execution");
    const lines = formatInspectProvenance({
      session: session!,
      attempt,
      provenance: provenance!,
      approvals: [],
    });
    const joined = lines.join("\n");
    // All 8 sections must surface.
    assert.match(joined, /Active agent profile:/);
    assert.match(joined, /Compiled AttemptSpec:/);
    assert.match(joined, /abox dispatch command:/);
    assert.match(joined, /Sandbox /);
    assert.match(joined, /Worktree /);
    assert.match(joined, /Permission rule matches:/);
    assert.match(joined, /Approval timeline:/);
    assert.match(joined, /Env allowlist snapshot:/);
    assert.match(joined, /Exit details:/);

    const indexOf = (needle: string): number => lines.findIndex((line) => line.includes(needle));
    // Enforce sequence of section labels.
    assert.ok(indexOf("Active agent profile:") < indexOf("Compiled AttemptSpec:"));
    assert.ok(indexOf("Compiled AttemptSpec:") < indexOf("abox dispatch command:"));
    assert.ok(indexOf("abox dispatch command:") < indexOf("Permission rule matches:"));
    assert.ok(indexOf("Permission rule matches:") < indexOf("Approval timeline:"));
    assert.ok(indexOf("Approval timeline:") < indexOf("Env allowlist snapshot:"));
    assert.ok(indexOf("Env allowlist snapshot:") < indexOf("Exit details:"));

    // Dispatch command rendered as array (one arg per line with '  - ' prefix).
    assert.match(joined, /  - abox\n/);
    assert.match(joined, /  - run\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectProvenanceFlow: dispatcher routing produces the same provenance output", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root);
    await seedSession(store, "session-ipf-2", "dispatcher test");
    await executeAttempt({
      sessionStore: store,
      artifactStore: new ArtifactStore(root),
      runner: stubRunner("session-ipf-2"),
      sessionId: "session-ipf-2",
      turnId: "turn-1",
      spec: makeSpec("session-ipf-2"),
      args: baseArgs(root),
    });
    const session = await store.loadSession("session-ipf-2");
    const attempt = session!.turns[0]!.attempts[0]!;
    const provenance = await loadAttemptProvenance(root, "session-ipf-2", attempt.attemptId);
    const direct = formatInspectProvenance({
      session: session!,
      attempt,
      provenance: provenance!,
      approvals: [],
    });
    const viaDispatcher = formatInspectTab("provenance", {
      session: session!,
      turn: session!.turns[0]!,
      attempt,
      artifacts: [],
      events: [],
      approvals: [],
      provenance: provenance!,
    });
    assert.deepEqual(direct, viaDispatcher);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
