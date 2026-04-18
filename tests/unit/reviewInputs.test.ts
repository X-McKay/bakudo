import assert from "node:assert/strict";
import test from "node:test";

import type { AttemptExecutionResult, AttemptSpec } from "../../src/attemptProtocol.js";
import type { ApprovalRecord } from "../../src/host/approvalStore.js";
import type { ArtifactRecord } from "../../src/host/artifactStore.js";
import type { AttemptLineage } from "../../src/host/attemptLineage.js";
import { reviewAttemptWithInputs, type ReviewInputs } from "../../src/reviewer.js";
import type { SessionAttemptRecord } from "../../src/sessionTypes.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const buildSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-abc",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "do something",
  instructions: [],
  cwd: ".",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 300, maxOutputBytes: 10_000_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-0", label: "lint passes", command: ["pnpm", "lint"] }],
  artifactRequests: [],
  ...overrides,
});

const buildExecResult = (
  overrides: Partial<AttemptExecutionResult> = {},
): AttemptExecutionResult => ({
  schemaVersion: 3,
  attemptId: "attempt-1",
  taskKind: "assistant_job",
  status: "succeeded",
  summary: "all good",
  exitCode: 0,
  startedAt: "2026-04-15T00:00:00.000Z",
  finishedAt: "2026-04-15T00:00:01.000Z",
  durationMs: 1000,
  artifacts: [],
  ...overrides,
});

const buildAttempt = (overrides: Partial<SessionAttemptRecord> = {}): SessionAttemptRecord => ({
  attemptId: "attempt-1",
  status: "succeeded",
  ...overrides,
});

const buildLineage = (overrides: Partial<AttemptLineage> = {}): AttemptLineage => ({
  attemptId: "attempt-1",
  chainId: "chain-attempt-1",
  depth: 0,
  ...overrides,
});

const buildArtifact = (overrides: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  schemaVersion: 2,
  artifactId: "artifact-1",
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  kind: "log",
  name: "worker-output.log",
  path: "artifacts/worker-output.log",
  createdAt: "2026-04-15T00:00:02.000Z",
  ...overrides,
});

const buildApproval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  schemaVersion: 1,
  approvalId: "approval-1",
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  request: {
    tool: "shell",
    argument: "git push origin main",
    displayCommand: "shell(git push origin main)",
  },
  matchedRule: {
    ruleId: "rule-abc",
    effect: "ask",
    tool: "shell",
    pattern: "git push*",
    scope: "session",
    source: "agent_profile",
  },
  decision: "approved",
  decidedBy: "user_prompt",
  decidedAt: "2026-04-15T00:00:00.500Z",
  requestedAt: "2026-04-15T00:00:00.100Z",
  rationale: "user confirmed",
  policySnapshot: {
    agent: "claude",
    composerMode: "standard",
    autopilot: false,
  },
  ...overrides,
});

