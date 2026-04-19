/**
 * Phase 6 Workstream 4 — `bakudo cleanup`.
 *
 * Walks every session directory under the repo's storage root, asks the
 * retention engine which artifact records are eligible for cleanup, then
 * either reports impact (`--dry-run`) or deletes the on-disk files plus
 * NDJSON entries.
 *
 * Plan 06 lines 294-327. Hard rules (lines 317-322):
 *   1. NEVER delete the only persisted review record for a turn.
 *   2. NEVER delete provenance or approval records by default.
 *   3. Mark missing optional artifacts explicitly when deleted under policy.
 *
 * Rules 1+2 are enforced by the {@link PROTECTED_FILE_BASENAMES} guard — the
 * cleanup driver hard-skips any path whose basename matches a session-level
 * provenance/approval/transition/session/event record. Review records live
 * inside `session.json` (`turn.latestReview`) which is on the protected list,
 * so deleting them is impossible by construction.
 *
 * Rule 3 is implemented by appending a `cleanup-log` line to a per-session
 * `cleanup.ndjson` file recording every removed (or would-remove, in
 * dry-run) artifact ID + path. Inspect / chronicle / future audit surfaces
 * pick the same file up via the existing NDJSON readers.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";

import { ArtifactStore } from "../../artifactStore.js";
import { SessionStore, createSessionPaths } from "../../sessionStore.js";
import {
  listArtifactsForSession,
  removeArtifactFile,
  removeArtifactRecords,
  type ArtifactRecord,
} from "../artifactStore.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { ArtifactPersistenceError } from "../errors.js";
import { stdoutWrite } from "../io.js";
import { storageRootFor } from "../orchestration.js";
import {
  buildRetentionPlan,
  DEFAULT_RETENTION_POLICY,
  isOrphanFileBasename,
} from "../retentionPolicy.js";
import {
  CLEANUP_LOG_NAME,
  formatCleanupReport,
  isProtectedBasename,
  parseCleanupArgs,
  type CleanupArgs,
  type CleanupReport,
  type CleanupReportEntry,
} from "./cleanupSupport.js";

// Re-export pure helpers so callers (`doctor.ts`, tests) can keep importing
// from `./cleanup.js` even though the parser/formatter/types now live in
// `./cleanupSupport.js`. This keeps the public surface stable.
export {
  CLEANUP_LOG_NAME,
  PROTECTED_FILE_BASENAMES,
  formatCleanupReport,
  formatBytes,
  isProtectedBasename,
  parseCleanupArgs,
  type CleanupArgs,
  type CleanupReport,
  type CleanupReportEntry,
  type ParseCleanupArgsResult,
} from "./cleanupSupport.js";

const safeStat = async (path: string): Promise<Stats | null> => {
  try {
    return await stat(path);
  } catch {
    return null;
  }
};

const listSessionDirs = async (storageRoot: string): Promise<string[]> => {
  try {
    const entries = await readdir(storageRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const resolveAbsolutePath = (storageRoot: string, sessionId: string, recPath: string): string => {
  // v2 records store relative paths (relative to session dir); v1 entries
  // historically stored absolute paths. Tolerate both.
  if (recPath.startsWith("/")) return recPath;
  const { sessionDir } = createSessionPaths(storageRoot, sessionId);
  return join(sessionDir, recPath);
};

const buildSyntheticOrphanRecord = (
  sessionId: string,
  filePath: string,
  fileName: string,
): ArtifactRecord => ({
  schemaVersion: 2 as const,
  artifactId: `orphan:${sessionId}:${fileName}`,
  sessionId,
  turnId: "",
  kind: "log",
  name: fileName,
  path: filePath,
  createdAt: new Date(0).toISOString(),
});

const keptReasonForRecord = (
  kind: ArtifactRecord["kind"],
  protectedKinds: ReadonlyArray<ArtifactRecord["kind"]>,
): string => (protectedKinds.includes(kind) ? "protected_kind" : "under_retention");

const listSessionRootKeptEntries = async (
  storageRoot: string,
  sessionId: string,
): Promise<CleanupReportEntry[]> => {
  const { sessionDir } = createSessionPaths(storageRoot, sessionId);
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    const kept = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isProtectedBasename(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          const path = join(sessionDir, entry.name);
          const st = await safeStat(path);
          return {
            sessionId,
            artifactId: `session-root:${sessionId}:${entry.name}`,
            path,
            bytes: st?.isFile() === true ? st.size : 0,
            reason: "session_root",
          } satisfies CleanupReportEntry;
        }),
    );
    return kept;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const appendCleanupLog = async (
  storageRoot: string,
  sessionId: string,
  removed: ReadonlyArray<CleanupReportEntry>,
  now: number,
): Promise<void> => {
  const sessionDir = createSessionPaths(storageRoot, sessionId).sessionDir;
  const cleanupPath = join(sessionDir, CLEANUP_LOG_NAME);
  await mkdir(sessionDir, { recursive: true });
  const lines = removed
    .map((r) =>
      JSON.stringify({
        kind: "host.artifact_cleaned",
        sessionId,
        artifactId: r.artifactId,
        path: r.path,
        bytes: r.bytes,
        reason: r.reason,
        removedAt: new Date(now).toISOString(),
      }),
    )
    .join("\n");
  await writeFile(cleanupPath, `${lines}\n`, { encoding: "utf8", flag: "a" });
};

/**
 * Walk a single session: build a retention plan, classify every record, and
 * — when not dry-run — remove eligible files / prune their records.
 * Records protected by basename are NEVER touched (Hard Rules 1 + 2).
 */
