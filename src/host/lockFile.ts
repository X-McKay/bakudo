/**
 * Per-session lock file API (Phase 6 Workstream 2).
 *
 * Purpose
 * -------
 * Prevent two bakudo host processes from concurrently mutating the same
 * session on disk. Writers acquire the lock before `SessionStore.saveSession`
 * (and friends) mutate `session.json`, release it on graceful shutdown, and
 * release via the LIFO cleanup chain on crash.
 *
 * Layout
 * ------
 * The lock file lives alongside `session.json` inside the session directory,
 * so the storage root (repo-local `.bakudo/sessions/` today, XDG target in
 * Wave 6e per plan 811-819) always co-locates the lock with the record it
 * protects. This keeps the contract invariant under the forthcoming
 * `.bakudo/` → XDG migration: the lock is addressed relative to the session
 * dir, not the storage root.
 *
 * Format
 * ------
 * ```json
 * { "sessionId": "...", "ownerPid": 1234, "acquiredAt": "2026-04-18T..." }
 * ```
 *
 * Mirrors the `SessionLock` shape suggested in plan 187-195.
 *
 * Staleness policy
 * ----------------
 * A lock is stale if **any** of:
 *   1. The owning PID is not alive (`process.kill(pid, 0)` throws `ESRCH`).
 *   2. The file is older than `DEFAULT_STALE_LOCK_MS` (1 hour).
 *   3. The file content is malformed (missing/corrupt JSON).
 *
 * Callers choose whether to break a stale lock via `acquireLock({ reclaimStale })`.
 * The default is non-reclaiming — stale detection is surfaced through
 * `isLockStale()` so `recovery.ts` can log a `host.recovery_detected` event
 * before the break.
 *
 * Concurrency primitive
 * ---------------------
 * We use `fs.open(path, "wx")` ("write + exclusive create") for the acquire
 * step. On POSIX + NTFS this is atomic against races between concurrent
 * `wx` opens — exactly one winner. Portability is the reason we prefer it
 * over `flock`/`fcntl`: Node exposes `wx` across every platform we target.
 */

