/**
 * Phase 6 Wave 6c PR7 / A6.6 — automatic V8 heap snapshots at RSS threshold.
 *
 * Plan 06 lines 927-936:
 *
 *   1. Background interval (every 30s) checks `process.memoryUsage().rss`.
 *   2. If RSS > threshold (default 2 GiB) write a heap snapshot to
 *      `~/.local/share/bakudo/log/heap-{pid}-{iso}.heapsnapshot`.
 *   3. Gated by `BAKUDO_AUTO_HEAP_SNAPSHOT=1` (default off).
 *   4. Keep at most 3 snapshots; rotate.
 *
 * Provides post-mortem evidence for "bakudo got slow / unresponsive"
 * reports without requiring user repro. Snapshots are large (hundreds of
 * MB for a loaded process), which is why this is opt-in — users turn it
 * on only when they need it.
 */

import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as v8 from "node:v8";

import { bakudoLogDir } from "./xdgPaths.js";

/** Default RSS threshold: 2 GiB. */
export const DEFAULT_HEAP_RSS_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;

/** Default interval between checks: 30 seconds. */
export const DEFAULT_HEAP_WATCHDOG_INTERVAL_MS = 30_000;

/** Maximum retained snapshots on disk. */
export const HEAP_SNAPSHOTS_KEEP = 3 as const;

/** Gate env var — the watchdog is off unless this is exactly "1". */
export const HEAP_WATCHDOG_GATE_ENV = "BAKUDO_AUTO_HEAP_SNAPSHOT" as const;

/** Override env var for the RSS threshold. */
export const HEAP_RSS_THRESHOLD_ENV = "BAKUDO_HEAP_SNAPSHOT_RSS_THRESHOLD_BYTES" as const;

const SNAPSHOT_PREFIX = "heap-";
const SNAPSHOT_SUFFIX = ".heapsnapshot";

const safeIsoForFilename = (iso: string): string => iso.replace(/[:.]/gu, "-");

type ProcessLike = {
  pid: number;
  env: Record<string, string | undefined>;
  memoryUsage: () => { rss: number };
};

const getProcess = (): ProcessLike => (globalThis as unknown as { process: ProcessLike }).process;

/**
 * Parse the `BAKUDO_HEAP_SNAPSHOT_RSS_THRESHOLD_BYTES` override. Invalid /
 * non-positive values fall back to the default.
 */
export const parseThresholdEnv = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_HEAP_RSS_THRESHOLD_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HEAP_RSS_THRESHOLD_BYTES;
  return n;
};

/** Test whether the watchdog is enabled in the given env. */
export const isWatchdogEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[HEAP_WATCHDOG_GATE_ENV] === "1";

/**
 * Rotate heap snapshots in `logDir` keeping at most `keep`. Files that do
 * not match the `heap-*.heapsnapshot` pattern are left alone. Returns the
 * paths that were removed.
 */
export const rotateHeapSnapshots = async (
  logDir: string,
  keep: number = HEAP_SNAPSHOTS_KEEP,
): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return [];
  }
  const matching = entries.filter(
    (name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX),
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
      // Tolerate removal races.
    }
  }
  return toRemove;
};

export type HeapWatchdogOptions = {
  /** Check interval in ms (default 30s). */
  intervalMs?: number;
  /** RSS threshold in bytes above which a snapshot fires. */
  thresholdBytes?: number;
  /** Directory for snapshot files (default = bakudo log dir). */
  logDir?: string;
  /** Max retained snapshots (default 3). */
  keep?: number;
  /** Injection seam: RSS probe. Default reads `process.memoryUsage().rss`. */
  rssProbe?: () => number;
  /** Injection seam: snapshot writer. Default wraps `v8.writeHeapSnapshot`. */
  writeSnapshot?: (path: string) => Promise<string>;
  /** Injection seam: clock for filename generation. */
  nowIso?: () => string;
};

export type HeapWatchdogHandle = {
  /** Force a check + snapshot write. Exposed for tests. */
  checkNow: () => Promise<string | null>;
  /** Stop the interval. Safe to call multiple times. */
  stop: () => void;
  /** Current snapshot-file path (most recent). */
  lastSnapshot: () => string | null;
};

const defaultRssProbe = (): number => getProcess().memoryUsage().rss;
const defaultWriteSnapshot = async (path: string): Promise<string> => v8.writeHeapSnapshot(path);

/**
 * Start the heap watchdog. Returns a handle so the caller can stop the
 * timer on shutdown. The watchdog never throws — any filesystem or v8
 * error is swallowed (a failed snapshot is strictly better than a failed
 * process due to diagnostic collection).
 *
 * The watchdog is a best-effort instrument. Calls to `checkNow` are
 * serialised: if a snapshot is already in flight when a second check
 * fires, the second is skipped. This matches OpenCode's behaviour and
 * avoids multi-GB concurrent writes under real memory pressure.
 */
export const startHeapWatchdog = (options: HeapWatchdogOptions = {}): HeapWatchdogHandle => {
  const intervalMs = options.intervalMs ?? DEFAULT_HEAP_WATCHDOG_INTERVAL_MS;
  const threshold = options.thresholdBytes ?? DEFAULT_HEAP_RSS_THRESHOLD_BYTES;
  const dir = options.logDir ?? bakudoLogDir();
  const keep = options.keep ?? HEAP_SNAPSHOTS_KEEP;
  const probe = options.rssProbe ?? defaultRssProbe;
  const writer = options.writeSnapshot ?? defaultWriteSnapshot;
  const isoFn = options.nowIso ?? ((): string => new Date().toISOString());

  let inFlight = false;
  let last: string | null = null;
  let stopped = false;

  const checkNow = async (): Promise<string | null> => {
    if (inFlight || stopped) return null;
    const rss = probe();
    if (rss <= threshold) return null;
    inFlight = true;
    try {
      await mkdir(dir, { recursive: true });
      const pid = getProcess().pid;
      const path = join(
        dir,
        `${SNAPSHOT_PREFIX}${pid}-${safeIsoForFilename(isoFn())}${SNAPSHOT_SUFFIX}`,
      );
      const written = await writer(path);
      last = written;
      await rotateHeapSnapshots(dir, keep);
      return written;
    } catch {
      // Tolerate failure; a missed snapshot is not fatal.
      return null;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval((): void => {
    void checkNow();
  }, intervalMs);
  // Allow the host process to exit even if this interval is still pending.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  return {
    checkNow,
    stop,
    lastSnapshot: () => last,
  };
};
