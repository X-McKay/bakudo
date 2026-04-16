import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProtocolSchemaVersion, TaskProgressEvent } from "./protocol.js";
import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionStatus,
  SessionTaskRecord,
  SessionTurnRecord,
} from "./sessionTypes.js";
import { CURRENT_SESSION_SCHEMA_VERSION, deriveSessionTitle } from "./sessionTypes.js";
import {
  loadSessionRecord,
  migrateV1TaskToAttempt,
  normalizeV2Record,
  taskStatusToTurnStatus,
} from "./sessionMigration.js";

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
  goal: string;
  repoRoot: string;
  assumeDangerousSkipPermissions: boolean;
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

const compareSessionRecordsForListing = (left: SessionRecord, right: SessionRecord): number => {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt > right.createdAt ? -1 : 1;
  }

  return left.sessionId.localeCompare(right.sessionId);
};

export class SessionStore {
  public constructor(public readonly rootDir: string) {
    this.rootDir = toResolvedPath(rootDir);
  }

  public paths(sessionId: string): SessionStorePaths {
    return createSessionPaths(this.rootDir, sessionId);
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
      goal: input.goal,
      status: input.status ?? "draft",
      assumeDangerousSkipPermissions: input.assumeDangerousSkipPermissions,
      turns,
      createdAt,
      updatedAt,
    };
    await this.saveSession(session);
    return session;
  }

  public async loadSession(sessionId: string): Promise<SessionRecord | null> {
    const sessionFile = this.paths(sessionId).sessionFile;
    const raw = await readJsonFile<unknown>(sessionFile);
    if (raw === null) {
      return null;
    }
    return loadSessionRecord(raw);
  }

  public async listSessions(): Promise<SessionRecord[]> {
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

    return sessions
      .filter((session): session is SessionRecord => session !== null)
      .sort(compareSessionRecordsForListing);
  }

  public async saveSession(record: SessionRecord): Promise<SessionRecord> {
    const normalized = normalizeV2Record(record, { updatedAt: record.updatedAt ?? nowIso() });
    await writeJsonAtomic(this.paths(normalized.sessionId).sessionFile, normalized);
    return normalized;
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

  /**
   * @deprecated migrated shim: maps onto turn "turn-1" via {@link upsertAttempt}.
   */
  public async upsertTask(
    sessionId: string,
    taskRecord: SessionTaskRecord,
  ): Promise<SessionRecord> {
    const session = await this.loadSession(sessionId);
    if (session === null) {
      throw new Error(`cannot upsert task for missing session: ${sessionId}`);
    }
    const attempt = migrateV1TaskToAttempt(taskRecord);
    const existingTurn = session.turns[0];
    if (existingTurn === undefined) {
      const turn: SessionTurnRecord = {
        turnId: "turn-1",
        prompt: session.goal,
        mode: taskRecord.request?.mode ?? "build",
        status: taskStatusToTurnStatus(taskRecord.status),
        attempts: [attempt],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      return this.upsertTurn(sessionId, turn);
    }
    return this.upsertAttempt(sessionId, existingTurn.turnId, attempt);
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
