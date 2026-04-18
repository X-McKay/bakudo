import { readFile } from "node:fs/promises";

import type { SessionEventEnvelope } from "../protocol.js";
import type { SessionRecord, SessionAttemptRecord, SessionTurnRecord } from "../sessionTypes.js";
import { SessionStore } from "../sessionStore.js";
import { eventLogFilePath, readSessionEventLog } from "./eventLogWriter.js";
import { listArtifactRecords, type ArtifactRecord } from "./artifactStore.js";
import type { SessionSummaryView } from "./sessionIndex.js";

/**
 * Canonical timeline query surface for the session storage layer.
 *
 * All functions accept `storageRoot` (the `.bakudo/sessions/` root) and
 * return `null` / `[]` for missing data instead of throwing — consumers
 * should treat missing-data as "not yet available" rather than a hard error.
 *
 * PR3 skeleton provided `loadEventLog` + `readSessionEventLog`; PR4 extends
 * this with `listSessionSummaries`, `loadSession`, `loadTurn`,
 * `listTurnEvents`, `listTurnArtifacts`, `getLatestTurn`, and
 * `getLatestAttempt`.
 */

// ---------------------------------------------------------------------------
// Re-export the PR3 surface so callers can import everything from timeline.
// ---------------------------------------------------------------------------

export type LoadedEventLog = {
  envelopes: SessionEventEnvelope[];
  malformedLineCount: number;
};

/**
 * Read the per-session event NDJSON, separating successfully parsed
 * envelopes from malformed/unparseable lines. Missing file returns
 * `{ envelopes: [], malformedLineCount: 0 }`.
 */
export const loadEventLog = async (
  storageRoot: string,
  sessionId: string,
): Promise<LoadedEventLog> => {
  const filePath = eventLogFilePath(storageRoot, sessionId);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { envelopes: [], malformedLineCount: 0 };
    }
    throw error;
  }
  const envelopes: SessionEventEnvelope[] = [];
  let malformedLineCount = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      envelopes.push(JSON.parse(line) as SessionEventEnvelope);
    } catch {
      malformedLineCount += 1;
    }
  }
  return { envelopes, malformedLineCount };
};

export { readSessionEventLog };

// ---------------------------------------------------------------------------
// Session-level queries (delegates to SessionStore)
// ---------------------------------------------------------------------------

/**
 * List lightweight session summaries, sorted newest-first by `updatedAt`.
 * Uses the fast-path session index when available; falls back to a
 * directory scan via {@link SessionStore.listSessions}.
 */
export const listSessionSummaries = async (storageRoot: string): Promise<SessionSummaryView[]> => {
  const store = new SessionStore(storageRoot);
  return store.listSessions();
};

/**
 * Load the full `SessionRecord` for a given session. Returns `null` when
 * the session directory or file does not exist.
 */
export const loadSession = async (
  storageRoot: string,
  sessionId: string,
): Promise<SessionRecord | null> => {
  const store = new SessionStore(storageRoot);
  return store.loadSession(sessionId);
};

// ---------------------------------------------------------------------------
// Turn-level queries
// ---------------------------------------------------------------------------

/**
 * Load a single turn by `(sessionId, turnId)`. Returns `null` if the
 * session does not exist or no turn matches the given turnId.
 */
export const loadTurn = async (
  storageRoot: string,
  sessionId: string,
  turnId: string,
): Promise<SessionTurnRecord | null> => {
  const session = await loadSession(storageRoot, sessionId);
  if (session === null) {
    return null;
  }
  return session.turns.find((turn) => turn.turnId === turnId) ?? null;
};

/**
 * Return the most recent turn for a session. Returns `null` when the
 * session does not exist or has no turns yet.
 */
export const getLatestTurn = async (
  storageRoot: string,
  sessionId: string,
): Promise<SessionTurnRecord | null> => {
  const session = await loadSession(storageRoot, sessionId);
  if (session === null) {
    return null;
  }
  return session.turns.at(-1) ?? null;
};

/**
 * Return the most recent attempt within a turn. Returns `null` when the
 * session/turn does not exist or the turn has no attempts.
 */
export const getLatestAttempt = async (
  storageRoot: string,
  sessionId: string,
  turnId: string,
): Promise<SessionAttemptRecord | null> => {
  const turn = await loadTurn(storageRoot, sessionId, turnId);
  if (turn === null) {
    return null;
  }
  return turn.attempts.at(-1) ?? null;
};

// ---------------------------------------------------------------------------
// Event + artifact queries (filtered by turn)
// ---------------------------------------------------------------------------

/**
 * Load all v2 event envelopes for a given turn, preserving NDJSON write
 * order. Loads the full session event log and filters by `turnId`.
 */
export const listTurnEvents = async (
  storageRoot: string,
  sessionId: string,
  turnId: string,
): Promise<SessionEventEnvelope[]> => {
  const envelopes = await readSessionEventLog(storageRoot, sessionId);
  return envelopes.filter((envelope) => envelope.turnId === turnId);
};

/**
 * Load all v2 artifact records for a given turn from the per-session
 * `artifacts.ndjson` log. Returns `[]` when the file does not exist (old
 * sessions without a v2 log, or sessions with no artifacts yet).
 */
export const listTurnArtifacts = async (
  storageRoot: string,
  sessionId: string,
  turnId: string,
): Promise<ArtifactRecord[]> => {
  const records = await listArtifactRecords(storageRoot, sessionId);
  return records.filter((record) => record.turnId === turnId);
};
