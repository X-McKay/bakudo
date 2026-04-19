import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type { ReviewClassification } from "../resultClassifier.js";
import type { SessionStatus, SessionTurnRecord } from "../sessionTypes.js";
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

export const sessionStatusFromReview = (reviewed: ReviewClassification): SessionStatus => {
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
