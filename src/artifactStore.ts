import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "./protocol.js";
import { createSessionArtifactsFilePath, createSessionPaths } from "./sessionStore.js";

export type ArtifactRecord = {
  schemaVersion: typeof BAKUDO_PROTOCOL_SCHEMA_VERSION;
  artifactId: string;
  sessionId: string;
  taskId?: string;
  kind: string;
  name: string;
  path: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type RegisterArtifactInput = Omit<ArtifactRecord, "schemaVersion" | "createdAt"> & {
  createdAt?: string;
};

const ensureParentDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

const nowIso = (): string => new Date().toISOString();

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

const writeJsonAtomic = async (filePath: string, value: unknown): Promise<void> => {
  await ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp-${Date.now()}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

const normalizeArtifactRecord = (
  record: ArtifactRecord,
  createdAt = record.createdAt,
): ArtifactRecord => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
  artifactId: record.artifactId,
  sessionId: record.sessionId,
  kind: record.kind,
  name: record.name,
  path: record.path,
  createdAt,
  ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
  ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
});

export class ArtifactStore {
  public constructor(public readonly rootDir: string) {}

  public artifactFile(sessionId: string): string {
    return createSessionArtifactsFilePath(this.rootDir, sessionId);
  }

  public artifactDir(sessionId: string): string {
    return createSessionPaths(this.rootDir, sessionId).artifactsDir;
  }

  public async registerArtifact(input: RegisterArtifactInput): Promise<ArtifactRecord> {
    const record = normalizeArtifactRecord({
      schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
      artifactId: input.artifactId,
      sessionId: input.sessionId,
      kind: input.kind,
      name: input.name,
      path: input.path,
      createdAt: input.createdAt ?? nowIso(),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });

    const existing = await this.listArtifacts(input.sessionId);
    const nextArtifacts = [...existing];
    const index = nextArtifacts.findIndex((artifact) => artifact.artifactId === record.artifactId);
    if (index === -1) {
      nextArtifacts.push(record);
    } else {
      nextArtifacts[index] = record;
    }

    await writeJsonAtomic(this.artifactFile(input.sessionId), nextArtifacts);
    return record;
  }

  public async listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    const records = await readJsonFile<ArtifactRecord[]>(this.artifactFile(sessionId));
    if (records === null) {
      return [];
    }
    return records.map((record) => normalizeArtifactRecord(record));
  }

  public async listTaskArtifacts(sessionId: string, taskId: string): Promise<ArtifactRecord[]> {
    const records = await this.listArtifacts(sessionId);
    return records.filter((record) => record.taskId === taskId);
  }
}
