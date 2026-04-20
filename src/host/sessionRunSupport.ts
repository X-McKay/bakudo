import { access, constants } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type { ReviewClassification } from "../resultClassifier.js";
import type { CandidateState, SessionStatus, SessionTurnRecord, TurnStatus } from "../sessionTypes.js";
import { dim, renderSection } from "./ansi.js";
import type { EventLogWriter } from "./eventLogWriter.js";
import { runtimeIo } from "./io.js";
import type { HostCliArgs } from "./parsing.js";

export type EventLogWriterFactory = (storageRoot: string, sessionId: string) => EventLogWriter;

export const storageRootFor = (
  repo: string | undefined,
  explicitRoot: string | undefined,
): string =>
  explicitRoot !== undefined ? resolve(explicitRoot) : resolve(repo ?? ".", ".bakudo", "sessions");

export const repoRootFor = (repo: string | undefined): string => resolve(repo ?? ".");

const localAboxCandidatesFor = (repoRoot: string): string[] => {
  const workspaceCandidate = resolve(repoRoot, "abox", "target", "release", "abox");
  const siblingCandidate = resolve(repoRoot, "..", "abox", "target", "release", "abox");
  return basename(repoRoot) === "bakudo"
    ? [siblingCandidate, workspaceCandidate]
    : [workspaceCandidate, siblingCandidate];
};

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve the effective abox binary for local development. The parser keeps
 * the stable default `abox`; the host runtime upgrades that sentinel to the
 * checked-in sibling build when the documented workspace layout is present.
 */
export const resolveEffectiveAboxBin = async (
  repo: string | undefined,
  aboxBin: string,
): Promise<string> => {
  if (aboxBin !== "abox") {
    return aboxBin;
  }
  const repoRoot = repoRootFor(repo);
  for (const candidate of localAboxCandidatesFor(repoRoot)) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return aboxBin;
};

export const resolveRuntimeHostArgs = async (args: HostCliArgs): Promise<HostCliArgs> => {
  const aboxBin = await resolveEffectiveAboxBin(args.repo, args.aboxBin);
  return aboxBin === args.aboxBin ? args : { ...args, aboxBin };
};

export const sessionStatusFromReview = (
  reviewed: ReviewClassification,
  candidateState?: CandidateState,
): SessionStatus => {
  if (candidateState === "candidate_ready") {
    return reviewed.action === "ask_user" ? "awaiting_user" : "reviewing";
  }
  if (
    candidateState === "apply_staging" ||
    candidateState === "apply_verifying" ||
    candidateState === "apply_writeback"
  ) {
    return "reviewing";
  }
  if (candidateState === "needs_confirmation") {
    return "awaiting_user";
  }
  if (candidateState === "applied") {
    return "completed";
  }
  if (candidateState === "apply_failed") {
    return "failed";
  }
  if (candidateState === "discarded") {
    return "cancelled";
  }
  if (reviewed.outcome === "success") {
    return "completed";
  }
  if (reviewed.outcome === "blocked_needs_user") {
    return "awaiting_user";
  }
  if (reviewed.outcome === "policy_denied") {
    return "blocked";
  }
  if (reviewed.outcome === "incomplete_needs_follow_up") {
    return "reviewing";
  }
  return "failed";
};

export const turnStatusFromReview = (
  reviewed: ReviewClassification,
  candidateState?: CandidateState,
): TurnStatus => {
  if (candidateState === "candidate_ready") {
    return reviewed.action === "ask_user" ? "awaiting_user" : "reviewing";
  }
  if (
    candidateState === "apply_staging" ||
    candidateState === "apply_verifying" ||
    candidateState === "apply_writeback"
  ) {
    return "reviewing";
  }
  if (candidateState === "needs_confirmation") {
    return "awaiting_user";
  }
  if (candidateState === "applied") {
    return "completed";
  }
  if (candidateState === "apply_failed") {
    return "failed";
  }
  if (candidateState === "discarded") {
    return "cancelled";
  }
  if (reviewed.outcome === "success") {
    return "completed";
  }
  if (reviewed.outcome === "blocked_needs_user") {
    return "awaiting_user";
  }
  if (reviewed.outcome === "policy_denied") {
    return "failed";
  }
  if (reviewed.outcome === "incomplete_needs_follow_up") {
    return "reviewing";
  }
  return "failed";
};

export const requiresSandboxApproval = (args: HostCliArgs): boolean => args.mode === "build";

export const promptForApproval = async (message: string): Promise<boolean> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const prompt = `${renderSection("Approval")} ${message} ${dim("[y/N]")} `;
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

const nowIso = (): string => new Date().toISOString();

export const makeInitialTurn = (
  turnId: string,
  prompt: string,
  mode: string,
): SessionTurnRecord => ({
  turnId,
  prompt,
  mode,
  status: "queued",
  attempts: [],
  createdAt: nowIso(),
  updatedAt: nowIso(),
});
