import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { createSessionEvent, type SessionEventEnvelope } from "../protocol.js";
import { createSessionPaths } from "../sessionStore.js";
import { stderrWrite } from "./io.js";

/**
 * Append-only NDJSON writer for the v2 session event log.
 *
 * Writer behavior:
 *  - Buffered append with flush on size (64 entries), bytes (4 KiB), or
 *    elapsed time (100 ms since first pending entry). First trip wins.
 *  - Retry schedule: 5 attempts at 50/100/200/400/800 ms for transient fs
 *    errors (EAGAIN, EBUSY, EMFILE, ENFILE, ENOSPC); other errors fail fast.
 *  - On first v2 write, rename any legacy `events.ndjson` whose first line
 *    lacks `"schemaVersion":2` to `events.v1.ndjson` atomically.
 *  - Oversized envelopes (> 256 KiB serialized) are dropped with a warning.
 *
 * See the phase-2 PR3 brief for the authoritative contract.
 */

/** Zod schema for structural validation of event envelopes read from disk. */
export const SessionEventEnvelopeSchema = z
  .object({
    schemaVersion: z.number(),
    eventId: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    attemptId: z.string().optional(),
    actor: z.string(),
    kind: z.string(),
    timestamp: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strip();

const EVENTS_FILE_NAME = "events.ndjson";
const LEGACY_FILE_NAME = "events.v1.ndjson";

export const FLUSH_SIZE_ENTRIES = 64;
export const FLUSH_SIZE_BYTES = 4 * 1024;
export const FLUSH_INTERVAL_MS = 100;
export const OVERSIZED_ENVELOPE_BYTES = 256 * 1024;

const RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const RETRYABLE_FS_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ENOSPC"]);

export const eventLogFilePath = (storageRoot: string, sessionId: string): string =>
  join(createSessionPaths(storageRoot, sessionId).sessionDir, EVENTS_FILE_NAME);

export const eventLogLegacyPath = (storageRoot: string, sessionId: string): string =>
  join(createSessionPaths(storageRoot, sessionId).sessionDir, LEGACY_FILE_NAME);

/**
 * Read the v2 event log for a session. Missing file → `[]`. Blank and
 * malformed lines are silently dropped; {@link import("./timeline.js").loadEventLog}
 * reports counts separately when callers need that detail.
 */
export const readSessionEventLog = async (
  storageRoot: string,
  sessionId: string,
): Promise<SessionEventEnvelope[]> => {
  const filePath = eventLogFilePath(storageRoot, sessionId);
  try {
    const content = await readFile(filePath, "utf8");
    const out: SessionEventEnvelope[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        const validated = SessionEventEnvelopeSchema.safeParse(parsed);
        if (validated.success) {
          out.push(validated.data as SessionEventEnvelope);
        }
        // Structurally invalid lines silently dropped; loadEventLog surfaces counts.
      } catch {
        // JSON parse failures silently dropped; loadEventLog surfaces counts.
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

export type EventLogWriterOptions = {
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
  /** Inject a schedule/cancel pair so tests can advance time deterministically. */
  timerProvider?: {
    schedule: (callback: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
  };
  /** Override the underlying appendFile; tests use this to force retries. */
  appendFileImpl?: (filePath: string, data: string) => Promise<void>;
  /** Override the retry delay function; tests use this to skip real waits. */
  sleepImpl?: (ms: number) => Promise<void>;
};

export type EventLogWriter = {
  /** Buffer a single envelope for append. Flushes synchronously on triggers. */
  append: (envelope: SessionEventEnvelope) => Promise<void>;
  /** Force any pending batch to flush now. */
  flush: () => Promise<void>;
  /** Drain pending writes, clear timers, release resources. */
  close: () => Promise<void>;
  /** Count of batches dropped after exhausting retries or oversized guard. */
  getDroppedBatchCount: () => number;
  /** Absolute path of the destination file. */
  getFilePath: () => string;
};

const defaultAppendFile = (filePath: string, data: string): Promise<void> =>
  appendFile(filePath, data, "utf8");

const defaultSchedule = (callback: () => void, ms: number): unknown => setTimeout(callback, ms);
const defaultCancel = (handle: unknown): void => {
  if (handle !== undefined && handle !== null) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  }
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableFsError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
};

const extractErrorFields = (error: unknown): { code: string; message: string } => {
  const err = error as NodeJS.ErrnoException;
  return {
    code: typeof err?.code === "string" ? err.code : "UNKNOWN",
    message: typeof err?.message === "string" ? err.message : String(error),
  };
};

const firstLineShowsLegacyShape = (content: string): boolean => {
  const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return false;
  }
  // Any existing file missing `"schemaVersion":2` on line one is treated as
  // legacy. Match both compact and spaced JSON forms.
  return !/"schemaVersion"\s*:\s*2\b/u.test(firstLine);
};

const maybeRenameLegacy = async (filePath: string, legacyPath: string): Promise<void> => {
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const content = await readFile(filePath, "utf8");
  if (!firstLineShowsLegacyShape(content)) {
    return;
  }
  await rename(filePath, legacyPath);
};

/**
 * Build a buffered, retrying writer bound to a single `(storageRoot, sessionId)`
 * pair. Lifetime is attempt-scoped — create one at the top of `executeTask` and
 * close it in `finally`. See the module docstring for the full contract.
 */
export const createSessionEventLogWriter = (
  storageRoot: string,
  sessionId: string,
  options: EventLogWriterOptions = {},
): EventLogWriter => {
  const filePath = eventLogFilePath(storageRoot, sessionId);
  const legacyPath = eventLogLegacyPath(storageRoot, sessionId);
  const now = options.now ?? Date.now;
  const schedule = options.timerProvider?.schedule ?? defaultSchedule;
  const cancel = options.timerProvider?.cancel ?? defaultCancel;
  const doAppend = options.appendFileImpl ?? defaultAppendFile;
  const sleep = options.sleepImpl ?? defaultSleep;

  const pending: string[] = [];
  let pendingBytes = 0;
  let pendingSince: number | null = null;
  let timerHandle: unknown;
  let dirReady = false;
  let legacyChecked = false;
  let droppedBatchCount = 0;
  /** Promise chain serializing flushes so concurrent callers queue safely. */
  let flushChain: Promise<void> = Promise.resolve();

  const ensureDirReady = async (): Promise<void> => {
    if (dirReady) {
      return;
    }
    await mkdir(dirname(filePath), { recursive: true });
    dirReady = true;
  };

  const maybeRename = async (): Promise<void> => {
    if (legacyChecked) {
      return;
    }
    legacyChecked = true;
    try {
      await maybeRenameLegacy(filePath, legacyPath);
    } catch (error) {
      // Rename failure is non-fatal; the legacy file will just stay in place.
      const { code, message } = extractErrorFields(error);
      stderrWrite(
        `[bakudo.events] legacy rename failed for session ${sessionId}: ${code} ${message}\n`,
      );
    }
  };

  const clearTimer = (): void => {
    if (timerHandle !== undefined) {
      cancel(timerHandle);
      timerHandle = undefined;
    }
  };

  const armTimer = (): void => {
    if (timerHandle !== undefined || pending.length === 0) {
      return;
    }
    timerHandle = schedule(() => {
      timerHandle = undefined;
      flushChain = flushChain
        .then(() => performFlush())
        .catch(() => {
          // Errors already handled/reported inside performFlush.
        });
    }, FLUSH_INTERVAL_MS);
  };

  const performFlush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    clearTimer();
    const batch = pending.splice(0, pending.length);
    pendingBytes = 0;
    pendingSince = null;
    const data = batch.join("");

    await ensureDirReady();
    await maybeRename();

    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await doAppend(filePath, data);
        return;
      } catch (error) {
        lastError = error;
        if (!isRetryableFsError(error)) {
          break;
        }
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
    }
    droppedBatchCount += 1;
    const { code, message } = extractErrorFields(lastError);
    stderrWrite(
      `[bakudo.events] dropped batch of ${batch.length} envelopes for session ${sessionId}: ${code} ${message}\n`,
    );
  };

  const triggerIfDue = (): boolean => {
    if (pending.length >= FLUSH_SIZE_ENTRIES) {
      return true;
    }
    if (pendingBytes >= FLUSH_SIZE_BYTES) {
      return true;
    }
    if (pendingSince !== null && now() - pendingSince >= FLUSH_INTERVAL_MS) {
      return true;
    }
    return false;
  };

  const append = async (envelope: SessionEventEnvelope): Promise<void> => {
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (serialized.length > OVERSIZED_ENVELOPE_BYTES) {
      droppedBatchCount += 1;
      stderrWrite(
        `[bakudo.events] dropped batch of 1 envelopes for session ${sessionId}: EOVERSIZE envelope ${serialized.length} bytes exceeds ${OVERSIZED_ENVELOPE_BYTES}\n`,
      );
      return;
    }
    pending.push(serialized);
    pendingBytes += serialized.length;
    if (pendingSince === null) {
      pendingSince = now();
    }
    if (triggerIfDue()) {
      flushChain = flushChain.then(() => performFlush()).catch(() => {});
      await flushChain;
    } else {
      armTimer();
    }
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    flushChain = flushChain.then(() => performFlush()).catch(() => {});
    await flushChain;
  };

  const close = async (): Promise<void> => {
    clearTimer();
    await flush();
  };

  return {
    append,
    flush,
    close,
    getDroppedBatchCount: () => droppedBatchCount,
    getFilePath: () => filePath,
  };
};

/**
 * Short-lived writer for low-frequency pre-dispatch events (`user.turn_submitted`,
 * `host.turn_queued`). Opens, appends, and closes a one-shot writer — does NOT
 * share buffering with the attempt-scoped writer used by `executeTask`.
 */
export const emitSessionEvent = async (
  storageRoot: string,
  sessionId: string,
  envelope: SessionEventEnvelope,
): Promise<void> => {
  const writer = createSessionEventLogWriter(storageRoot, sessionId);
  try {
    await writer.append(envelope);
  } finally {
    await writer.close();
  }
};

/**
 * Helper for the `user.turn_submitted` pre-dispatch emission shared by the
 * non-interactive one-shot path and the interactive `dispatchThroughController`
 * path. Keeps the envelope shape in one place.
 */
export const emitUserTurnSubmitted = async (
  storageRoot: string,
  sessionId: string,
  prompt: string,
  mode: string,
): Promise<void> => {
  await emitSessionEvent(
    storageRoot,
    sessionId,
    createSessionEvent({
      kind: "user.turn_submitted",
      sessionId,
      actor: "user",
      payload: { prompt, mode },
    }),
  );
};
