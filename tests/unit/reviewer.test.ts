import test from "node:test";
import assert from "node:assert/strict";

import type { AttemptExecutionResult, AttemptSpec } from "../../src/attemptProtocol.js";
import { classifyReviewedOutcome } from "../../src/resultClassifier.js";
import { reviewAttemptResult, reviewTaskResult } from "../../src/reviewer.js";

const baseResult = {
  schemaVersion: 1,
  taskId: "task-1",
  sessionId: "session-1",
  finishedAt: "2026-04-13T00:00:00.000Z",
  summary: "task finished",
} as const;

test("reviewTaskResult classifies success and accepts it", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "succeeded",
    exitCode: 0,
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.action, "accept");
  assert.equal(result.retryable, false);
  assert.equal(result.needsUser, false);
});

test("reviewTaskResult classifies retryable failures", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "failed",
    exitCode: 124,
    summary: "command timed out",
  });

  assert.equal(result.outcome, "retryable_failure");
  assert.equal(result.action, "retry");
  assert.equal(result.retryable, true);
});

test("reviewTaskResult classifies blocked work as needing the user", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "blocked",
    exitCode: 1,
    summary: "blocked waiting for approval",
  });

  assert.equal(result.outcome, "blocked_needs_user");
  assert.equal(result.action, "ask_user");
  assert.equal(result.needsUser, true);
});

test("reviewTaskResult classifies policy denials via hints or evidence", () => {
  const hinted = reviewTaskResult(
    {
      ...baseResult,
      status: "failed",
      exitCode: 1,
      summary: "operation refused",
    },
    { policyDenied: true },
  );

  assert.equal(hinted.outcome, "policy_denied");
  assert.equal(hinted.action, "halt");
  assert.equal(hinted.retryable, false);

  const evidenceBased = classifyReviewedOutcome({
    ...baseResult,
    status: "failed",
    exitCode: 1,
    summary: "denied by policy",
  });

  assert.equal(evidenceBased.outcome, "policy_denied");
});

test("reviewTaskResult classifies incomplete work as follow-up", () => {
  const result = reviewTaskResult({
    ...baseResult,
    status: "needs_review",
    exitCode: 127,
    summary: "command not found",
  });

  assert.equal(result.outcome, "incomplete_needs_follow_up");
  assert.equal(result.action, "follow_up");
  assert.equal(result.retryable, false);
  assert.equal(result.needsUser, false);
});

// ---------------------------------------------------------------------------
// Phase 3: reviewAttemptResult — AttemptSpec + AttemptExecutionResult
// ---------------------------------------------------------------------------

const baseSpec: AttemptSpec = {
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
  acceptanceChecks: [{ checkId: "check-0", label: "change applied" }],
  artifactRequests: [],
};

