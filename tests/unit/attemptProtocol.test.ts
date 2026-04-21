import assert from "node:assert/strict";
import test from "node:test";

import {
  AttemptExecutionResultSchema,
  AttemptSpecSchema,
  BatchSpecSchema,
  CandidateSetSchema,
  CandidateSetResultSchema,
  DispatchPlanSchema,
  ExecutionProfileSchema,
  PermissionRuleSchema,
  TurnIntentSchema,
  reservedGuestOutputDirForAttempt,
  sanitizeAttemptPathSegment,
  type AttemptExecutionResult,
  type AttemptSpec,
  type PermissionRule,
  type TurnIntent,
} from "../../src/attemptProtocol.js";

// ---------------------------------------------------------------------------
// TurnIntent
// ---------------------------------------------------------------------------

test("TurnIntentSchema accepts a valid TurnIntent", () => {
  const intent: TurnIntent = {
    intentId: "intent-001",
    kind: "implement_change",
    composerMode: "standard",
    prompt: "add tests",
    repoRoot: "/repo",
    acceptanceGoals: ["all tests pass"],
    constraints: [],
  };
  const parsed = TurnIntentSchema.parse(intent);
  assert.equal(parsed.intentId, "intent-001");
  assert.equal(parsed.kind, "implement_change");
});

test("TurnIntentSchema rejects invalid kind", () => {
  assert.throws(
    () =>
      TurnIntentSchema.parse({
        intentId: "intent-002",
        kind: "invalid_kind",
        composerMode: "standard",
        prompt: "x",
        repoRoot: "/repo",
        acceptanceGoals: [],
        constraints: [],
      }),
    /invalid/iu,
  );
});

test("TurnIntentSchema strips unknown keys (tolerant read)", () => {
  const raw = {
    intentId: "intent-003",
    kind: "run_check",
    composerMode: "plan",
    prompt: "check",
    repoRoot: "/repo",
    acceptanceGoals: [],
    constraints: [],
    extraField: true,
  };
  const parsed = TurnIntentSchema.parse(raw);
  assert.equal("extraField" in parsed, false);
});

test("TurnIntentSchema accepts optional tokenBudget", () => {
  const intent: TurnIntent = {
    intentId: "intent-004",
    kind: "inspect_repository",
    composerMode: "autopilot",
    prompt: "look around",
    repoRoot: "/repo",
    acceptanceGoals: [],
    constraints: [],
    tokenBudget: 500_000,
  };
  const parsed = TurnIntentSchema.parse(intent);
  assert.equal(parsed.tokenBudget, 500_000);
});

// ---------------------------------------------------------------------------
// PermissionRule
// ---------------------------------------------------------------------------

test("PermissionRuleSchema accepts valid rule", () => {
  const rule: PermissionRule = {
    ruleId: "rule-deny-shell-rm",
    effect: "deny",
    tool: "shell",
    pattern: "rm -rf *",
    scope: "session",
    source: "agent_profile",
  };
  const parsed = PermissionRuleSchema.parse(rule);
  assert.equal(parsed.effect, "deny");
  assert.equal(parsed.source, "agent_profile");
  assert.equal(parsed.scope, "session");
  assert.equal(parsed.ruleId, "rule-deny-shell-rm");
});

test("PermissionRuleSchema is tolerant — missing ruleId and scope parse OK", () => {
  const parsed = PermissionRuleSchema.parse({
    effect: "allow",
    tool: "shell",
    pattern: "*",
    source: "agent_profile",
  });
  assert.equal(parsed.ruleId, undefined);
  assert.equal(parsed.scope, undefined);
});

test("PermissionRuleSchema accepts all four sources", () => {
  for (const source of [
    "agent_profile",
    "user_interactive",
    "repo_config",
    "user_config",
  ] as const) {
    const parsed = PermissionRuleSchema.parse({
      effect: "allow",
      tool: "write",
      pattern: "*",
      source,
    });
    assert.equal(parsed.source, source);
  }
});

test("PermissionRuleSchema rejects unknown source", () => {
  assert.throws(
    () =>
      PermissionRuleSchema.parse({
        effect: "allow",
        tool: "write",
        pattern: "*",
        source: "unknown_source",
      }),
    /invalid/iu,
  );
});

// ---------------------------------------------------------------------------
// AttemptSpec
// ---------------------------------------------------------------------------

const validAttemptSpec: AttemptSpec = {
  schemaVersion: 3,
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "bakudo-stream-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "implement feature",
  instructions: ["be concise"],
  cwd: "/repo",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 300, maxOutputBytes: 1_000_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
};

test("AttemptSpecSchema accepts a valid AttemptSpec", () => {
  const parsed = AttemptSpecSchema.parse(validAttemptSpec);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.taskKind, "assistant_job");
});

test("AttemptSpecSchema enforces schemaVersion === 3", () => {
  assert.throws(() => AttemptSpecSchema.parse({ ...validAttemptSpec, schemaVersion: 2 }));
});

