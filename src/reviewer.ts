import type {
  AttemptExecutionResult,
  AttemptSpec,
  CheckResult,
  ExecutionProfile,
  PermissionRule,
} from "./attemptProtocol.js";
import type { ArtifactRecord } from "./host/artifactStore.js";
import type { ApprovalRecord } from "./host/approvalStore.js";
import type { AttemptLineage } from "./host/attemptLineage.js";
import type { WorktreeInspection } from "./host/worktreeInspector.js";
import {
  classifyError,
  type BakudoErrorCode,
  type ExitCode,
  type RenderedError,
} from "./host/errors.js";
import type { TaskResult } from "./protocol.js";
import {
  classifyReviewedOutcome,
  type ReviewClassification,
  type ReviewClassifierHints,
  type ReviewConfidence,
} from "./resultClassifier.js";
import type { SessionAttemptRecord } from "./sessionTypes.js";

export type { ReviewConfidence } from "./resultClassifier.js";

/**
 * Phase 6 W9: the reviewer is the classification point for any error that
 * escapes a dispatch. The multi-tier classifier lives in `host/errors.ts`;
 * it is re-exported here so callers that already import from `reviewer.ts`
 * can pick up the taxonomy without another import hop.
 */
export { classifyError };
export type { BakudoErrorCode, ExitCode, RenderedError };

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