export const cleanupSession = async (
  storageRoot: string,
  sessionId: string,
  args: CleanupArgs,
  now: number = Date.now(),
): Promise<{
  entries: CleanupReportEntry[];
  kept: CleanupReportEntry[];
  removed: CleanupReportEntry[];
  errors: string[];
}> => {
  const errors: string[] = [];
  const eligible: CleanupReportEntry[] = [];
  const kept: CleanupReportEntry[] = [];
  const removed: CleanupReportEntry[] = [];

  const sessionStore = new SessionStore(storageRoot);
  const session = await sessionStore.loadSession(sessionId);
  if (session === null) {
    return { entries: eligible, kept, removed, errors };
  }

  const records = await listArtifactsForSession(storageRoot, sessionId);
  const policyOverride =
    args.olderThanMs === undefined ? undefined : { intermediateMaxAgeMs: args.olderThanMs };
  const plan = buildRetentionPlan({
    session,
    records,
    ...(policyOverride === undefined ? {} : { policy: policyOverride }),
    now,
  });

  if (args.dryRun) {
    kept.push(...(await listSessionRootKeptEntries(storageRoot, sessionId)));
  }

  // Discover orphan files in the session's artifacts dir and append them as
  // synthetic records so they participate in the same delete loop.
  const { artifactsDir } = createSessionPaths(storageRoot, sessionId);
  const orphanItems: { path: string; record: ArtifactRecord }[] = [];
  try {
    const dirEntries = await readdir(artifactsDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isFile()) continue;
      if (entry.name === "index.json") continue; // legacy v1 index — protected via the store API
      if (isOrphanFileBasename(entry.name, records)) {
        const path = join(artifactsDir, entry.name);
        orphanItems.push({ path, record: buildSyntheticOrphanRecord(sessionId, path, entry.name) });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`scan ${artifactsDir}: ${(error as Error).message}`);
    }
  }

  const removedIds: string[] = [];

  for (const item of plan.items) {
    const absPath = resolveAbsolutePath(storageRoot, sessionId, item.record.path);
    const basename = absPath.split(/[\\/]/u).at(-1) ?? "";
    const st = await safeStat(absPath);
    const bytes = st?.isFile() === true ? st.size : 0;
    const entryBase = {
      sessionId,
      artifactId: item.record.artifactId,
      path: absPath,
      bytes,
    };
    if (isProtectedBasename(basename)) {
      if (args.dryRun) kept.push({ ...entryBase, reason: "session_root" });
      continue; // Hard rules 1 + 2 (defense in depth).
    }
    if (!item.decision.eligible) {
      if (args.dryRun) {
        kept.push({
          ...entryBase,
          reason: keptReasonForRecord(item.record.kind, plan.policy.protectedKinds),
        });
      }
      continue;
    }
    const entry: CleanupReportEntry = { ...entryBase, reason: item.decision.reason };
    eligible.push(entry);
    if (args.dryRun) continue;
    try {
      await removeArtifactFile(absPath);
      removedIds.push(item.record.artifactId);
      removed.push(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`remove ${absPath}: ${message}`);
      if (!(error instanceof ArtifactPersistenceError)) throw error;
    }
  }

  // Process orphans last so they share the same protection guard.
  for (const orphan of orphanItems) {
    const basename = orphan.path.split(/[\\/]/u).at(-1) ?? "";
    const st = await safeStat(orphan.path);
    const bytes = st?.isFile() === true ? st.size : 0;
    const entryBase = {
      sessionId,
      artifactId: orphan.record.artifactId,
      path: orphan.path,
      bytes,
    };
    if (isProtectedBasename(basename)) {
      if (args.dryRun) kept.push({ ...entryBase, reason: "under_retention" });
      continue;
    }
    const entry: CleanupReportEntry = { ...entryBase, reason: "orphan_temp_file" };
    eligible.push(entry);
    if (args.dryRun) continue;
    try {
      await removeArtifactFile(orphan.path);
      removed.push(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`remove ${orphan.path}: ${message}`);
      if (!(error instanceof ArtifactPersistenceError)) throw error;
    }
  }

  // Best-effort: prune the v1 legacy index entries, prune the v2 NDJSON
  // records, and write the per-session cleanup-log line so consumers can
  // mark the missing artifacts as "deleted under policy" (Hard Rule #3).
  if (!args.dryRun && removed.length > 0) {
    const legacyStore = new ArtifactStore(storageRoot);
    for (const r of removed) {
      try {
        await legacyStore.removeArtifact(sessionId, r.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`prune v1 index ${r.path}: ${message}`);
      }
    }
    try {
      await removeArtifactRecords(storageRoot, sessionId, removedIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`prune v2 records: ${message}`);
    }
    try {
      await appendCleanupLog(storageRoot, sessionId, removed, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`append cleanup log: ${message}`);
    }
  }

  return { entries: eligible, kept, removed, errors };
};

