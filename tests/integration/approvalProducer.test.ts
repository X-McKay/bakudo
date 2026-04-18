import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hydratePermissionRule,
  type AttemptSpec,
  type PermissionRule,
} from "../../src/attemptProtocol.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type SessionEventEnvelope } from "../../src/protocol.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import { SessionStore } from "../../src/sessionStore.js";
import {
  extractIntendedOperation,
  resolveApprovalBeforeDispatch,
} from "../../src/host/approvalProducer.js";
import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import { listTurnApprovals, loadDurableAllowlist } from "../../src/host/approvalStore.js";
import type {
  ApprovalDialogChoice,
  ApprovalRequest,
  DialogDispatcher,
} from "../../src/host/dialogLauncher.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
import type { EventLogWriter } from "../../src/host/eventLogWriter.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { createHookRegistry, registerHook, type HookRegistry } from "../../src/host/hooks.js";
import type {
  ABoxTaskRunner,
  TaskExecutionRecord,
  TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";

/**
 * Phase 4 PR7 — approval producer end-to-end. The tests construct an
 * AttemptSpec whose rules evaluate to `"ask"` on the intended shell
 * argument, then drive the producer through the dialog surface.
 */

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-ap-"));

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

const askRules = (): PermissionRule[] => [
  // Deliberately matches the intended argument — the evaluator returns "ask"
  // only when a rule fires; with `*` we guarantee the ask path without
  // relying on the no-match fallback (which would also be "ask" but is
  // noisier to reason about in tests).
  hydratePermissionRule({
    effect: "ask",
    tool: "shell",
    pattern: "*",
    source: "agent_profile",
  }),
];

const makeSpec = (sessionId: string, repoRoot: string, rules: PermissionRule[]): AttemptSpec => ({
  schemaVersion: 3,
  sessionId,
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "explicit_command",
  prompt: "/run-command git push origin main",
  instructions: ["User prompt: /run-command git push origin main"],
  cwd: repoRoot,
  execution: { engine: "shell", command: ["bash", "-lc", "git push origin main"] },
  permissions: { rules, allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 300, maxOutputBytes: 10_000_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-0", label: "push succeeds" }],
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

const scriptedLauncher =
  (choice: ApprovalDialogChoice) =>
  async (
    _dispatcher: DialogDispatcher,
    _request: ApprovalRequest,
    _pattern: string,
  ): Promise<ApprovalDialogChoice> =>
    choice;

test("resolveApprovalBeforeDispatch: ask → allow_once persists ApprovalRecord and emits two envelopes", async () => {
  const root = await createTempRoot();
  try {
    const repoRoot = root;
    const sessionId = "session-ap-1";
    const storageRoot = root;
    const spec = makeSpec(sessionId, repoRoot, askRules());
    const captured: SessionEventEnvelope[] = [];
    const writer = captureWriter(captured);
    const op = extractIntendedOperation(spec);
    assert.ok(op);

    const result = await resolveApprovalBeforeDispatch({
      storageRoot,
      repoRoot,
      spec,
      operation: op,
      composerMode: "standard",
      agentProfileName: "standard",
      writer,
      dispatcher: fakeDispatcher(),
      dialogLauncher: scriptedLauncher({ kind: "allow_once" }),
    });
    assert.equal(result.status, "proceed");

    const approvals = await listTurnApprovals(storageRoot, sessionId, "turn-1");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.decision, "approved");
    assert.equal(approvals[0]!.decidedBy, "user_prompt");
    assert.equal(approvals[0]!.request.displayCommand, "shell(git push origin main)");

    const kinds = captured.map((env) => env.kind);
    assert.ok(kinds.includes("host.approval_requested"));
    assert.ok(kinds.includes("host.approval_resolved"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveApprovalBeforeDispatch: ask → allow_always persists a durable rule", async () => {
  const root = await createTempRoot();
  try {
    const repoRoot = root;
    const sessionId = "session-ap-always";
    const spec = makeSpec(sessionId, repoRoot, askRules());
    const captured: SessionEventEnvelope[] = [];
    const writer = captureWriter(captured);
    const op = extractIntendedOperation(spec)!;

    // Pass a pattern that matches the argument so the durable rule
    // actually fires on a second evaluation (the glob matcher uses `*`
    // as a non-`/` wildcard; `git push:*` would not match the literal
    // argument). This stays realistic — users edit the suggested pattern
    // before persisting when the heuristic is wrong.
    const result = await resolveApprovalBeforeDispatch({
      storageRoot: root,
      repoRoot,
      spec,
      operation: op,
      composerMode: "standard",
      agentProfileName: "standard",
      writer,
      dispatcher: fakeDispatcher(),
      dialogLauncher: scriptedLauncher({ kind: "allow_always", pattern: "git push *" }),
    });
    assert.equal(result.status, "proceed");

    const durable = await loadDurableAllowlist(repoRoot);
    assert.equal(durable.length, 1);
    assert.equal(durable[0]!.effect, "allow");
    assert.equal(durable[0]!.pattern, "git push *");
    assert.equal(durable[0]!.scope, "always");
    assert.equal(durable[0]!.source, "user_interactive");

    // Second run with the same rule set should now see allow (from the
    // durable rule merge) and skip the dialog entirely.
    const capturedSecond: SessionEventEnvelope[] = [];
    const secondResult = await resolveApprovalBeforeDispatch({
      storageRoot: root,
      repoRoot,
      spec: makeSpec(sessionId, repoRoot, askRules()),
      operation: op,
      composerMode: "standard",
      agentProfileName: "standard",
      writer: captureWriter(capturedSecond),
      dispatcher: fakeDispatcher(),
      dialogLauncher: async () => {
        throw new Error("dialog launcher should not be called when durable rule allows");
      },
    });
    assert.equal(secondResult.status, "proceed");
    assert.equal(capturedSecond.length, 0, "no envelopes when the rule already allows");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveApprovalBeforeDispatch: deny rule short-circuits without dialog", async () => {
  const root = await createTempRoot();
  try {
    const repoRoot = root;
    const rules = [
      hydratePermissionRule({
        effect: "deny",
        tool: "shell",
        pattern: "*",
        source: "agent_profile",
      }),
    ];
    const spec = makeSpec("session-deny", repoRoot, rules);
    const captured: SessionEventEnvelope[] = [];
    const writer = captureWriter(captured);
    const op = extractIntendedOperation(spec)!;

    const result = await resolveApprovalBeforeDispatch({
      storageRoot: root,
      repoRoot,
      spec,
      operation: op,
      composerMode: "standard",
      agentProfileName: "standard",
      writer,
      dispatcher: fakeDispatcher(),
      dialogLauncher: async () => {
        throw new Error("dialog should not fire on deny");
      },
    });
    assert.equal(result.status, "blocked");

    const approvals = await listTurnApprovals(root, "session-deny", "turn-1");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.decision, "auto_denied");
    assert.equal(approvals[0]!.decidedBy, "recorded_rule");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveApprovalBeforeDispatch: permissionRequest hook auto-approves and skips the dialog", async () => {
  const root = await createTempRoot();
  try {
    const repoRoot = root;
    const sessionId = "session-hook-approve";
    const spec = makeSpec(sessionId, repoRoot, askRules());
    const captured: SessionEventEnvelope[] = [];
    const writer = captureWriter(captured);
    const op = extractIntendedOperation(spec)!;

    const registry: HookRegistry = createHookRegistry();
    registerHook(registry, "permissionRequest", async () => ({
      decision: "allow",
      reason: "policy auto-approved",
    }));

    const result = await resolveApprovalBeforeDispatch({
      storageRoot: root,
      repoRoot,
      spec,
      operation: op,
      composerMode: "standard",
      agentProfileName: "standard",
      writer,
      hookRegistry: registry,
      dispatcher: fakeDispatcher(),
      dialogLauncher: async () => {
        throw new Error("dialog should not fire when hook approves");
      },
    });
    assert.equal(result.status, "proceed");

    const approvals = await listTurnApprovals(root, sessionId, "turn-1");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.decidedBy, "hook_sync");
    assert.equal(approvals[0]!.decision, "auto_approved");
    assert.equal(approvals[0]!.matchedRule.source, "user_config");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// executeAttempt end-to-end with the approval wiring threaded through
// ---------------------------------------------------------------------------

const stubRunner = (sessionId: string): ABoxTaskRunner => {
  const result = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION as 1,
    taskId: "task-1",
    sessionId,
    status: "succeeded" as const,
    summary: "done",
    startedAt: "2026-04-15T00:00:00.000Z",
    finishedAt: "2026-04-15T00:00:01.000Z",
    exitCode: 0,
    command: "git push",
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
  };
  const execution: TaskExecutionRecord = {
    events: [],
    result,
    workerErrors: [],
    rawOutput: "",
    ok: true,
    metadata: { cmd: ["abox", "run"], taskId: "abox-stub-1" },
  };
  const handler = async (
    _s: unknown,
    _o: unknown,
    _handlers: TaskRunnerHandlers = {},
  ): Promise<TaskExecutionRecord> => execution;
  return { runTask: handler, runAttempt: handler } as unknown as ABoxTaskRunner;
};

test("executeAttempt: approval proceed flows through dispatch → review pipeline", async () => {
  const root = await createTempRoot();
  try {
    const sessionId = "session-ea-approve";
    const sessionStore = new SessionStore(root);
    const artifactStore = new ArtifactStore(root);
    await sessionStore.createSession({
      sessionId,
      goal: "execute with approval",
      repoRoot: root,
      assumeDangerousSkipPermissions: false,
      status: "running",
      turns: [
        {
          turnId: "turn-1",
          prompt: "push",
          mode: "build",
          status: "running",
          attempts: [],
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    });

    const spec = makeSpec(sessionId, root, askRules());
    const captured: SessionEventEnvelope[] = [];

    const { reviewed, executionResult } = await executeAttempt({
      sessionStore,
      artifactStore,
      runner: stubRunner(sessionId),
      sessionId,
      turnId: "turn-1",
      spec,
      args: baseArgs(root),
      eventLogWriterFactory: () => captureWriter(captured),
      repoRoot: root,
      approvalDispatcher: fakeDispatcher(),
      approvalOverride: async () => ({ status: "proceed" }),
    });

    assert.equal(reviewed.outcome, "success");
    assert.equal(executionResult.status, "succeeded");

    const kinds = captured.map((env) => env.kind);
    assert.ok(kinds.includes("host.dispatch_started"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
