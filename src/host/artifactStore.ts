import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createSessionPaths } from "../sessionStore.js";
import { ArtifactPersistenceError } from "./errors.js";
import { DEFAULT_REDACTION_POLICY, redactRecord, type RedactionPolicy } from "./redaction.js";

/**
 * First-class artifact record v2 — artifacts become durable records keyed by
 * `(sessionId, turnId, attemptId?, kind)` in an append-only per-session
 * NDJSON log.
 *
 * The legacy `src/artifactStore.ts` JSON-array store is retained unchanged
 * for migration compatibility with Phase 1 sessions. Starting PR4, every
 * file written by `writeExecutionArtifacts` also appends a v2 record here.
 */

export type ArtifactKind = "result" | "log" | "dispatch" | "patch" | "summary" | "diff" | "report";

export const artifactKinds: readonly ArtifactKind[] = [
  "result",
  "log",
  "dispatch",
  "patch",
  "summary",
  "diff",
  "report",
] as const;

export const ARTIFACT_RECORD_SCHEMA_VERSION = 2 as const;

export type ArtifactRecord = {
  schemaVersion: typeof ARTIFACT_RECORD_SCHEMA_VERSION;
  artifactId: string;
  sessionId: string;
  turnId: string;
  attemptId?: string;
  kind: ArtifactKind;
  name: string;
  /** Relative to `<storageRoot>/sessions/<sessionId>/`. */
  path: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

const ARTIFACTS_FILE_NAME = "artifacts.ndjson";

/**
 * Generate an artifact identifier with the conventional
 * `artifact-<epochMs>-<rand8>` shape, mirroring `eventId`/`transitionId`/
 * `reviewId`.
 */
export const artifactIdFor = (): string => `artifact-${Date.now()}-${randomUUID().slice(0, 8)}`;

export const artifactsFilePath = (storageRoot: string, sessionId: string): string =>
  join(createSessionPaths(storageRoot, sessionId).sessionDir, ARTIFACTS_FILE_NAME);

/**
 * Append a single {@link ArtifactRecord} to the per-session append-only
 * NDJSON log. Creates the session directory and log file on first write.
 * Mirrors the {@link import("./transitionStore.js").appendTurnTransition}
 * pattern — no buffering, one line per call.
 */
export const appendArtifactRecord = async (
  storageRoot: string,
  sessionId: string,
  record: ArtifactRecord,
  redactionPolicy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): Promise<void> => {
  const filePath = artifactsFilePath(storageRoot, sessionId);
  await mkdir(dirname(filePath), { recursive: true });
  // Phase 6 W5 hard rule 382 — redact before persisting. The artifact index
  // is durable; any obvious secret-looking substring in a name or metadata
  // field is scrubbed before the line is appended. Wave 6c PR7 carryover #7:
  // callers may pass an effective (merged) policy; default preserves
  // historical behaviour.
  const redacted = redactRecord(record, redactionPolicy);
  const line = `${JSON.stringify(redacted)}\n`;
  await writeFile(filePath, line, { encoding: "utf8", flag: "a" });
};

/**
 * Read the append-only artifacts log for a session. Returns `[]` when the
 * file does not yet exist (self-healing on next write); malformed lines are
 * silently skipped. Mirrors {@link import("./eventLogWriter.js").readSessionEventLog}.
 */
export const listArtifactRecords = async (
  storageRoot: string,
  sessionId: string,
): Promise<ArtifactRecord[]> => {
  const filePath = artifactsFilePath(storageRoot, sessionId);
  try {
    const content = await readFile(filePath, "utf8");
    const out: ArtifactRecord[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      try {
        out.push(JSON.parse(line) as ArtifactRecord);
      } catch {
        // Drop malformed line silently; timeline loader reports counts if
        // needed (mirrors eventLogWriter behavior).
      }
    }
    return out;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

/**
 * Phase 6 W4: alias for {@link listArtifactRecords} matching the verb-shaped
 * read API name the cleanup driver expects. Kept additive — every existing
 * caller continues to use {@link listArtifactRecords} unchanged.
 */
export const listArtifactsForSession = listArtifactRecords;

/**
 * Phase 6 W4: prune one or more entries (matched by `artifactId`) from the
 * per-session NDJSON log via atomic rewrite. Append-only is preserved for
 * concurrent writers within the same process — this rewrite is gated on the
 * cleanup command holding the session lock.
 *
 * Wraps I/O failures in {@link ArtifactPersistenceError} so callers surface a
 * stable exit-1 envelope per the Wave 6a error taxonomy.
 */
export const removeArtifactRecords = async (
  storageRoot: string,
  sessionId: string,
  artifactIds: ReadonlyArray<string>,
): Promise<void> => {
  if (artifactIds.length === 0) return;
  const filePath = artifactsFilePath(storageRoot, sessionId);
  try {
    const existing = await listArtifactRecords(storageRoot, sessionId);
    if (existing.length === 0) return; // Nothing on disk to prune.
    const remaining = existing.filter((record) => !artifactIds.includes(record.artifactId));
    if (remaining.length === existing.length) return; // No-op when nothing matched.
    const tempPath = `${filePath}.tmp-${Date.now()}-${randomUUID()}`;
    await mkdir(dirname(filePath), { recursive: true });
    const body =
      remaining.length === 0 ? "" : `${remaining.map((rec) => JSON.stringify(rec)).join("\n")}\n`;
    await writeFile(tempPath, body, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new ArtifactPersistenceError(`failed to prune artifact records for ${sessionId}`, {
      cause: error,
      details: { sessionId, removedIds: artifactIds.length },
    });
  }
};

/**
 * Phase 6 W4: unlink an artifact file at `absolutePath`. Tolerates ENOENT so
 * a missing file does not break the dry-run/delete iteration. Other errors
 * surface as {@link ArtifactPersistenceError}.
 */
export const removeArtifactFile = async (absolutePath: string): Promise<void> => {
  try {
    await unlink(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw new ArtifactPersistenceError(`failed to remove artifact file at ${absolutePath}`, {
      cause: error,
      details: { path: absolutePath },
    });
  }
};