import { mkdir, open as fsOpen, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Shape persisted to `<session-dir>/.lock`. Matches plan 187-195 suggestion. */
export type SessionLock = {
  sessionId: string;
  ownerPid: number;
  acquiredAt: string;
};

/** Name for the per-session lock file. */
export const SESSION_LOCK_FILE_NAME = ".lock";

/**
 * Default staleness threshold. One hour is chosen to cover long-running
 * dispatches (hour-scale abox runs are plausible) while still rescuing users
 * from locks left by crashed hosts that did not reach their cleanup chain.
 */
export const DEFAULT_STALE_LOCK_MS = 60 * 60 * 1000;

/** Absolute path of the lock file inside a session directory. */
export const sessionLockFilePath = (sessionDir: string): string =>
  join(sessionDir, SESSION_LOCK_FILE_NAME);

type ProcessLike = {
  pid?: number;
  kill?: (pid: number, signal?: number | string) => boolean;
};

const getProcess = (): ProcessLike | undefined =>
  (globalThis as unknown as { process?: ProcessLike }).process;

const nowIso = (): string => new Date().toISOString();
const hostPid = (): number => getProcess()?.pid ?? 0;

/**
 * Probe whether a PID is still alive without raising the user-facing signal.
 * `process.kill(pid, 0)` is the POSIX idiom for "check only"; on Node the
 * behavior is normalized across Linux / macOS / Windows. A throw of
 * `ESRCH` (no such process) means the holder is gone. `EPERM` means the
 * process exists but we cannot signal it — we still treat it as alive, since
 * a locked session with a live owner must not be stolen regardless of
 * ownership.
 */
export const isPidAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const proc = getProcess();
  const kill = proc?.kill;
  if (typeof kill !== "function") {
    // Non-Node environment; conservatively report alive so we do not break
    // foreign locks we cannot reason about.
    return true;
  }
  try {
    kill.call(proc, pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM or other: process exists but we cannot signal. Treat as alive.
    return true;
  }
};

/** Parsed content of a lock file, plus the file mtime for staleness checks. */
export type ReadLockResult =
  | { kind: "present"; lock: SessionLock; mtimeMs: number; path: string }
  | { kind: "missing"; path: string }
  | { kind: "corrupt"; path: string; reason: string };

/**
 * Read `<session-dir>/.lock`. Returns a discriminated union so callers can
 * distinguish "no lock" from "corrupt lock" — the latter is itself a
 * recoverable condition per plan Hard Rule 2 (stale locks must be
 * detectable).
 */
export const readSessionLock = async (sessionDir: string): Promise<ReadLockResult> => {
  const path = sessionLockFilePath(sessionDir);
  let content: string;
  let mtimeMs: number;
  try {
    content = await readFile(path, "utf8");
    const stats = await stat(path);
    mtimeMs = stats.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", path };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "corrupt", path, reason };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as SessionLock).sessionId !== "string" ||
    typeof (parsed as SessionLock).ownerPid !== "number" ||
    typeof (parsed as SessionLock).acquiredAt !== "string"
  ) {
    return { kind: "corrupt", path, reason: "lock file schema mismatch" };
  }
  return { kind: "present", lock: parsed as SessionLock, mtimeMs, path };
};

export type StalenessInput = {
  lock: SessionLock;
  mtimeMs: number;
  /** Millisecond clock; injectable for tests. Defaults to `Date.now()`. */
  now?: () => number;
  /** PID-liveness probe; injectable for tests. Defaults to {@link isPidAlive}. */
  pidAlive?: (pid: number) => boolean;
  /** Upper bound on wall-clock age before a lock is stale. */
  staleAfterMs?: number;
};

export type StalenessVerdict =
  | { stale: false }
  | { stale: true; reason: "pid_dead" | "age_exceeded" };

/**
 * Pure decision function: given a parsed lock + its mtime, is it stale?
 * Kept separate from {@link readSessionLock} so the recovery state machine
 * can reason about staleness without touching the filesystem.
 */
export const classifyLockStaleness = (input: StalenessInput): StalenessVerdict => {
  const now = input.now ?? Date.now;
  const pidAlive = input.pidAlive ?? isPidAlive;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  if (!pidAlive(input.lock.ownerPid)) {
    return { stale: true, reason: "pid_dead" };
  }
  const ageMs = Math.max(0, now() - input.mtimeMs);
  if (ageMs > staleAfterMs) {
    return { stale: true, reason: "age_exceeded" };
  }
  return { stale: false };
};

/** Error thrown when acquire fails because a live owner already holds the lock. */
export class SessionLockBusyError extends Error {
  public readonly sessionId: string;
  public readonly ownerPid: number;
  public readonly acquiredAt: string;
  public constructor(lock: SessionLock) {
    super(
      `session ${lock.sessionId} is locked by pid ${String(lock.ownerPid)} (acquired ${lock.acquiredAt})`,
    );
    this.name = "SessionLockBusyError";
    this.sessionId = lock.sessionId;
    this.ownerPid = lock.ownerPid;
    this.acquiredAt = lock.acquiredAt;
  }
}

/** Error thrown when a write is attempted without holding the lock. */
export class SessionLockNotHeldError extends Error {
  public readonly sessionId: string;
  public constructor(sessionId: string) {
    super(`write to session ${sessionId} attempted without holding the lock`);
    this.name = "SessionLockNotHeldError";
    this.sessionId = sessionId;
  }
}

export type AcquireLockOptions = {
  /**
   * When `true`, a stale lock (dead PID or age-exceeded) is silently reclaimed
   * after unlinking the file. When `false` (default), the caller must first
   * detect + act on the stale lock via `readSessionLock` + `classifyLockStaleness`.
   * Recovery code flips this to `true` after emitting a `host.recovery_detected`
   * log line so operators see the break.
   */
  reclaimStale?: boolean;
  /** Clock override for tests. */
  now?: () => number;
  /** PID-liveness override for tests. */
  pidAlive?: (pid: number) => boolean;
  /** Staleness override for tests (defaults to {@link DEFAULT_STALE_LOCK_MS}). */
  staleAfterMs?: number;
  /** Override pid written to the lock file (tests). */
  pid?: number;
};

/** Handle returned by {@link acquireSessionLock}; call `release` to free it. */
export type SessionLockHandle = {
  sessionId: string;
  path: string;
  lock: SessionLock;
  /** Release the lock by unlinking. Idempotent; safe in cleanup chains. */
  release: () => Promise<void>;
  /** Check whether this handle still owns the on-disk lock. */
  isHeld: () => boolean;
};

/**
 * Acquire the per-session lock. Returns a handle. Throws
 * {@link SessionLockBusyError} when a live owner holds the lock; throws the
 * underlying filesystem error for any other unexpected condition.
 *
 * Uses `fs.open(path, "wx")` as the atomic primitive — on collision the
 * promise rejects with `EEXIST` rather than silently truncating. That's the
 * exact semantics we need: a failed acquire must be observable.
 */
export const acquireSessionLock = async (
  sessionId: string,
  sessionDir: string,
  options: AcquireLockOptions = {},
): Promise<SessionLockHandle> => {
  await mkdir(sessionDir, { recursive: true });
  const path = sessionLockFilePath(sessionDir);
  const now = options.now ?? Date.now;
  const ownerPid = options.pid ?? hostPid();
  const lock: SessionLock = {
    sessionId,
    ownerPid,
    acquiredAt: new Date(now()).toISOString(),
  };

  const writeLockFileAtomic = async (): Promise<void> => {
    const handle = await fsOpen(path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  };

  try {
    await writeLockFileAtomic();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
    // Collision. Either a live owner holds it, or it is stale + reclaimable.
    const existing = await readSessionLock(sessionDir);
    if (existing.kind === "missing") {
      // Raced with a release. Retry once; if that fails, bubble up.
      await writeLockFileAtomic();
      return {
        sessionId,
        path,
        lock,
        release: buildReleaser(path, lock),
        isHeld: () => true,
      };
    }
    if (existing.kind === "corrupt") {
      if (options.reclaimStale === true) {
        await unlink(existing.path).catch(() => {});
        await writeLockFileAtomic();
        return {
          sessionId,
          path,
          lock,
          release: buildReleaser(path, lock),
          isHeld: () => true,
        };
      }
      throw new SessionLockBusyError({
        sessionId,
        ownerPid: 0,
        acquiredAt: nowIso(),
      });
    }
    const staleness = classifyLockStaleness({
      lock: existing.lock,
      mtimeMs: existing.mtimeMs,
      ...(options.now ? { now: options.now } : {}),
      ...(options.pidAlive ? { pidAlive: options.pidAlive } : {}),
      ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
    });
    if (!staleness.stale || options.reclaimStale !== true) {
      throw new SessionLockBusyError(existing.lock);
    }
    await unlink(existing.path).catch(() => {});
    await writeLockFileAtomic();
  }

  return {
    sessionId,
    path,
    lock,
    release: buildReleaser(path, lock),
    isHeld: () => true,
  };
};

/**
 * Build the release closure. Idempotent + defensive: verifies the on-disk
 * lock still names this handle's PID before deleting, so a racing process
 * that stole the lock after a stale-break is not accidentally freed.
 */
const buildReleaser = (path: string, owned: SessionLock) => async (): Promise<void> => {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(content) as SessionLock;
    if (parsed.ownerPid !== owned.ownerPid || parsed.sessionId !== owned.sessionId) {
      // Different owner. Do NOT unlink.
      return;
    }
  } catch {
    // Corrupt content; caller may choose to reclaim separately. We do not
    // clobber foreign data.
    return;
  }
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
};
