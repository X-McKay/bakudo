import type { TaskResult } from "./protocol.js";

export type ReviewedOutcome =
  | "success"
  | "retryable_failure"
  | "blocked_needs_user"
  | "policy_denied"
  | "incomplete_needs_follow_up";

export type ReviewAction = "accept" | "retry" | "ask_user" | "halt" | "follow_up";

/**
 * Phase 4 PR5 review confidence grade. Summarizes how much corroborating
 * evidence the classifier has for its verdict. Downstream surfaces (inspect,
 * narration) render this as a human-readable chip next to the outcome.
 *
 * - `high`: clean success with no recent retry/ask/deny signals.
 * - `low`: execution failed/blocked, an approval was denied on this turn, or
 *   the turn is already several retries deep.
 * - `medium`: the ambiguous middle — success with minor friction, or a
 *   failure without strong retry-loop signals.
 */
export type ReviewConfidence = "low" | "medium" | "high";

export type ReviewClassification = {
  outcome: ReviewedOutcome;
  action: ReviewAction;
  reason: string;
  retryable: boolean;
  needsUser: boolean;
  /**
   * Phase 4 PR5: coarse-grained grade on the classification. Populated by
   * {@link classifyReviewedOutcome} with a default of `"medium"` for
   * callers that do not pass corroborating evidence (approvals, lineage).
   * Callers that have richer inputs should prefer
   * {@link import("./reviewer.js").reviewAttemptWithInputs} which refines
   * the confidence grade from evidence.
   */
  confidence: ReviewConfidence;
};

export type ReviewClassifierHints = {
  policyDenied?: boolean;
  retryableExitCodes?: readonly number[];
  /**
   * Phase 4 PR5 (optional): explicit override for the
   * {@link ReviewClassification.confidence} field. Callers with richer
   * context (approvals, lineage) can pre-compute a grade and pass it in
   * rather than accepting the classifier's default heuristic. Existing
   * callers that omit it get `"medium"` on any non-success outcome and
   * `"high"` on a clean `success` — neither of which requires them to
   * change their call sites.
   */
  confidence?: ReviewConfidence;
};

const DEFAULT_RETRYABLE_EXIT_CODES = new Set([124, 137, 143]);

const POLICY_DENIED_MARKERS = [
  "policy denied",
  "denied by policy",
  "blocked by policy",
  "policy blocked",
  "not allowed",
  "not permitted",
  "forbidden",
  "unauthorized",
  "unauthorised",
  "escalation denied",
  "approval denied",
] as const;

const BLOCKED_MARKERS = [
  "blocked",
  "blocked by dependency",
  "waiting for approval",
  "approval required",
  "needs approval",
  "requires approval",
  "waiting for user",
  "requires user",
  "user action required",
  "awaiting user",
] as const;

const INCOMPLETE_MARKERS = [
  "incomplete",
  "partial",
  "truncated",
  "unfinished",
  "aborted",
  "cancelled",
  "canceled",
  "needs review",
  "review required",
  "follow up",
  "follow-up",
  "needs follow up",
  "needs follow-up",
] as const;

const RETRYABLE_MARKERS = [
  "timeout",
  "timed out",
  "temporary",
  "transient",
  "retry",
  "rate limit",
  "too many requests",
  "connection reset",
  "connection refused",
  "service unavailable",
  "busy",
  "econnreset",
  "econnrefused",
  "etimedout",
  "ehostunreach",
  "enetunreach",
] as const;

const normalizeEvidence = (result: TaskResult): string => {
  const artifactText = result.artifacts?.join(" ") ?? "";
  const exitCodeText = result.exitCode === undefined ? "" : String(result.exitCode);
  return [result.status, result.summary, exitCodeText, artifactText].join(" ").toLowerCase();
};

const includesAny = (evidence: string, markers: readonly string[]): boolean =>
  markers.some((marker) => evidence.includes(marker));

const retryableExitCodes = (hints: ReviewClassifierHints): ReadonlySet<number> => {
  if (hints.retryableExitCodes === undefined) {
    return DEFAULT_RETRYABLE_EXIT_CODES;
  }
  return new Set(hints.retryableExitCodes);
};

/**
 * Default {@link ReviewConfidence} for a classification result. Callers that
 * pass `hints.confidence` win. Otherwise a clean `success` is `"high"` and
 * everything else is `"medium"` — the reviewer layer refines `"low"` cases
 * where it has richer evidence (approvals, lineage).
 */
const defaultConfidenceFor = (
  outcome: ReviewedOutcome,
  hints: ReviewClassifierHints,
): ReviewConfidence => {
  if (hints.confidence !== undefined) {
    return hints.confidence;
  }
  return outcome === "success" ? "high" : "medium";
};

export const classifyReviewedOutcome = (
  result: TaskResult,
  hints: ReviewClassifierHints = {},
): ReviewClassification => {
  const evidence = normalizeEvidence(result);
  const retryableCodes = retryableExitCodes(hints);

  if (hints.policyDenied || includesAny(evidence, POLICY_DENIED_MARKERS)) {
    return {
      outcome: "policy_denied",
      action: "halt",
      reason: "task was denied by policy",
      retryable: false,
      needsUser: false,
      confidence: defaultConfidenceFor("policy_denied", hints),
    };
  }

  if (includesAny(evidence, BLOCKED_MARKERS) || result.status === "blocked") {
    return {
      outcome: "blocked_needs_user",
      action: "ask_user",
      reason: "task is blocked and needs user input or approval",
      retryable: false,
      needsUser: true,
      confidence: defaultConfidenceFor("blocked_needs_user", hints),
    };
  }

  if (result.status === "succeeded") {
    return {
      outcome: "success",
      action: "accept",
      reason: "task completed successfully",
      retryable: false,
      needsUser: false,
      confidence: defaultConfidenceFor("success", hints),
    };
  }

  const hasRetryableSignal =
    (typeof result.exitCode === "number" && retryableCodes.has(result.exitCode)) ||
    includesAny(evidence, RETRYABLE_MARKERS);

  if (result.status === "cancelled" || result.status === "needs_review") {
    if (hasRetryableSignal) {
      return {
        outcome: "retryable_failure",
        action: "retry",
        reason: "task stopped before completion, but the failure looks retryable",
        retryable: true,
        needsUser: false,
        confidence: defaultConfidenceFor("retryable_failure", hints),
      };
    }

    return {
      outcome: "incomplete_needs_follow_up",
      action: "follow_up",
      reason: "task did not finish and needs follow-up",
      retryable: false,
      needsUser: false,
      confidence: defaultConfidenceFor("incomplete_needs_follow_up", hints),
    };
  }

  if (
    includesAny(evidence, INCOMPLETE_MARKERS) ||
    result.exitCode === 126 ||
    result.exitCode === 127
  ) {
    return {
      outcome: "incomplete_needs_follow_up",
      action: "follow_up",
      reason: "task result looks incomplete and needs follow-up",
      retryable: false,
      needsUser: false,
      confidence: defaultConfidenceFor("incomplete_needs_follow_up", hints),
    };
  }

  if (hasRetryableSignal) {
    return {
      outcome: "retryable_failure",
      action: "retry",
      reason: "task failed, but the signal looks retryable",
      retryable: true,
      needsUser: false,
      confidence: defaultConfidenceFor("retryable_failure", hints),
    };
  }

  return {
    outcome: "retryable_failure",
    action: "retry",
    reason: "task failed",
    retryable: true,
    needsUser: false,
    confidence: defaultConfidenceFor("retryable_failure", hints),
  };
};