/**
 * Top-level driver: walk every session (or just `args.sessionId`), aggregate
 * one {@link CleanupReport}.
 */
export const runCleanup = async (
  storageRoot: string,
  args: CleanupArgs,
  now: number = Date.now(),
): Promise<CleanupReport> => {
  const sessionIds =
    args.sessionId !== undefined ? [args.sessionId] : await listSessionDirs(storageRoot);

  const eligible: CleanupReportEntry[] = [];
  const kept: CleanupReportEntry[] = [];
  const removed: CleanupReportEntry[] = [];
  const errors: string[] = [];
  let scannedArtifacts = 0;

  for (const sessionId of sessionIds) {
    const sessionResult = await cleanupSession(storageRoot, sessionId, args, now);
    eligible.push(...sessionResult.entries);
    kept.push(...sessionResult.kept);
    removed.push(...sessionResult.removed);
    errors.push(...sessionResult.errors);
    scannedArtifacts += sessionResult.entries.length + sessionResult.kept.length;
  }

  const totalBytes = (args.dryRun ? eligible : removed).reduce((sum, e) => sum + e.bytes, 0);
  const totalArtifacts = eligible.length + kept.length;

  return {
    policy: {
      intermediateMaxAgeMs: args.olderThanMs ?? DEFAULT_RETENTION_POLICY.intermediateMaxAgeMs,
      intermediateKinds: DEFAULT_RETENTION_POLICY.intermediateKinds,
      protectedKinds: DEFAULT_RETENTION_POLICY.protectedKinds,
    },
    dryRun: args.dryRun,
    scannedSessions: sessionIds.length,
    scannedArtifacts,
    eligible,
    kept,
    totalArtifacts,
    removed,
    totalBytes,
    errors,
  };
};

/**
 * One-shot entrypoint mirroring `runDoctorCommand` — used by the CLI
 * `bakudo cleanup ...` dispatch path.
 */
export const runCleanupCommand = async (input: {
  args: ReadonlyArray<string>;
  repoRoot?: string;
  storageRoot?: string;
}): Promise<{ report: CleanupReport; exitCode: number }> => {
  const parsed = parseCleanupArgs(input.args);
  if (!parsed.ok) {
    throw new ArtifactPersistenceError(parsed.error);
  }
  const root = storageRootFor(input.repoRoot, input.storageRoot);
  const report = await runCleanup(root, parsed.args);
  for (const line of formatCleanupReport(report)) {
    stdoutWrite(`${line}\n`);
  }
  return { report, exitCode: report.errors.length > 0 ? 1 : 0 };
};

/**
 * Compute total artifact bytes across every session under `storageRoot`.
 * Used by `bakudo doctor` (W4 — `storage` section) to surface "how much
 * disk are we using right now?". Tolerant of a missing storage root and
 * malformed records (`bytes` defaults to 0 for any unstattable entry).
 */
export const computeStorageTotalBytes = async (storageRoot: string): Promise<number> => {
  let total = 0;
  const sessionIds = await listSessionDirs(storageRoot);
  for (const sessionId of sessionIds) {
    const records = await listArtifactsForSession(storageRoot, sessionId);
    for (const record of records) {
      const absPath = resolveAbsolutePath(storageRoot, sessionId, record.path);
      const st = await safeStat(absPath);
      if (st?.isFile() === true) total += st.size;
    }
  }
  return total;
};

export const cleanupCommandSpec: HostCommandSpec = {
  name: "cleanup",
  group: "system",
  description: "Prune stale artifacts per the retention policy. Use `--dry-run` to preview impact.",
  handler: async ({ args, deps }) => {
    const parsed = parseCleanupArgs(args);
    if (!parsed.ok) {
      deps.transcript.push({ kind: "assistant", text: `Error: ${parsed.error}`, tone: "error" });
      return;
    }
    const repoRoot =
      (globalThis as unknown as { process?: { cwd?: () => string } }).process?.cwd?.() ?? ".";
    const root = storageRootFor(repoRoot, undefined);
    const report = await runCleanup(root, parsed.args);
    for (const line of formatCleanupReport(report)) {
      deps.transcript.push({ kind: "event", label: "cleanup", detail: line });
    }
  },
};