const buildInputs = (overrides: Partial<ReviewInputs> = {}): ReviewInputs => ({
  attempt: buildAttempt(),
  attemptSpec: buildSpec(),
  executionResult: buildExecResult({
    checkResults: [{ checkId: "check-0", passed: true, exitCode: 0, output: "ok" }],
  }),
  artifacts: [],
  approvals: [],
  lineage: buildLineage(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// High-confidence success
// ---------------------------------------------------------------------------

test("reviewAttemptWithInputs: high confidence when checks pass, no approvals, depth 0", () => {
  const output = reviewAttemptWithInputs(buildInputs());
  assert.equal(output.outcome, "success");
  assert.equal(output.action, "accept");
  assert.equal(output.confidence, "high");
  assert.match(output.userExplanation, /Attempt completed/);
  assert.match(output.userExplanation, /Checks passed: 1\/1/);
  assert.equal(output.remediationHint, undefined);
});

// ---------------------------------------------------------------------------
// Medium-confidence success (ask approval, lineage depth 1)
// ---------------------------------------------------------------------------

test("reviewAttemptWithInputs: medium confidence when an ask approval was approved with depth 1", () => {
  const inputs = buildInputs({
    approvals: [buildApproval({ decision: "approved", decidedBy: "user_prompt" })],
    lineage: buildLineage({ depth: 1, parentAttemptId: "attempt-0", chainId: "chain-parent" }),
  });
  const output = reviewAttemptWithInputs(inputs);
  assert.equal(output.outcome, "success");
  assert.equal(output.confidence, "medium");
  assert.equal(output.remediationHint, undefined);
});

// ---------------------------------------------------------------------------
// Low-confidence failure with remediation
// ---------------------------------------------------------------------------

test("reviewAttemptWithInputs: low confidence failure surfaces remediationHint with failing command and log artifact", () => {
  const inputs = buildInputs({
    executionResult: buildExecResult({
      status: "failed",
      exitCode: 1,
      summary: "lint failed",
      checkResults: [{ checkId: "check-0", passed: false, exitCode: 1, output: "nope" }],
    }),
    artifacts: [
      buildArtifact({
        kind: "log",
        name: "check-0-output.log",
        path: "artifacts/check-0-output.log",
      }),
    ],
  });
  const output = reviewAttemptWithInputs(inputs);
  assert.equal(output.outcome, "retryable_failure");
  assert.equal(output.action, "retry");
  assert.equal(output.confidence, "low");
  assert.ok(output.remediationHint !== undefined, "expected remediationHint to be present");
  assert.match(output.remediationHint, /pnpm lint/);
  assert.match(output.remediationHint, /check-0-output\.log/);
  assert.match(output.userExplanation, /lint passes/);
  assert.match(output.userExplanation, /exit 1/);
});

// ---------------------------------------------------------------------------
// Low-confidence policy denial
// ---------------------------------------------------------------------------

test("reviewAttemptWithInputs: low confidence policy denial surfaces the denied rule pattern in remediationHint", () => {
  const denied = buildApproval({
    decision: "denied",
    decidedBy: "user_prompt",
    matchedRule: {
      ruleId: "rule-push",
      effect: "deny",
      tool: "shell",
      pattern: "git push --force*",
      scope: "session",
      source: "agent_profile",
    },
  });
  const inputs = buildInputs({
    executionResult: buildExecResult({
      status: "failed",
      exitCode: 1,
      summary: "denied by policy",
    }),
    approvals: [denied],
  });
  const output = reviewAttemptWithInputs(inputs);
  assert.equal(output.outcome, "policy_denied");
  assert.equal(output.confidence, "low");
  assert.ok(output.remediationHint !== undefined);
  assert.match(output.remediationHint, /git push --force/);
  assert.match(output.userExplanation, /Blocked: git push --force\* matched/);
});

// ---------------------------------------------------------------------------
// Blocked needs_user
// ---------------------------------------------------------------------------

test("reviewAttemptWithInputs: blocked_needs_user userExplanation mentions user input", () => {
  const inputs = buildInputs({
    executionResult: buildExecResult({
      status: "blocked",
      exitCode: null,
      summary: "awaiting user",
      checkResults: [],
    }),
  });
  const output = reviewAttemptWithInputs(inputs);
  assert.equal(output.outcome, "blocked_needs_user");
  assert.equal(output.action, "ask_user");
  assert.equal(output.confidence, "low");
  assert.match(output.userExplanation, /Waiting on user input/);
  assert.equal(output.remediationHint, undefined);
});

// ---------------------------------------------------------------------------
// Retry loop detection (depth > 2)
// ---------------------------------------------------------------------------

test("reviewAttemptWithInputs: lineage depth > 2 forces low confidence even on success", () => {
  const inputs = buildInputs({
    lineage: buildLineage({
      depth: 3,
      parentAttemptId: "attempt-prev",
      chainId: "chain-abc",
      retryInitiator: "host",
      retryReason: "host_retry",
    }),
  });
  const output = reviewAttemptWithInputs(inputs);
  assert.equal(output.outcome, "success");
  assert.equal(output.confidence, "low");
});
