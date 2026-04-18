import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  appendArtifactRecord as appendArtifactRecordV2,
  type ArtifactRecord as ArtifactRecordV2,
} from "./host/artifactStore.js";
import { ArtifactPersistenceError } from "./host/errors.js";
import { DEFAULT_REDACTION_POLICY, redactRecord, type RedactionPolicy } from "./host/redaction.js";
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
  private readonly redactionPolicy: RedactionPolicy;

  public constructor(
    public readonly rootDir: string,
    redactionPolicy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
  ) {
    // Wave 6c PR7 carryover #7: runner-construction sites pass the
    // effective (default + user-extra) redaction policy so cascade config
    // overrides take effect end-to-end.
    this.redactionPolicy = redactionPolicy;
  }

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

    // Phase 6 W5 hard rule 382 — redact before persisting so obvious secrets
    // in artifact names / metadata never hit disk verbatim.
    const redacted = redactRecord(record, this.redactionPolicy);

    const existing = await this.listArtifacts(input.sessionId);
    const nextArtifacts = [...existing];
    const index = nextArtifacts.findIndex(
      (artifact) => artifact.artifactId === redacted.artifactId,
    );
    if (index === -1) {
      nextArtifacts.push(redacted);
    } else {
      nextArtifacts[index] = redacted;
    }

    await writeJsonAtomic(this.artifactFile(input.sessionId), nextArtifacts);
    return redacted;
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

  /**
   * Phase 6 W4 read API: alias for {@link listArtifacts} so callers reading
   * the legacy v1 registry by session can do so via a verb-shaped name. Kept
   * additive — existing callers of `listArtifacts` keep working unchanged.
   * The cleanup driver (`host/cleanup.ts`) reads through this method so a
   * future read-side reshape lands in one place.
   */
  public async listArtifactsForSession(sessionId: string): Promise<ArtifactRecord[]> {
    return this.listArtifacts(sessionId);
  }

  /**
   * Wave 6c PR7 review-fix B1: thin wrapper around the v2 append-only NDJSON
   * writer in `./host/artifactStore.ts`. Threads the store's effective
   * (merged) redaction policy through to the free function so the v2 write
   * path honours config-cascade `redaction.extra*Patterns`. Without this
   * shim, `sessionArtifactWriter.writeSessionArtifact` called the free
   * function directly and silently fell back to `DEFAULT_REDACTION_POLICY`,
   * bypassing user-configured extras on every persisted artifact record.
   *
   * Kept as a method to mirror {@link registerArtifact}'s shape — callers
   * that have an `ArtifactStore` in hand should not need to also pass the
   * storage root separately (it is already `this.rootDir`).
   */
  public async appendArtifactRecord(sessionId: string, record: ArtifactRecordV2): Promise<void> {
    await appendArtifactRecordV2(this.rootDir, sessionId, record, this.redactionPolicy);
  }

  /**
   * Phase 6 W4 remove API: unlink the on-disk artifact file at `absolutePath`
   * and prune the matching entry from the legacy v1 index for `sessionId`.
   *
   * Wraps any underlying I/O failure in {@link ArtifactPersistenceError} so
   * the cleanup command can surface a stable exit-code-1 envelope per the
   * Wave 6a error taxonomy. ENOENT during unlink is tolerated — the index
   * entry is still pruned so the registry self-heals against orphan rows.
   */
  public async removeArtifact(sessionId: string, absolutePath: string): Promise<void> {
    try {
      try {
        await unlink(absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
      const existing = await this.listArtifacts(sessionId);
      const remaining = existing.filter((record) => record.path !== absolutePath);
      if (remaining.length !== existing.length) {
        await writeJsonAtomic(this.artifactFile(sessionId), remaining);
      }
    } catch (error) {
      throw new ArtifactPersistenceError(`failed to remove artifact at ${absolutePath}`, {
        cause: error,
        details: { sessionId, path: absolutePath },
      });
    }
  }
}
