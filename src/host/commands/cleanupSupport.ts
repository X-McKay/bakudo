/**
 * Phase 6 Workstream 4 — pure helpers for `bakudo cleanup`.
 *
 * Split out of `cleanup.ts` to keep the driver under the 400-line cap. This
 * module owns:
 *   - the `--dry-run` / `--older-than` / `--session` argv parser
 *   - the report shape (`CleanupReport`, `CleanupReportEntry`)
 *   - the human-readable formatter
 *   - the protected-basename guard (Hard Rules 1+2)
 *
 * Nothing here touches the filesystem; the driver in `cleanup.ts` performs
 * all I/O. This keeps the module pure-testable and lets future surfaces
 * (e.g. a TUI cleanup wizard) reuse the parser + formatter.
 */

import type { RetentionPolicy } from "../retentionPolicy.js";
import { parseDurationMs } from "../retentionPolicy.js";

// ---------------------------------------------------------------------------
// Protected file basenames (Hard Rule #1 + #2)
// ---------------------------------------------------------------------------

/**
 * File basenames that the cleanup driver MUST NOT touch under any
 * circumstance. Plan 06 hard rules 1+2: never delete review/provenance/
 * approval records; review records live inside `session.json` (per
 * `SessionTurnRecord.latestReview`), so blocking the file removal preserves
 * the only persisted review surface.
 *
 * `transitions.ndjson` is protected because it is the audit log of turn
 * status transitions — losing it would defeat A6.4 forensic value.
 *
 * `events.ndjson` and `events.v1.ndjson` are protected because the event log
 * IS the session summary (plan 305 — "session summaries indefinitely").
 */
export const PROTECTED_FILE_BASENAMES: ReadonlySet<string> = new Set([
  "session.json",
  "events.ndjson",
  "events.v1.ndjson",
  "transitions.ndjson",
  "provenance.ndjson",
  "approvals.ndjson",
  "artifacts.ndjson", // v2 record log itself — pruned in-place, never deleted
  "cleanup.ndjson", // our own audit log
  "session.lock",
]);

export const CLEANUP_LOG_NAME = "cleanup.ndjson";

export const isProtectedBasename = (basename: string): boolean =>
  PROTECTED_FILE_BASENAMES.has(basename) || basename.startsWith("events.");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export type CleanupArgs = {
  dryRun: boolean;
  /** Override `intermediateMaxAgeMs` (ms). Undefined ⇒ policy default. */
  olderThanMs?: number;
  /** Limit cleanup to a single session id. */
  sessionId?: string;
};

export type ParseCleanupArgsResult = { ok: true; args: CleanupArgs } | { ok: false; error: string };

/**
 * Parse `cleanup` argv into {@link CleanupArgs}. Recognised:
 *   --dry-run
 *   --older-than <duration>     (e.g. 30d, 7d, 6h, 45m)
 *   --older-than=<duration>
 *   --session <id>
 *   --session=<id>
 *
 * Returns a structured error rather than throwing so the host shell can
 * surface a single ErrorResolution without unwinding the dispatch loop.
 */
export const parseCleanupArgs = (argv: ReadonlyArray<string>): ParseCleanupArgsResult => {
  const args: CleanupArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--older-than") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, error: "--older-than requires a duration" };
      const ms = parseDurationMs(value);
      if (ms === null) {
        return { ok: false, error: `invalid duration: ${value} (try 30d, 7d, 6h, 45m, 30s)` };
      }
      args.olderThanMs = ms;
      i += 1;
      continue;
    }
    if (arg.startsWith("--older-than=")) {
      const value = arg.slice("--older-than=".length);
      const ms = parseDurationMs(value);
      if (ms === null) {
        return { ok: false, error: `invalid duration: ${value} (try 30d, 7d, 6h, 45m, 30s)` };
      }
      args.olderThanMs = ms;
      continue;
    }
    if (arg === "--session") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, error: "--session requires a session id" };
      args.sessionId = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--session=")) {
      args.sessionId = arg.slice("--session=".length);
      continue;
    }
    return { ok: false, error: `unknown cleanup flag: ${arg}` };
  }
  return { ok: true, args };
};

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export type CleanupReportEntry = {
  sessionId: string;
  artifactId: string;
  path: string;
  bytes: number;
  reason: string;
};

export type CleanupReport = {
  policy: RetentionPolicy;
  dryRun: boolean;
  scannedSessions: number;
  scannedArtifacts: number;
  eligible: CleanupReportEntry[];
  removed: CleanupReportEntry[];
  totalBytes: number;
  errors: string[];
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/**
 * Plain-text rendering of a {@link CleanupReport} for human consumption.
 * Returns an array of lines so the slash-command path can push each as a
 * transcript event without a manual `\n` split.
 */
export const formatCleanupReport = (report: CleanupReport): string[] => {
  const lines: string[] = [];
  const verb = report.dryRun ? "would remove" : "removed";
  const list = report.dryRun ? report.eligible : report.removed;
  lines.push(`bakudo cleanup — ${report.dryRun ? "dry run" : "live"}`);
  lines.push(
    `scanned ${report.scannedSessions} session(s); ${verb} ${list.length} artifact(s) (${formatBytes(report.totalBytes)})`,
  );
  lines.push(
    `policy: intermediateMaxAgeMs=${report.policy.intermediateMaxAgeMs} ms; protectedKinds=${report.policy.protectedKinds.join(",")}`,
  );
  for (const entry of list) {
    lines.push(`  [${entry.reason}] ${entry.path} (${formatBytes(entry.bytes)})`);
  }
  if (report.errors.length > 0) {
    lines.push("errors:");
    for (const error of report.errors) lines.push(`  ${error}`);
  }
  return lines;
};