test("AttemptSpecSchema strips unknown keys in nested objects", () => {
  const raw = {
    ...validAttemptSpec,
    execution: { engine: "shell", command: ["ls"], bonus: true },
  };
  const parsed = AttemptSpecSchema.parse(raw);
  assert.equal("bonus" in parsed.execution, false);
});

test("AttemptSpecSchema rejects invalid taskKind", () => {
  assert.throws(
    () => AttemptSpecSchema.parse({ ...validAttemptSpec, taskKind: "unknown" }),
    /invalid/iu,
  );
});

test("DispatchPlanSchema accepts optional batchId/candidateId", () => {
  const parsed = DispatchPlanSchema.parse({
    schemaVersion: 1,
    profile: ExecutionProfileSchema.parse({
      providerId: "codex",
      resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
      sandboxLifecycle: "preserved",
      candidatePolicy: "manual_apply",
    }),
    spec: validAttemptSpec,
  });
  assert.equal(parsed.batchId, undefined);
  assert.equal(parsed.candidateId, undefined);
});

test("BatchSpecSchema accepts dispatch-plan candidates", () => {
  const batch = BatchSpecSchema.parse({
    batchId: "batch-1",
    intentId: "intent-1",
    candidates: [
      {
        schemaVersion: 1,
        candidateId: "attempt-1",
        profile: ExecutionProfileSchema.parse({
          providerId: "codex",
          resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
          sandboxLifecycle: "preserved",
          candidatePolicy: "manual_apply",
        }),
        spec: validAttemptSpec,
      },
    ],
  });
  assert.equal(batch.candidates.length, 1);
});

test("CandidateSetSchema aliases the batch candidate shape", () => {
  const candidateSet = CandidateSetSchema.parse({
    batchId: "batch-1",
    intentId: "intent-1",
    candidates: [
      {
        schemaVersion: 1,
        candidateId: "candidate-1",
        profile: ExecutionProfileSchema.parse({
          providerId: "codex",
          resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
          sandboxLifecycle: "preserved",
          candidatePolicy: "manual_apply",
        }),
        spec: validAttemptSpec,
      },
    ],
  });
  assert.equal(candidateSet.batchId, "batch-1");
  assert.equal(candidateSet.candidates[0]?.candidateId, "candidate-1");
});

test("CandidateSetResultSchema accepts selected candidate ids", () => {
  const parsed = CandidateSetResultSchema.parse({
    batchId: "batch-1",
    results: {
      "attempt-1": {
        schemaVersion: 3,
        attemptId: "attempt-1",
        taskKind: "assistant_job",
        status: "succeeded",
        summary: "ok",
        startedAt: "2026-04-15T00:00:00Z",
        finishedAt: "2026-04-15T00:05:00Z",
        durationMs: 1,
        artifacts: [],
      },
    },
    selectedCandidateId: "attempt-1",
  });
  assert.equal(parsed.selectedCandidateId, "attempt-1");
});

test("reservedGuestOutputDirForAttempt uses a worktree-visible path", () => {
  assert.equal(sanitizeAttemptPathSegment("turn:1/attempt 2"), "turn-1-attempt-2");
  assert.equal(
    reservedGuestOutputDirForAttempt("turn:1/attempt 2"),
    "/workspace/.bakudo/out/turn-1-attempt-2",
  );
});

// ---------------------------------------------------------------------------
// AttemptExecutionResult
// ---------------------------------------------------------------------------

const validResult: AttemptExecutionResult = {
  schemaVersion: 3,
  attemptId: "attempt-1",
  taskKind: "assistant_job",
  status: "succeeded",
  summary: "All tasks done",
  startedAt: "2026-04-15T00:00:00Z",
  finishedAt: "2026-04-15T00:05:00Z",
  durationMs: 300_000,
  artifacts: ["result.json"],
};

test("AttemptExecutionResultSchema accepts a valid result", () => {
  const parsed = AttemptExecutionResultSchema.parse(validResult);
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.status, "succeeded");
});

test("AttemptExecutionResultSchema enforces schemaVersion === 3", () => {
  assert.throws(() => AttemptExecutionResultSchema.parse({ ...validResult, schemaVersion: 1 }));
});

test("AttemptExecutionResultSchema accepts null exitCode", () => {
  const parsed = AttemptExecutionResultSchema.parse({ ...validResult, exitCode: null });
  assert.equal(parsed.exitCode, null);
});

test("AttemptExecutionResultSchema accepts checkResults", () => {
  const parsed = AttemptExecutionResultSchema.parse({
    ...validResult,
    checkResults: [{ checkId: "c1", passed: true, exitCode: 0, output: "ok" }],
  });
  assert.equal(parsed.checkResults?.length, 1);
  assert.equal(parsed.checkResults?.[0]?.passed, true);
});

test("AttemptExecutionResultSchema rejects invalid status", () => {
  assert.throws(
    () => AttemptExecutionResultSchema.parse({ ...validResult, status: "running" }),
    /invalid/iu,
  );
});
