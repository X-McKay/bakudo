import type { AttemptExecutionResult, AttemptSpec, CheckResult } from "./attemptProtocol.js";
import type { TaskResult } from "./protocol.js";
import {
  classifyReviewedOutcome,
  type ReviewClassification,
  type ReviewClassifierHints,
} from "./resultClassifier.js";

export type ReviewedTaskResult = ReviewClassification & {
  taskId: string;
  sessionId: string;
  status: TaskResult["status"];
  result: TaskResult;
};

export const reviewTaskResult = (
  result: TaskResult,
  hints: ReviewClassifierHints = {},
): ReviewedTaskResult => {
  const classification = classifyReviewedOutcome(result, hints);
  return {
    ...classification,
    taskId: result.taskId,
    sessionId: result.sessionId,
    status: result.status,
    result,
  };
};

// ---------------------------------------------------------------------------
// Phase 3 reviewer — operates on AttemptSpec + AttemptExecutionResult
// ---------------------------------------------------------------------------

/**
 * Result of reviewing an {@link AttemptExecutionResult} together with its
 * originating {@link AttemptSpec}. Extends the base classification with
 * Phase 3 context: intent ID, task kind, and check-level detail.
 */
export type ReviewedAttemptResult = ReviewClassification & {
  attemptId: string;
  intentId: string;
  status: AttemptExecutionResult["status"];
  checkResults?: CheckResult[];
};

/**
 * All checks passed (or no checks exist) AND exit code is zero/absent.
 */
const allChecksPassed = (executionResult: AttemptExecutionResult): boolean => {
  const checks = executionResult.checkResults;
  if (checks === undefined || checks.length === 0) {
    return true;
  }
  return checks.every((check) => check.passed);
};

/**
 * Review an {@link AttemptExecutionResult} using the originating
 * {@link AttemptSpec}. When all check results passed and the exit code
 * is 0, the outcome is `success` regardless of text-based heuristics.
 * Otherwise falls back to the existing classifier logic via a synthetic
 * {@link TaskResult}.
 */
export const reviewAttemptResult = (
  spec: AttemptSpec,
  executionResult: AttemptExecutionResult,
  hints: ReviewClassifierHints = {},
): ReviewedAttemptResult => {
  // Fast path: structured checks + clean exit → success.
  const checksOk = allChecksPassed(executionResult);
  const exitOk =
    executionResult.exitCode === 0 ||
    executionResult.exitCode === null ||
    executionResult.exitCode === undefined;
  if (checksOk && exitOk && executionResult.status === "succeeded") {
    return {
      outcome: "success",
      action: "accept",
      reason: "all acceptance checks passed and exit code is 0",
      retryable: false,
      needsUser: false,
      attemptId: spec.attemptId,
      intentId: spec.intentId,
      status: executionResult.status,
      ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
    };
  }

  // Fall through to heuristic classifier via synthetic TaskResult.
  const exitCode = executionResult.exitCode;
  const syntheticResult: TaskResult = {
    schemaVersion: 1,
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    status: executionResult.status === "succeeded" ? "succeeded" : "failed",
    summary: executionResult.summary,
    ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}),
    finishedAt: executionResult.finishedAt,
  };
  const classification = classifyReviewedOutcome(syntheticResult, hints);

  return {
    ...classification,
    attemptId: spec.attemptId,
    intentId: spec.intentId,
    status: executionResult.status,
    ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
  };
};
