import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProtocolSchemaVersion, TaskProgressEvent } from "./protocol.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "./protocol.js";
import type { SessionRecord, SessionStatus, SessionTaskRecord } from "./sessionTypes.js";

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
  assumeDangerousSkipPermissions: boolean;
  status?: SessionStatus;
  tasks?: SessionTaskRecord[];
  createdAt?: string;
  updatedAt?: string;
};

const SESSION_FILE_NAME = "session.json";
const EVENTS_FILE_NAME = "events.ndjson";
const ARTIFACTS_DIR_NAME = "artifacts";
const ARTIFACTS_FILE_NAME = "index.json";

const toResolvedPath = (rootDir: string): string => (isAbsolute(rootDir) ? rootDir : resolve(rootDir));

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

const normalizeSessionRecord = (
  record: SessionRecord,
  overrides: Pick<CreateSessionInput, "createdAt" | "updatedAt"> = {},
): SessionRecord => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
  sessionId: record.sessionId,
  goal: record.goal,
  status: record.status,
  assumeDangerousSkipPermissions: record.assumeDangerousSkipPermissions,
  tasks: [...record.tasks],
  createdAt: overrides.createdAt ?? record.createdAt,
  updatedAt: overrides.updatedAt ?? record.updatedAt,
});

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
    const session: SessionRecord = {
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      sessionId: input.sessionId,
      goal: input.goal,
      status: input.status ?? "draft",
      assumeDangerousSkipPermissions: input.assumeDangerousSkipPermissions,
      tasks: [...(input.tasks ?? [])],
      createdAt,
      updatedAt,
    };
    await this.saveSession(session);
    return session;
  }

  public async loadSession(sessionId: string): Promise<SessionRecord | null> {
    const sessionFile = this.paths(sessionId).sessionFile;
    const record = await readJsonFile<SessionRecord>(sessionFile);
    if (record === null) {
      return null;
    }
    return normalizeSessionRecord(record);
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
          const record = await readJsonFile<SessionRecord>(sessionFile);
          if (record === null) {
            return null;
          }
          return normalizeSessionRecord(record);
        }),
    );

    return sessions.filter((session): session is SessionRecord => session !== null).sort(compareSessionRecordsForListing);
  }

  public async saveSession(record: SessionRecord): Promise<SessionRecord> {
    const normalized = normalizeSessionRecord(record, { updatedAt: record.updatedAt ?? nowIso() });
    await writeJsonAtomic(this.paths(normalized.sessionId).sessionFile, normalized);
    return normalized;
  }

  public async upsertTask(sessionId: string, taskRecord: SessionTaskRecord): Promise<SessionRecord> {
    const session = await this.loadSession(sessionId);
    if (session === null) {
      throw new Error(`cannot upsert task for missing session: ${sessionId}`);
    }

    const tasks = [...session.tasks];
    const existingIndex = tasks.findIndex((task) => task.taskId === taskRecord.taskId);
    if (existingIndex === -1) {
      tasks.push(taskRecord);
    } else {
      tasks[existingIndex] = taskRecord;
    }

    const updatedSession: SessionRecord = {
      ...session,
      tasks,
      updatedAt: nowIso(),
    };

    await this.saveSession(updatedSession);
    return updatedSession;
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
