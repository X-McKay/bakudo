/**
 * Wave 5: Synthesizer Runner — Parallel Merge Agent
 *
 * The Synthesizer runs when a Campaign's CandidateSet produces two or more
 * successful Candidates. Instead of discarding the extra winners, the
 * Synthesizer reads each winning diff and produces a single unified result
 * that takes the best ideas from each.
 *
 * Synthesizer output protocol:
 * - Normal case: a unified diff combining the best of all winners.
 * - Single-winner shortcut: "USE_CANDIDATE: <id>" — synthesis not beneficial.
 * - Manual review required: "MANUAL_REVIEW_REQUIRED" — conflicting approaches
 *   that require human judgment. The Campaign is marked completed but queued
 *   for review. The system MUST NOT auto-merge in this case.
 *
 * Security note: the Synthesizer has `git-write` policy to commit the merged
 * result, but MUST NEVER push or merge PRs.
 */
import { providerRegistry } from "../host/providerRegistry.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

// ---------------------------------------------------------------------------
// Synthesizer prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt injected as stdin for the Synthesizer agent.
 */
export const SYNTHESIZER_PROMPT = `
You are the Synthesizer. Multiple Candidates succeeded in parallel.
You have read access to each Candidate's final worktree.
Your job is to produce ONE unified diff that takes the best idea from each.

Rules:
- If two Candidates chose conflicting approaches for the same sub-problem, pick the one with better test coverage or shorter code (in that order).
- If they took complementary approaches (e.g., A improved perf, B improved errors), combine them.
- The final diff MUST pass all tests from all winning Candidates.
- If synthesis is not beneficial (one Candidate is strictly better), output exactly: "USE_CANDIDATE: <id>" and stop.
- If the diffs conflict in a way that requires human judgment, output exactly: "MANUAL_REVIEW_REQUIRED" and stop.
`.trim();

// ---------------------------------------------------------------------------
// Synthesizer runner
// ---------------------------------------------------------------------------

/**
 * Build the {@link TaskRunnerCommand} for the Synthesizer merge agent.
 *
 * @param winningCandidateIds  IDs of all successful Candidates in the CandidateSet.
 */
export const runSynthesizer = (winningCandidateIds: string[]): TaskRunnerCommand => {
  const provider = providerRegistry.get("synthesizer");

  const stdin = [
    SYNTHESIZER_PROMPT,
    "",
    "WINNING_CANDIDATES:",
    ...winningCandidateIds,
  ].join("\n");

  return {
    command: provider.command,
    stdin,
    env: {
      BAKUDO_SYNTHESIZER_MODE: "1",
    },
  };
};

// ---------------------------------------------------------------------------
// Synthesis record
// ---------------------------------------------------------------------------

/**
 * A record of a Synthesizer run, stored on the Campaign for observability.
 */
export interface SynthesisRecord {
  /** IDs of the Candidates that were merged. */
  mergedFrom: string[];
  /** The Synthesizer's rationale for the merge (or the USE_CANDIDATE/MANUAL_REVIEW verdict). */
  rationale: string;
  /** The ID of the winning Candidate if the Synthesizer chose a single winner. */
  useCandidateId?: string;
  /** True if the Synthesizer requested manual review. */
  manualReviewRequired?: boolean;
}

// ---------------------------------------------------------------------------
// Synthesis output parsing
// ---------------------------------------------------------------------------

/**
 * Parse the Synthesizer's output to determine the synthesis outcome.
 *
 * @returns A {@link SynthesisRecord} describing the outcome.
 */
export const parseSynthesizerOutput = (
  output: string,
  winningCandidateIds: string[],
): SynthesisRecord => {
  const trimmed = output.trim();

  // Check for single-winner shortcut: "USE_CANDIDATE: <id>"
  const useCandidateMatch = trimmed.match(/^USE_CANDIDATE:\s*(.+)$/m);
  if (useCandidateMatch) {
    const useCandidateId = useCandidateMatch[1]?.trim();
    const record: SynthesisRecord = {
      mergedFrom: winningCandidateIds,
      rationale: trimmed,
    };
    if (useCandidateId !== undefined) {
      record.useCandidateId = useCandidateId;
    }
    return record;
  }

  // Check for manual review required
  if (trimmed.includes("MANUAL_REVIEW_REQUIRED")) {
    return {
      mergedFrom: winningCandidateIds,
      rationale: trimmed,
      manualReviewRequired: true,
    };
  }

  // Normal synthesis: unified diff output
  return {
    mergedFrom: winningCandidateIds,
    rationale: trimmed,
  };
};

/**
 * Determine whether a Synthesizer output is a single-winner shortcut.
 */
export const isSingleWinnerShortcut = (output: string): boolean => {
  return /^USE_CANDIDATE:\s*.+$/m.test(output.trim());
};

/**
 * Determine whether a Synthesizer output requires manual review.
 */
export const isManualReviewRequired = (output: string): boolean => {
  return output.includes("MANUAL_REVIEW_REQUIRED");
};

/**
 * Extract the candidate ID from a USE_CANDIDATE shortcut output.
 * Returns `null` if the output is not a USE_CANDIDATE shortcut.
 */
export const extractUseCandidateId = (output: string): string | null => {
  const match = output.trim().match(/^USE_CANDIDATE:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
};