export type ReviewAttemptOptions = ReviewClassifierHints & {
  inspection?: WorktreeInspection | null;
  profile?: ExecutionProfile;
  mergeResult?: {
    merged?: boolean;
    discarded?: boolean;
    error?: string;
  } | null;
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
  options: ReviewAttemptOptions = {},
): ReviewedAttemptResult => {
  const { inspection, profile, mergeResult, ...hints } = options;
  // Fast path: structured checks + clean exit → success.
  const checksOk = allChecksPassed(executionResult);
  const exitOk =
    executionResult.exitCode === 0 ||
    executionResult.exitCode === null ||
    executionResult.exitCode === undefined;
  const repoChangedFiles = inspection?.repoChangedFiles ?? [];
  const outputArtifacts = inspection?.outputArtifacts ?? [];

  if (typeof mergeResult?.error === "string" && mergeResult.error.length > 0) {
    return {
      outcome: "retryable_failure",
      action: "retry",
      reason: mergeResult.error,
      retryable: true,
      needsUser: false,
      confidence: hints.confidence ?? "high",
      attemptId: spec.attemptId,
      intentId: spec.intentId,
      status: "failed",
      ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
    };
  }

  if (
    profile?.mergeStrategy === "none" &&
    profile.sandboxLifecycle === "preserved" &&
    spec.taskKind === "assistant_job" &&
    checksOk &&
    exitOk &&
    executionResult.status === "succeeded"
  ) {
    if (inspection === undefined || inspection === null) {
      return {
        outcome: "retryable_failure",
        action: "retry",
        reason: "report-only attempt finished but the preserved worktree could not be inspected",
        retryable: true,
        needsUser: false,
        confidence: hints.confidence ?? "high",
        attemptId: spec.attemptId,
        intentId: spec.intentId,
        status: "failed",
        ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
      };
    }
    if (repoChangedFiles.length > 0) {
      return {
        outcome: "retryable_failure",
        action: "retry",
        reason: "report-only attempt modified repository files outside the reserved output directory",
        retryable: true,
        needsUser: false,
        confidence: hints.confidence ?? "high",
        attemptId: spec.attemptId,
        intentId: spec.intentId,
        status: "failed",
        ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
      };
    }
    if (outputArtifacts.length === 0) {
      return {
        outcome: "incomplete_needs_follow_up",
        action: "follow_up",
        reason: "report-only attempt completed without any harvested output artifacts",
        retryable: false,
        needsUser: false,
        confidence: hints.confidence ?? "medium",
        attemptId: spec.attemptId,
        intentId: spec.intentId,
        status: executionResult.status,
        ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
      };
    }
    return {
      outcome: "success",
      action: "accept",
      reason: `harvested ${outputArtifacts.length} report artifact${outputArtifacts.length === 1 ? "" : "s"}`,
      retryable: false,
      needsUser: false,
      confidence: hints.confidence ?? "high",
      attemptId: spec.attemptId,
      intentId: spec.intentId,
      status: executionResult.status,
      ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
    };
  }

  if (
    profile?.sandboxLifecycle === "preserved" &&
    profile.mergeStrategy !== "none" &&
    spec.taskKind === "assistant_job" &&
    checksOk &&
    exitOk &&
    executionResult.status === "succeeded"
  ) {
    if (inspection === undefined || inspection === null) {
      return {
        outcome: "retryable_failure",
        action: "retry",
        reason: "code-changing attempt finished but the preserved worktree could not be inspected",
        retryable: true,
        needsUser: false,
        confidence: hints.confidence ?? "high",
        attemptId: spec.attemptId,
        intentId: spec.intentId,
        status: "failed",
        ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
      };
    }
    if (repoChangedFiles.length === 0) {
      const reason =
        outputArtifacts.length > 0
          ? "attempt completed but only reserved-output artifacts changed; no repository files were modified"
          : "attempt completed but no repository files were modified";
      return {
        outcome: "retryable_failure",
        action: "retry",
        reason,
        retryable: true,
        needsUser: false,
        confidence: hints.confidence ?? "high",
        attemptId: spec.attemptId,
        intentId: spec.intentId,
        status: "failed",
        ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
      };
    }
    const changeSummary = `modified ${repoChangedFiles.length} file${repoChangedFiles.length === 1 ? "" : "s"}`;
    if (profile.mergeStrategy === "interactive") {
      return {
        outcome: "blocked_needs_user",
        action: "ask_user",
        reason: `${changeSummary}; candidate preserved for merge or discard`,
        retryable: false,
        needsUser: true,
        confidence: hints.confidence ?? "high",
        attemptId: spec.attemptId,
        intentId: spec.intentId,
        status: "blocked",
        ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
      };
    }
    return {
      outcome: "success",
      action: "accept",
      reason: mergeResult?.merged === true ? `${changeSummary}; auto-merge succeeded` : changeSummary,
      retryable: false,
      needsUser: false,
      confidence: hints.confidence ?? "high",
      attemptId: spec.attemptId,
      intentId: spec.intentId,
      status: executionResult.status,
      ...(executionResult.checkResults ? { checkResults: executionResult.checkResults } : {}),
    };
  }

  if (checksOk && exitOk && executionResult.status === "succeeded") {
    return {
      outcome: "success",
      action: "accept",
      reason: "all acceptance checks passed and exit code is 0",
      retryable: false,
      needsUser: false,
      confidence: hints.confidence ?? "high",
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

// ---------------------------------------------------------------------------
// Phase 4 PR5 — structured ReviewInputs + confidence/remediation outputs
// ---------------------------------------------------------------------------

/**
 * Rich review inputs for {@link reviewAttemptWithInputs}. Bundles everything
 * the reviewer needs to grade confidence and draft a user-facing explanation:
 * the persisted attempt, the spec it ran against, the raw execution result,
 * the artifacts it produced, the approvals recorded on this turn, and the
 * derived retry lineage.
 *
 * NOTE: `provenance` is intentionally omitted. PR2's `ProvenanceRecord` type
 * is not on `main` yet; a follow-up can extend this record with an optional
 * `provenance?: ProvenanceRecord` once PR2 merges. Adding a new optional
 * field is not a breaking change.
 */
export type ReviewInputs = {
  attempt: SessionAttemptRecord;
  attemptSpec: AttemptSpec;
  executionResult: AttemptExecutionResult;
  artifacts: ArtifactRecord[];
  approvals: ApprovalRecord[];
  lineage: AttemptLineage;
};

/**
 * Extended review output that layers PR5's confidence grade, plain-language
 * explanation, and (when retry is suggested) a remediation hint on top of the
 * existing {@link ReviewedAttemptResult}. The existing fields keep their
 * shape so callers that don't care about the PR5 additions can ignore them.
 */
export type ReviewedOutputs = ReviewedAttemptResult & {
  /** PR5 confidence grade — see {@link ReviewConfidence}. */
  confidence: ReviewConfidence;
  /** 1-3 sentence plain-language summary for inspect/narration surfaces. */
  userExplanation: string;
  /** Present only when `action === "retry"` (or a future `"retry_refine"`). */
  remediationHint?: string;
};

/** Denied-ish approval decisions. */
const isDeniedApproval = (record: ApprovalRecord): boolean =>
  record.decision === "denied" || record.decision === "auto_denied";

/** Ask-ish approval decisions. */
const isAskApproval = (record: ApprovalRecord): boolean =>
  record.decidedBy === "user_prompt" || record.decidedBy === "hook_sync";

/**
 * Grade review confidence from structured inputs. See the type doc for the
 * rules. Order matters: low > high > medium (any low-confidence signal wins).
 */
const gradeConfidence = (
  classification: ReviewClassification,
  inputs: ReviewInputs,
): ReviewConfidence => {
  const { executionResult, approvals, lineage } = inputs;
  const hasDenied = approvals.some(isDeniedApproval);
  const execFailed = executionResult.status === "failed" || executionResult.status === "blocked";
  if (execFailed || hasDenied || lineage.depth > 2) {
    return "low";
  }
  const allChecksOk =
    classification.outcome === "success" &&
    (executionResult.checkResults === undefined ||
      executionResult.checkResults.every((check) => check.passed));
  const hasAskThisTurn = approvals.some(isAskApproval);
  if (allChecksOk && !hasAskThisTurn && lineage.depth === 0) {
    return "high";
  }
  return "medium";
};

/** Find the first failing check, if any. */
const firstFailingCheck = (executionResult: AttemptExecutionResult): CheckResult | undefined =>
  (executionResult.checkResults ?? []).find((check) => !check.passed);

/** Find the deny rule surfaced on this turn, if any. */
const deniedRule = (approvals: ApprovalRecord[]): PermissionRule | undefined => {
  const denied = approvals.find(isDeniedApproval);
  return denied?.matchedRule;
};

/**
 * Best-effort log-artifact name for a failing check. Prefers an artifact
 * whose name references the check's checkId/label; falls back to the first
 * `log` kind artifact; finally returns a conventional placeholder.
 */
const logArtifactName = (check: CheckResult | undefined, artifacts: ArtifactRecord[]): string => {
  const checkId = check?.checkId;
  if (checkId !== undefined) {
    const match = artifacts.find(
      (artifact) => artifact.kind === "log" && artifact.name.includes(checkId),
    );
    if (match !== undefined) {
      return match.name;
    }
  }
  const anyLog = artifacts.find((artifact) => artifact.kind === "log");
  if (anyLog !== undefined) {
    return anyLog.name;
  }
  return "worker-output.log";
};

/** Render a command array (or single string) for inclusion in text. */
const formatCommand = (command: readonly string[] | undefined): string => {
  if (command === undefined || command.length === 0) {
    return "the acceptance check";
  }
  return command.join(" ");
};

/**
 * Build the 1-3 sentence user explanation for a review. Templated from the
 * classification outcome + structured evidence. See the PR brief for the
 * phrasing rules.
 */
const buildUserExplanation = (
  classification: ReviewClassification,
  inputs: ReviewInputs,
): string => {
  const { executionResult, attemptSpec, approvals } = inputs;
  switch (classification.outcome) {
    case "success": {
      const total = attemptSpec.acceptanceChecks.length;
      const passed = (executionResult.checkResults ?? []).filter((check) => check.passed).length;
      const reportedPassed = executionResult.checkResults === undefined ? total : passed;
      return `Attempt completed. Checks passed: ${reportedPassed}/${total}.`;
    }
    case "policy_denied": {
      const rule = deniedRule(approvals);
      const pattern = rule?.pattern ?? classification.reason;
      return `Blocked: ${pattern} matched.`;
    }
    case "blocked_needs_user": {
      return "Waiting on user input.";
    }
    case "retryable_failure":
    case "incomplete_needs_follow_up": {
      const failing = firstFailingCheck(executionResult);
      const label =
        failing !== undefined
          ? (attemptSpec.acceptanceChecks.find((check) => check.checkId === failing.checkId)
              ?.label ?? failing.checkId)
          : "execution";
      const exitCode =
        failing?.exitCode ??
        (typeof executionResult.exitCode === "number" ? executionResult.exitCode : undefined);
      const exitText = exitCode === undefined ? "" : ` (exit ${exitCode})`;
      return `Attempt failed at ${label}${exitText}. ${classification.reason}.`;
    }
    default: {
      return classification.reason;
    }
  }
};

/**
 * Build the optional remediation hint. Surfaced whenever the review implies
 * the user needs to act on a signal they can influence:
 *
 * 1. A denied approval — regardless of classifier action — produces the
 *    approval-denied hint so the user knows which rule pattern to avoid.
 * 2. A retry-style action with a failing acceptance check produces the
 *    "rerun the check, read the log" hint.
 *
 * All other cases (clean success, plain blocked_needs_user, incomplete
 * follow-ups without a failing check) return `undefined`.
 */
const buildRemediationHint = (
  classification: ReviewClassification,
  inputs: ReviewInputs,
): string | undefined => {
  const deniedApproval = inputs.approvals.find(isDeniedApproval);
  if (deniedApproval !== undefined) {
    return `Approval was denied for \`${deniedApproval.matchedRule.pattern}\`. Rework the approach to avoid that pattern.`;
  }
  if (classification.action !== "retry") {
    return undefined;
  }
  const failing = firstFailingCheck(inputs.executionResult);
  if (failing !== undefined) {
    const specCheck = inputs.attemptSpec.acceptanceChecks.find(
      (check) => check.checkId === failing.checkId,
    );
    const commandText = formatCommand(specCheck?.command);
    const logName = logArtifactName(failing, inputs.artifacts);
    return `Rerun \`${commandText}\` and investigate the output in artifact \`${logName}\`.`;
  }
  return undefined;
};

/**
 * Phase 4 PR5 entry point. Given a structured {@link ReviewInputs} bundle,
 * run the Phase 3 {@link reviewAttemptResult} logic, then refine the
 * confidence grade from approvals + lineage and attach a user-facing
 * explanation plus an optional remediation hint.
 *
 * Callers that only have the Phase 3 inputs should keep using
 * {@link reviewAttemptResult}; the new API is additive for now and PR4/PR7
 * will switch the dispatch path over once the inspect tabs are built.
 */
export const reviewAttemptWithInputs = (inputs: ReviewInputs): ReviewedOutputs => {
  const policyDenied = inputs.approvals.some(isDeniedApproval);
  const hints: ReviewClassifierHints = policyDenied ? { policyDenied: true } : {};
  const base = reviewAttemptResult(inputs.attemptSpec, inputs.executionResult, hints);
  const confidence = gradeConfidence(base, inputs);
  const userExplanation = buildUserExplanation(base, inputs);
  const remediationHint = buildRemediationHint(base, inputs);
  return {
    ...base,
    confidence,
    userExplanation,
    ...(remediationHint === undefined ? {} : { remediationHint }),
  };
};
