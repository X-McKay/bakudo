/**
 * Phase 6 Wave 6c PR7 / A6.5 — time-delta log format + rotation.
 *
 * Plan 06 lines 915-925:
 *
 *   [2026-04-15T12:00:01.234Z] +12ms host=session-store sessionId=ses_01H... msg="appended turn record"
 *
 * `+12ms` is the delta since the PREVIOUS log line on the same logger
 * instance. Makes stall detection trivial — a long delta between expected
 * sequential events is visible at a glance.
 *
 * Rotation: we keep the 10 most recent files at `~/.local/share/bakudo/log/
 * bakudo-{iso}.log`. When a new logger instance opens it scans the log
 * directory, sorts by mtime, and unlinks anything beyond the cap. Rotation
 * is bounded-cost (O(n) stat calls at open time) and deterministic.
 */

import { readdir, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { LOG_LEVEL_ORDINALS, shouldLog, type LogLevel } from "./logLevel.js";
import { bakudoLogDir } from "./xdgPaths.js";

/** Default retention count for `bakudo-{iso}.log` files. */
export const LOG_FILES_KEEP = 10 as const;

/** Filename prefix/suffix so rotation knows what to consider. */
const FILE_PREFIX = "bakudo-";
const FILE_SUFFIX = ".log";

const nowIso = (): string => new Date().toISOString();

const safeIsoForFilename = (iso: string): string => iso.replace(/[:.]/gu, "-");

const quoteMsg = (msg: string): string => {
  // Lightweight single-line quoting: backslash-escape embedded quotes and
  // newlines, keep the line single-line so `+Nms` deltas stay contiguous.
  const escaped = msg.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
  return `"${escaped}"`;
};

/**
 * Render a single time-delta log line. Exposed for unit testing without
 * touching the filesystem.
 */
export const formatLogLine = (input: {
  timestampIso: string;
  deltaMs: number;
  host: string;
  sessionId?: string | undefined;
  msg: string;
  extra?: Readonly<Record<string, string | number | boolean>>;
}): string => {
  const parts: string[] = [
    `[${input.timestampIso}]`,
    `+${Math.max(0, Math.round(input.deltaMs))}ms`,
    `host=${input.host}`,
  ];
  if (input.sessionId !== undefined && input.sessionId.length > 0) {
    parts.push(`sessionId=${input.sessionId}`);
  }
  if (input.extra !== undefined) {
    for (const [k, v] of Object.entries(input.extra)) {
      parts.push(`${k}=${String(v)}`);
    }
  }
  parts.push(`msg=${quoteMsg(input.msg)}`);
  return parts.join(" ");
};

type ClockLike = () => number;

type WriteFn = (line: string) => Promise<void> | void;

export type TimeDeltaLoggerOptions = {
  /** Source tag written into each line's `host=` field. */
  host: string;
  /** Resolved log-level threshold (never `default`). */
  level: Exclude<LogLevel, "default">;
  /** Log file on disk. Callers pre-resolve via {@link openLogFile}. */
  writeLine: WriteFn;
  /** Injection hook for deterministic tests. Defaults to `Date.now`. */
  clock?: ClockLike;
};

/**
 * A single logger instance. Not globally shared — each logical source
 * (the session store, the attempt compiler, the command registry) may
 * construct its own with a distinct `host=` tag.
 *
 * Thread-safety: Node.js is single-threaded per process; the writer queues
 * are therefore sequential. We do not attempt to serialise across
 * processes — rotation uses atomic file appends so interleaved lines are
 * the worst case.
 */
export class TimeDeltaLogger {
  private readonly host: string;
  private readonly level: Exclude<LogLevel, "default">;
  private readonly writeLine: WriteFn;
  private readonly clock: ClockLike;
  private lastEventMs: number | null = null;

  public constructor(options: TimeDeltaLoggerOptions) {
    this.host = options.host;
    this.level = options.level;
    this.writeLine = options.writeLine;
    this.clock = options.clock ?? Date.now;
  }

  /** Write a single log line at `candidate` severity. */
  public async log(
    candidate: Exclude<LogLevel, "default">,
    msg: string,
    meta?: {
      sessionId?: string | undefined;
      extra?: Readonly<Record<string, string | number | boolean>>;
    },
  ): Promise<void> {
    if (!shouldLog(this.level, candidate)) {
      return;
    }
    const now = this.clock();
    const deltaMs = this.lastEventMs === null ? 0 : Math.max(0, now - this.lastEventMs);
    this.lastEventMs = now;
    const line = formatLogLine({
      timestampIso: new Date(now).toISOString(),
      deltaMs,
      host: this.host,
      ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
      msg,
      ...(meta?.extra !== undefined ? { extra: meta.extra } : {}),
    });
    await this.writeLine(line);
  }

  /** Severity helpers for ergonomics at call sites. */
  public error(msg: string, meta?: { sessionId?: string }): Promise<void> {
    return this.log("error", msg, meta);
  }
  public warn(msg: string, meta?: { sessionId?: string }): Promise<void> {
    return this.log("warning", msg, meta);
  }
  public info(msg: string, meta?: { sessionId?: string }): Promise<void> {
    return this.log("info", msg, meta);
  }
  public debug(msg: string, meta?: { sessionId?: string }): Promise<void> {
    return this.log("debug", msg, meta);
  }
}

/**
 * Rotate the log directory keeping at most `keep` files whose names match
 * the canonical `bakudo-{iso}.log` pattern. Files that don't match are left
 * untouched so operators can drop ad-hoc log files in the same directory
 * without risking deletion. Returns the list of paths that were removed.
 */
export const rotateLogFiles = async (
  logDir: string,
  keep: number = LOG_FILES_KEEP,
): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return [];
  }
  const matching = entries.filter(
    (name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX),
  );
  if (matching.length <= keep) return [];
  const stats = await Promise.all(
    matching.map(async (name) => {
      const full = join(logDir, name);
      try {
        const s = await stat(full);
        return { path: full, mtimeMs: s.mtimeMs };
      } catch {
        return { path: full, mtimeMs: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = stats.slice(keep).map((entry) => entry.path);
  for (const path of toRemove) {
    try {
      await unlink(path);
    } catch {
      // Tolerate races — the goal is bounded retention, not perfection.
    }
  }
  return toRemove;
};

/**
 * Allocate a new `bakudo-{iso}.log` file, create its directory if needed,
 * and rotate any files beyond the retention cap. Returns the absolute path
 * plus an appender function the logger uses.
 */
export const openLogFile = async (input?: {
  logDir?: string;
  keep?: number;
  nowIso?: () => string;
}): Promise<{ path: string; appendLine: WriteFn; dispose: () => Promise<void> }> => {
  const dir = input?.logDir ?? bakudoLogDir();
  const keep = input?.keep ?? LOG_FILES_KEEP;
  const isoFn = input?.nowIso ?? nowIso;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${FILE_PREFIX}${safeIsoForFilename(isoFn())}${FILE_SUFFIX}`);
  await writeFile(file, "", { flag: "a" });
  await rotateLogFiles(dir, keep);
  const appendLine: WriteFn = async (line) => {
    await writeFile(file, `${line}\n`, { flag: "a" });
  };
  const dispose = async (): Promise<void> => {
    // No fd to close (we use fs/promises append semantics); keep the shape
    // symmetric for callers registering teardown hooks.
  };
  return { path: file, appendLine, dispose };
};

/** Expose ordinals for test assertions. */
export const __ORDINALS_FOR_TEST = LOG_LEVEL_ORDINALS;