const makeExecResult = (overrides?: Partial<AttemptExecutionResult>): AttemptExecutionResult => ({
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

test("reviewAttemptResult: success when all checks pass and exit is 0", () => {
  const execResult = makeExecResult({
    checkResults: [{ checkId: "check-0", passed: true, exitCode: 0, output: "ok" }],
  });
  const review = reviewAttemptResult(baseSpec, execResult);
  assert.equal(review.outcome, "success");
  assert.equal(review.action, "accept");
  assert.equal(review.attemptId, "attempt-1");
  assert.equal(review.intentId, "intent-abc");
  assert.equal(review.retryable, false);
  assert.ok(review.checkResults);
  assert.equal(review.checkResults.length, 1);
  assert.equal(review.checkResults[0]!.passed, true);
});

test("reviewAttemptResult: success when no checks and exit is 0", () => {
  const review = reviewAttemptResult(baseSpec, makeExecResult());
  assert.equal(review.outcome, "success");
  assert.equal(review.action, "accept");
});

test("reviewAttemptResult: falls through to classifier when check fails", () => {
  const execResult = makeExecResult({
    status: "failed",
    exitCode: 1,
    summary: "check failed",
    checkResults: [{ checkId: "check-0", passed: false, exitCode: 1, output: "nope" }],
  });
  const review = reviewAttemptResult(baseSpec, execResult);
  assert.equal(review.outcome, "retryable_failure");
  assert.equal(review.action, "retry");
  assert.equal(review.retryable, true);
  assert.ok(review.checkResults);
});

test("reviewAttemptResult: falls through to classifier when exit code is non-zero", () => {
  const execResult = makeExecResult({
    status: "failed",
    exitCode: 1,
    summary: "command failed",
  });
  const review = reviewAttemptResult(baseSpec, execResult);
  assert.equal(review.outcome, "retryable_failure");
  assert.equal(review.action, "retry");
});

test("reviewAttemptResult: policy denial via hints", () => {
  const execResult = makeExecResult({
    status: "failed",
    exitCode: 1,
    summary: "denied",
  });
  const review = reviewAttemptResult(baseSpec, execResult, { policyDenied: true });
  assert.equal(review.outcome, "policy_denied");
  assert.equal(review.action, "halt");
});

test("reviewAttemptResult: preserved manual-apply candidate blocks for user review", () => {
  const review = reviewAttemptResult(baseSpec, makeExecResult(), {
    profile: {
      providerId: "codex",
      resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
      sandboxLifecycle: "preserved",
      candidatePolicy: "manual_apply",
    },
    inspection: {
      sandboxTaskId: "bakudo-attempt-1",
      branchName: "refs/heads/agent/bakudo-attempt-1",
      worktreePath: "/tmp/worktree",
      reservedOutputDir: ".bakudo/out/attempt-1",
      currentHeadSha: "a".repeat(40),
      dirty: true,
      changedFiles: ["src/app.ts"],
      repoChangedFiles: ["src/app.ts"],
      dirtyFiles: ["src/app.ts"],
      committedFiles: [],
      changeKind: "dirty",
      outputArtifacts: [],
      patchDiff: "diff --git a/src/app.ts b/src/app.ts",
      diffBytes: 32,
    },
  });
  assert.equal(review.outcome, "blocked_needs_user");
  assert.equal(review.action, "ask_user");
  assert.equal(review.status, "blocked");
});

test("reviewAttemptResult: preserved change without repo mutation is rejected", () => {
  const review = reviewAttemptResult(baseSpec, makeExecResult(), {
    profile: {
      providerId: "codex",
      resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
      sandboxLifecycle: "preserved",
      candidatePolicy: "auto_apply",
    },
    inspection: {
      sandboxTaskId: "bakudo-attempt-1",
      branchName: "refs/heads/agent/bakudo-attempt-1",
      worktreePath: "/tmp/worktree",
      reservedOutputDir: ".bakudo/out/attempt-1",
      currentHeadSha: "a".repeat(40),
      dirty: true,
      changedFiles: [".bakudo/out/attempt-1/summary.md"],
      repoChangedFiles: [],
      dirtyFiles: [],
      committedFiles: [],
      changeKind: "clean",
      outputArtifacts: ["summary.md"],
      patchDiff: "",
      diffBytes: 0,
    },
  });
  assert.equal(review.outcome, "retryable_failure");
  assert.equal(review.action, "retry");
});

test("reviewAttemptResult: explicit_command is accepted without repo mutation even under a preserved profile", () => {
  const review = reviewAttemptResult(
    {
      ...baseSpec,
      taskKind: "explicit_command",
      execution: { engine: "shell", command: ["bash", "-lc", "echo hi"] },
      acceptanceChecks: [],
    },
    makeExecResult({ taskKind: "explicit_command", summary: "command completed successfully" }),
    {
      profile: {
        providerId: "codex",
        resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
        sandboxLifecycle: "preserved",
        candidatePolicy: "auto_apply",
      },
      inspection: {
        sandboxTaskId: "bakudo-attempt-1",
        branchName: "refs/heads/agent/bakudo-attempt-1",
        worktreePath: "/tmp/worktree",
        reservedOutputDir: ".bakudo/out/attempt-1",
        currentHeadSha: "a".repeat(40),
        dirty: false,
        changedFiles: [],
        repoChangedFiles: [],
        dirtyFiles: [],
        committedFiles: [],
        changeKind: "clean",
        outputArtifacts: ["result.json"],
        patchDiff: "",
        diffBytes: 0,
      },
    },
  );
  assert.equal(review.outcome, "success");
  assert.equal(review.action, "accept");
});

test("reviewAttemptResult: report-only attempt rejects repo mutation", () => {
  const review = reviewAttemptResult(
    { ...baseSpec, mode: "plan" },
    makeExecResult(),
    {
      profile: {
        providerId: "codex",
        resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
        sandboxLifecycle: "preserved",
        candidatePolicy: "discard",
      },
      inspection: {
        sandboxTaskId: "bakudo-attempt-1",
        branchName: "refs/heads/agent/bakudo-attempt-1",
        worktreePath: "/tmp/worktree",
        reservedOutputDir: ".bakudo/out/attempt-1",
        currentHeadSha: "a".repeat(40),
        dirty: true,
        changedFiles: ["README.md"],
        repoChangedFiles: ["README.md"],
        dirtyFiles: ["README.md"],
        committedFiles: [],
        changeKind: "dirty",
        outputArtifacts: ["summary.md"],
        patchDiff: "diff",
        diffBytes: 4,
      },
    },
  );
  assert.equal(review.outcome, "retryable_failure");
  assert.equal(review.action, "retry");
});
