import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import type { ComposerMode } from "./appState.js";
import type {
  SessionRecord,
  SessionReviewAction,
  SessionReviewOutcome,
  SessionStatus,
} from "../sessionTypes.js";

export const SESSION_INDEX_SCHEMA_VERSION = 2 as const;

const SESSION_INDEX_FILE_NAME = "index.json";

/**
 * Lightweight per-session summary stored in `.bakudo/sessions/index.json`.
 * Mirrors just enough of {@link SessionRecord} to drive listing, resume, and
 * status surfaces without loading per-session directories. The source of truth
 * is always the full session file; this index is a derived cache.
 */
export type SessionIndexEntry = {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  sessionId: string;
  title: string;
  repoRoot: string;
  status: SessionStatus;
  lastMode: ComposerMode;
  latestTurnId?: string;
  latestReviewedOutcome?: SessionReviewOutcome;
  latestReviewedAction?: SessionReviewAction;
  updatedAt: string;
};

export type SessionIndexFile = {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  entries: SessionIndexEntry[];
};

/**
 * The listing-oriented shape callers consume. Currently equals
 * {@link SessionIndexEntry} 1:1; aliased so future entry fields that are
 * persisted-only (e.g., bookkeeping) can be excluded from the consumer surface
 * without a breaking rename.
 */
export type SessionSummaryView = SessionIndexEntry;

const toResolvedPath = (rootDir: string): string =>
  isAbsolute(rootDir) ? rootDir : resolve(rootDir);

export const sessionIndexPath = (rootDir: string): string =>
  join(toResolvedPath(rootDir), SESSION_INDEX_FILE_NAME);

const MODE_VALUES: readonly ComposerMode[] = ["standard", "plan", "autopilot"];

const coerceComposerMode = (value: unknown): ComposerMode => {
  if (typeof value === "string" && (MODE_VALUES as readonly string[]).includes(value)) {
    return value as ComposerMode;
  }
  // Legacy worker TaskMode values produced by pre-composer-mode session files.
  if (value === "build") {
    return "standard";
  }
  return "standard";
};

/**
 * Pure function: construct an index entry from a loaded v2 session. No I/O.
 * Reads `turn.latestReview` (PR1) from the last turn when available so that
 * listing surfaces can render outcome/action hints without loading the session.
 */
export const buildIndexEntryFromSession = (session: SessionRecord): SessionIndexEntry => {
  const latestTurn = session.turns.at(-1);
  const latestReview = latestTurn?.latestReview;
  const lastMode = coerceComposerMode(latestTurn?.mode);
  const entry: SessionIndexEntry = {
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    sessionId: session.sessionId,
    title: session.title,
    repoRoot: session.repoRoot,
    status: session.status,
    lastMode,
    updatedAt: session.updatedAt,
  };
  if (latestTurn?.turnId !== undefined) {
    entry.latestTurnId = latestTurn.turnId;
  }
  if (latestReview !== undefined) {
    entry.latestReviewedOutcome = latestReview.outcome;
    entry.latestReviewedAction = latestReview.action;
  }
  return entry;
};

/**
 * Sort entries newest `updatedAt` first. Returns a new array; does not mutate.
 * `sessionId.localeCompare` breaks ties so ordering stays deterministic across
 * platforms when two sessions share an `updatedAt` string.
 */
export const sortIndexEntries = (
  entries: ReadonlyArray<SessionIndexEntry>,
): SessionIndexEntry[] => {
  const copy = [...entries];
  copy.sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt > right.updatedAt ? -1 : 1;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });
  return copy;
};

/** Zod schema for structural validation of index entries from disk. */
export const SessionIndexEntrySchema = z
  .object({
    schemaVersion: z.literal(SESSION_INDEX_SCHEMA_VERSION),
    sessionId: z.string(),
    title: z.string(),
    repoRoot: z.string(),
    status: z.string(),
    lastMode: z.string(),
    latestTurnId: z.string().optional(),
    latestReviewedOutcome: z.string().optional(),
    latestReviewedAction: z.string().optional(),
    updatedAt: z.string(),
  })
  .strip();

const isSessionIndexEntry = (value: unknown): value is SessionIndexEntry =>
  SessionIndexEntrySchema.safeParse(value).success;

/**
 * Read `.bakudo/sessions/index.json`. Returns `null` when missing, malformed,
 * or tagged with a schemaVersion this build does not understand. Callers treat
 * null as a signal to fall back to a directory scan and trigger a rebuild.
 */
export const loadSessionIndex = async (rootDir: string): Promise<SessionIndexFile | null> => {
  const filePath = sessionIndexPath(rootDir);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
  if (content.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const topLevel = z
    .object({
      schemaVersion: z.literal(SESSION_INDEX_SCHEMA_VERSION),
      entries: z.array(z.unknown()),
    })
    .safeParse(parsed);
  if (!topLevel.success) {
    return null;
  }
  const raw = topLevel.data;
  const entries: SessionIndexEntry[] = [];
  for (const candidate of raw.entries) {
    if (!isSessionIndexEntry(candidate)) {
      return null;
    }
    entries.push(candidate);
  }
  return {
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    entries: sortIndexEntries(entries),
  };
};
