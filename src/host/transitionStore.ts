import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createSessionPaths } from "../sessionStore.js";
import type { TurnStatus } from "../sessionTypes.js";

export type TurnTransitionReason =
  | "next_turn"
  | "user_retry"
  | "host_retry"
  | "recovery_required"
  | "approval_denied_retry"
  | "protocol_mismatch_recovery";

export type TurnTransition = {
  transitionId: string;
  sessionId: string;
  turnId: string;
  fromStatus: TurnStatus;
  toStatus: TurnStatus;
  reason: TurnTransitionReason;
  chainId: string;
  depth: number;
  timestamp: string;
};

const TRANSITIONS_FILE_NAME = "transitions.ndjson";

export const transitionsFilePath = (storageRoot: string, sessionId: string): string =>
  join(createSessionPaths(storageRoot, sessionId).sessionDir, TRANSITIONS_FILE_NAME);

/**
 * Append a single TurnTransition to the per-session append-only NDJSON log.
 * Creates the session directory and log file on first write. Atomic w.r.t.
 * a single line per call: the underlying `appendFile` open-write-close
 * cycle will not interleave partial lines from concurrent calls within
 * this process, but consumers should still expect eventual ordering
 * rather than strict causal ordering across distinct hosts.
 */
export const appendTurnTransition = async (
  storageRoot: string,
  sessionId: string,
  transition: TurnTransition,
): Promise<void> => {
  const filePath = transitionsFilePath(storageRoot, sessionId);
  await mkdir(dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(transition)}\n`;
  await writeFile(filePath, line, { encoding: "utf8", flag: "a" });
};

/**
 * Read the append-only transitions log for a session. Returns `[]` if the
 * file does not yet exist; skips blank lines; bubbles up any other error.
 */
export const listTurnTransitions = async (
  storageRoot: string,
  sessionId: string,
): Promise<TurnTransition[]> => {
  const filePath = transitionsFilePath(storageRoot, sessionId);
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TurnTransition);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

/**
 * Locate the most recent transition for a given turn so retry callers can
 * extend its chain. Returns `null` if the log is empty or no transition
 * targets the turn.
 */
export const findLatestTurnTransition = async (
  storageRoot: string,
  sessionId: string,
  turnId: string,
): Promise<TurnTransition | null> => {
  const transitions = await listTurnTransitions(storageRoot, sessionId);
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const entry = transitions[index];
    if (entry !== undefined && entry.turnId === turnId) {
      return entry;
    }
  }
  return null;
};

const createTransitionId = (): string => `transition-${Date.now()}-${randomUUID().slice(0, 8)}`;

export const createChainId = (): string => `chain-${Date.now()}-${randomUUID().slice(0, 8)}`;

export type EmitTurnTransitionInput = {
  storageRoot: string;
  sessionId: string;
  turnId: string;
  fromStatus: TurnStatus;
  toStatus: TurnStatus;
  reason: TurnTransitionReason;
  chainId?: string;
  depth?: number;
};

/**
 * Create and persist a single {@link TurnTransition}. Callers starting a
 * new chain (new turn) omit `chainId`; callers extending a chain (retry)
 * pass the prior `chainId` and the next `depth`. Returns the persisted
 * record so the caller can continue the chain without re-reading the log.
 */
export const emitTurnTransition = async (
  input: EmitTurnTransitionInput,
): Promise<TurnTransition> => {
  const transition: TurnTransition = {
    transitionId: createTransitionId(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    chainId: input.chainId ?? createChainId(),
    depth: input.depth ?? 0,
    timestamp: new Date().toISOString(),
  };
  await appendTurnTransition(input.storageRoot, input.sessionId, transition);
  return transition;
};
