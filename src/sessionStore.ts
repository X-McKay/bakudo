import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProtocolSchemaVersion, TaskProgressEvent } from "./protocol.js";
import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionStatus,
  SessionTurnRecord,
} from "./sessionTypes.js";
import { CURRENT_SESSION_SCHEMA_VERSION, deriveSessionTitle } from "./sessionTypes.js";
import { loadSessionRecord, normalizeV2Record } from "./sessionNormalize.js";
import {
  SESSION_INDEX_SCHEMA_VERSION,
  buildIndexEntryFromSession,
  loadSessionIndex,
  sessionIndexPath,
  sortIndexEntries,
  type SessionIndexEntry,
  type SessionSummaryView,
} from "./host/sessionIndex.js";
import { stderrWrite } from "./host/io.js";
import {
  SessionLockNotHeldError,
  acquireSessionLock,
  type AcquireLockOptions,
  type SessionLockHandle,
} from "./host/lockFile.js";

export type SessionStorePaths = {
  sessionId: string;
  sessionDir: string;
  sessionFile: string;
  eventsFile: string;
  artifactsDir: string;
  artifactsFile: string;
};

export type CreateSessionInput = {
  sessionId: string;
  /** Goal text — used to derive the session title via first turn prompt. */
  goal: string;
  repoRoot: string;
  /** @deprecated kept for migration callers; not stored on SessionRecord. */
  assumeDangerousSkipPermissions?: boolean;
  status?: SessionStatus;
  title?: string;
  turns?: SessionTurnRecord[];
  createdAt?: string;
  updatedAt?: string;
};

const SESSION_FILE_NAME = "session.json";
const EVENTS_FILE_NAME = "events.ndjson";
const ARTIFACTS_DIR_NAME = "artifacts";
const ARTIFACTS_FILE_NAME = "index.json";

const toResolvedPath = (rootDir: string): string =>
  isAbsolute(rootDir) ? rootDir : resolve(rootDir);

export const sanitizePathSegment = (segment: string): string =>
  segment.replace(/[\\/:\u0000<>*?"|]/g, "_");

export const createSessionPaths = (rootDir: string, sessionId: string): SessionStorePaths => {
  const baseDir = toResolvedPath(rootDir);
  const safeSessionId = sanitizePathSegment(sessionId);
  const sessionDir = join(baseDir, safeSessionId);

  return {
    sessionId,
    sessionDir,
    sessionFile: join(sessionDir, SESSION_FILE_NAME),
    eventsFile: join(sessionDir, EVENTS_FILE_NAME),
    artifactsDir: join(sessionDir, ARTIFACTS_DIR_NAME),
    artifactsFile: join(sessionDir, ARTIFACTS_DIR_NAME, ARTIFACTS_FILE_NAME),
  };
};

const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

const nowIso = (): string => new Date().toISOString();

const writeJsonAtomic = async (filePath: string, value: unknown): Promise<void> => {
  await ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp-${Date.now()}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const content = await readFile(filePath, "utf8");
    if (content.trim().length === 0) {
      return null;
    }
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

export { loadSessionRecord };

/**
 * Atomic write of `.bakudo/sessions/index.json` with entries sorted newest
 * first. Exposed for the scan-and-rebuild fallback in {@link SessionStore}
 * and for tests that want to pre-seed an index.
 */
export const writeSessionIndex = async (
  rootDir: string,
  entries: ReadonlyArray<SessionIndexEntry>,
): Promise<void> => {
  const filePath = sessionIndexPath(rootDir);
  const payload = {
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    entries: sortIndexEntries(entries),
  };
  await writeJsonAtomic(filePath, payload);
};

/**
 * Options for {@link SessionStore}. `enforceLock` toggles the Phase 6 W2
 * guard rail that rejects mutating writes performed without a held
 * per-session lock. Production entry points (`sessionController`) pass
 * `enforceLock: true`; the default is `false` so the existing test suite and
 * read-modify-write helpers that pre-date W2 keep working unmodified.
 *
 * The Hard Rule "writes to a session without a lock must fail clearly"
 * (plan 199) is satisfied by making every production caller opt in; the
 * knob itself exists to keep that transition low-risk.
 */
export type SessionStoreOptions = {
  /**
   * When `true`, mutating writes throw {@link SessionLockNotHeldError} unless
   * a lock handle has been acquired via {@link SessionStore.withLock} or
   * registered via {@link SessionStore.registerLock}. Default `false`.
   */
  enforceLock?: boolean;
};

export class SessionStore {
  public readonly rootDir: string;
  private readonly enforceLock: boolean;
  private readonly heldLocks = new Map<string, SessionLockHandle>();

  public constructor(rootDir: string, options: SessionStoreOptions = {}) {
    this.rootDir = toResolvedPath(rootDir);
    this.enforceLock = options.enforceLock === true;
  }

  public paths(sessionId: string): SessionStorePaths {
    return createSessionPaths(this.rootDir, sessionId);
  }

  /**
   * Acquire the per-session lock and run `fn` while holding it. The lock is
   * released on the async boundary regardless of whether `fn` throws.
   *
   * Callers that have already acquired a lock (e.g. `createAndRunFirstTurn`)
   * and are nesting store mutations inside it do NOT need to nest `withLock`
   * — the outer acquire already authorizes the writes. The store's lock
   * registry is keyed by session id so re-entrant acquires are merged.
   */
  public async withLock<T>(
    sessionId: string,
    fn: (handle: SessionLockHandle) => Promise<T>,
    options: AcquireLockOptions = {},
  ): Promise<T> {
    const existing = this.heldLocks.get(sessionId);
    if (existing !== undefined) {
      // Re-entrant acquire. The outer caller is responsible for release.
      return fn(existing);
    }
    const sessionDir = this.paths(sessionId).sessionDir;
    const handle = await acquireSessionLock(sessionId, sessionDir, options);
    this.heldLocks.set(sessionId, handle);
    try {
      return await fn(handle);
    } finally {
      this.heldLocks.delete(sessionId);
      await handle.release();
    }
  }

  /**
   * Register an externally-acquired lock handle so that subsequent writes on
   * this store instance pass the `assertLockHeld` guard without re-entering
   * `withLock`. Used by `sessionController` which needs to keep the lock
   * across multiple write batches (create session → dispatch → save review).
   * Returns an unregister callback that the caller must invoke after releasing
   * the lock via `handle.release()`.
   */
  public registerLock(handle: SessionLockHandle): () => void {
    this.heldLocks.set(handle.sessionId, handle);
    return () => {
      const current = this.heldLocks.get(handle.sessionId);
      if (current === handle) {
        this.heldLocks.delete(handle.sessionId);
      }
    };
  }

  /** Inspect whether the caller holds the lock for `sessionId` on this store. */
  public isLockHeld(sessionId: string): boolean {
    return this.heldLocks.has(sessionId);
  }

  /**
   * Guard rail: throws {@link SessionLockNotHeldError} when a mutating write
   * is attempted without a held lock + `enforceLock` is on. Stays a no-op
   * when enforcement is disabled (legacy compat).
   */
  private assertLockHeld(sessionId: string): void {
    if (!this.enforceLock) return;
    if (this.heldLocks.has(sessionId)) return;
    throw new SessionLockNotHeldError(sessionId);
  }

  public async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const turns = [...(input.turns ?? [])];
    const title =
      input.title ??
      deriveSessionTitle({
        sessionId: input.sessionId,
        goal: input.goal,
        turns,
      });
    const session: SessionRecord = {
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      sessionId: input.sessionId,
      repoRoot: input.repoRoot,
      title,
      status: input.status ?? "draft",
      turns,
      createdAt,
      updatedAt,
    };
    // Bootstrap write: no prior session exists, so `wx` on the lock file is
    // always uncontended. Auto-acquire a short-lived lock so the invariant
    // "every write happens under a lock" holds even on the first write.
    if (!this.enforceLock || this.heldLocks.has(session.sessionId)) {
      await this.saveSession(session);
      return session;
    }
    return this.withLock(session.sessionId, async () => {
      await this.saveSession(session);
      return session;
    });
  }

  public async loadSession(sessionId: string): Promise<SessionRecord | null> {
    const sessionFile = this.paths(sessionId).sessionFile;
    const raw = await readJsonFile<unknown>(sessionFile);
    if (raw === null) {
      return null;
    }
    return loadSessionRecord(raw);
  }

  /**
   * Return lightweight session summaries for listing/resume UIs. Fast path:
   * load `.bakudo/sessions/index.json` via {@link loadSessionIndex} and
   * return its entries (already sorted newest-first). Self-healing fallback:
   * if the index is missing or invalid, scan session directories, rebuild
   * the index from `buildIndexEntryFromSession`, write it, and return the
   * same entries. A one-line warning is emitted on stderr whenever the
   * rebuild path runs so operators notice persistent corruption.
   *
   * Returns `SessionSummaryView[]`. Callers that need the full
   * {@link SessionRecord} should follow up with {@link loadSession}.
   */
  public async listSessions(): Promise<SessionSummaryView[]> {
    const existing = await loadSessionIndex(this.rootDir);
    if (existing !== null) {
      return existing.entries;
    }
    return this.scanAndRebuildIndex();
  }

  private async scanAndRebuildIndex(): Promise<SessionIndexEntry[]> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<SessionRecord | null> => {
          const sessionFile = join(this.rootDir, entry.name, SESSION_FILE_NAME);
          const raw = await readJsonFile<unknown>(sessionFile);
          if (raw === null) {
            return null;
          }
          try {
            return loadSessionRecord(raw);
          } catch {
            return null;
          }
        }),
    );

    const records = sessions.filter((session): session is SessionRecord => session !== null);
    if (records.length === 0) {
      // Nothing to index, and no reason to leave a warning trail when a fresh
      // repo simply has no sessions yet.
      return [];
    }
    stderrWrite("[sessions] rebuilding index from directory scan\n");
    const rebuilt = sortIndexEntries(records.map(buildIndexEntryFromSession));
    await writeSessionIndex(this.rootDir, rebuilt);
    return rebuilt;
  }

  public async saveSession(record: SessionRecord): Promise<SessionRecord> {
    this.assertLockHeld(record.sessionId);
    const normalized = normalizeV2Record(record, { updatedAt: record.updatedAt ?? nowIso() });
    await writeJsonAtomic(this.paths(normalized.sessionId).sessionFile, normalized);
    await this.upsertIndexEntry(normalized);
    return normalized;
  }

  /**
   * Incremental upsert of the session summary index alongside a full-session
   * save. Reads current `index.json` (empty list when missing/corrupt — the
   * self-healing scan in {@link listSessions} rebuilds it on next read),
   * replaces-or-appends the entry for `record.sessionId`, re-sorts by
   * `updatedAt` descending, and atomic-writes the index.
   */
  private async upsertIndexEntry(record: SessionRecord): Promise<void> {
    const entry = buildIndexEntryFromSession(record);
    const existing = await loadSessionIndex(this.rootDir);
    const entries = existing === null ? [] : [...existing.entries];
    const index = entries.findIndex((candidate) => candidate.sessionId === entry.sessionId);
    if (index === -1) {
      entries.push(entry);
    } else {
      entries[index] = entry;
    }
    await writeSessionIndex(this.rootDir, entries);
  }

  public async upsertTurn(
    sessionId: string,
    turnRecord: SessionTurnRecord,
  ): Promise<SessionRecord> {
    const session = await this.loadSession(sessionId);
    if (session === null) {
      throw new Error(`cannot upsert turn for missing session: ${sessionId}`);
    }
    const turns = [...session.turns];
    const existingIndex = turns.findIndex((turn) => turn.turnId === turnRecord.turnId);
    if (existingIndex === -1) {
      turns.push(turnRecord);
    } else {
      turns[existingIndex] = turnRecord;
    }

    const updated: SessionRecord = { ...session, turns, updatedAt: nowIso() };
    await this.saveSession(updated);
    return updated;
  }

  public async upsertAttempt(
    sessionId: string,
    turnId: string,
    attempt: SessionAttemptRecord,
  ): Promise<SessionRecord> {
    const session = await this.loadSession(sessionId);
    if (session === null) {
      throw new Error(`cannot upsert attempt for missing session: ${sessionId}`);
    }
    const turns = [...session.turns];
    const turnIndex = turns.findIndex((turn) => turn.turnId === turnId);
    if (turnIndex === -1) {
      throw new Error(`cannot upsert attempt for missing turn: ${turnId}`);
    }
    const turn = turns[turnIndex]!;
    const attempts = [...turn.attempts];
    const existingIndex = attempts.findIndex((entry) => entry.attemptId === attempt.attemptId);
    if (existingIndex === -1) {
      attempts.push(attempt);
    } else {
      attempts[existingIndex] = attempt;
    }
    turns[turnIndex] = { ...turn, attempts, updatedAt: nowIso() };

    const updated: SessionRecord = { ...session, turns, updatedAt: nowIso() };
    await this.saveSession(updated);
    return updated;
  }

  public async appendTaskEvent(sessionId: string, event: TaskProgressEvent): Promise<void> {
    const { eventsFile } = this.paths(sessionId);
    await ensureParentDir(eventsFile);
    await writeFile(eventsFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  public async readTaskEvents(sessionId: string): Promise<TaskProgressEvent[]> {
    const { eventsFile } = this.paths(sessionId);
    try {
      const content = await readFile(eventsFile, "utf8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TaskProgressEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

export const createSessionFilePath = (rootDir: string, sessionId: string): string =>
  createSessionPaths(rootDir, sessionId).sessionFile;

export const createSessionEventsFilePath = (rootDir: string, sessionId: string): string =>
  createSessionPaths(rootDir, sessionId).eventsFile;

export const createSessionArtifactsDirPath = (rootDir: string, sessionId: string): string =>
  createSessionPaths(rootDir, sessionId).artifactsDir;

export const createSessionArtifactsFilePath = (rootDir: string, sessionId: string): string =>
  createSessionPaths(rootDir, sessionId).artifactsFile;

export type { ProtocolSchemaVersion };
