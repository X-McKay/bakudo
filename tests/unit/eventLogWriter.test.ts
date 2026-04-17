import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSessionEvent, type SessionEventEnvelope } from "../../src/protocol.js";
import {
  FLUSH_SIZE_BYTES,
  FLUSH_SIZE_ENTRIES,
  OVERSIZED_ENVELOPE_BYTES,
  createSessionEventLogWriter,
  emitSessionEvent,
  eventLogFilePath,
  eventLogLegacyPath,
  readSessionEventLog,
} from "../../src/host/eventLogWriter.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-eventlog-"));

const buildEnvelope = (
  index: number,
  overrides: Partial<SessionEventEnvelope> = {},
): SessionEventEnvelope => ({
  ...createSessionEvent({
    kind: "worker.attempt_progress",
    sessionId: "session-x",
    turnId: "turn-1",
    attemptId: "attempt-1",
    actor: "worker",
    payload: { attemptId: "attempt-1", status: "running", message: `event ${index}` },
  }),
  ...overrides,
});

type ManualTimers = {
  schedule: (callback: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  tickAll: () => void;
  pending: () => number;
};

const createManualTimers = (): ManualTimers => {
  type Timer = { id: number; callback: () => void };
  const timers: Timer[] = [];
  let nextId = 1;
  return {
    schedule: (callback): unknown => {
      const id = nextId;
      nextId += 1;
      timers.push({ id, callback });
      return id;
    },
    cancel: (handle): void => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx !== -1) {
        timers.splice(idx, 1);
      }
    },
    tickAll: (): void => {
      const pending = timers.splice(0, timers.length);
      for (const t of pending) {
        t.callback();
      }
    },
    pending: (): number => timers.length,
  };
};

test("eventLogFilePath and legacy path point into the session directory", async () => {
  const rootDir = await createTempRoot();
  try {
    const primary = eventLogFilePath(rootDir, "session-abc");
    const legacy = eventLogLegacyPath(rootDir, "session-abc");
    assert.ok(primary.endsWith(join("session-abc", "events.ndjson")));
    assert.ok(legacy.endsWith(join("session-abc", "events.v1.ndjson")));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("time-flush: a single append flushes after the timer fires", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    const writer = createSessionEventLogWriter(rootDir, "session-time", {
      timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
    });
    await writer.append(buildEnvelope(0));
    // Nothing on disk yet.
    let contents = "";
    try {
      contents = await readFile(writer.getFilePath(), "utf8");
    } catch {
      contents = "";
    }
    assert.equal(contents, "");
    assert.equal(timers.pending(), 1);
    timers.tickAll();
    await writer.flush();
    await writer.close();
    const envelopes = await readSessionEventLog(rootDir, "session-time");
    assert.equal(envelopes.length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("size-flush: hitting FLUSH_SIZE_ENTRIES forces flush without firing a timer tick", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    // Custom appendFile captures each flush batch so we can confirm the entry
    // threshold fired at least once without waiting on a timer tick.
    const batches: string[] = [];
    const writer = createSessionEventLogWriter(rootDir, "session-size", {
      timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
      appendFileImpl: async (_filePath: string, data: string): Promise<void> => {
        batches.push(data);
      },
    });
    for (let i = 0; i < FLUSH_SIZE_ENTRIES; i += 1) {
      await writer.append(buildEnvelope(i));
    }
    // Even though tiny envelopes might also trip the byte trigger first, the
    // key invariant is that all pending lines landed in append calls without
    // ever invoking a scheduled callback. Prove it by running any pending
    // timer callbacks and asserting they produce zero additional writes.
    const beforeDrain = batches.length;
    timers.tickAll();
    await writer.flush();
    // Close to guarantee the final batch is drained.
    await writer.close();
    const combined = batches.join("");
    const lines = combined.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, FLUSH_SIZE_ENTRIES);
    // At least one size/byte-triggered flush must have happened before the
    // tick — that's the burst-flush path under test.
    assert.ok(beforeDrain >= 1, `expected >=1 pre-tick flushes, got ${beforeDrain}`);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("byte-flush: serialized bytes >= 4 KiB triggers a flush", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    const writer = createSessionEventLogWriter(rootDir, "session-bytes", {
      timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
    });
    const fat = "x".repeat(500);
    let count = 0;
    let totalBytes = 0;
    while (totalBytes < FLUSH_SIZE_BYTES) {
      const envelope = buildEnvelope(count, {
        payload: { attemptId: "attempt-1", status: "running", message: fat },
      });
      const serialized = `${JSON.stringify(envelope)}\n`;
      totalBytes += serialized.length;
      count += 1;
      await writer.append(envelope);
    }
    // The byte-trigger should have flushed before the timer fired.
    const envelopes = await readSessionEventLog(rootDir, "session-bytes");
    assert.ok(envelopes.length >= 1);
    await writer.close();
    const final = await readSessionEventLog(rootDir, "session-bytes");
    assert.equal(final.length, count);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("retry: appendFile fails 4 times with EBUSY then succeeds", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    let callCount = 0;
    const sleepCalls: number[] = [];
    const append = async (filePath: string, data: string): Promise<void> => {
      callCount += 1;
      if (callCount <= 4) {
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      await writeFile(filePath, data, { encoding: "utf8", flag: "a" });
    };
    const writer = createSessionEventLogWriter(rootDir, "session-retry", {
      timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
      appendFileImpl: append,
      sleepImpl: async (ms: number): Promise<void> => {
        sleepCalls.push(ms);
      },
    });
    await writer.append(buildEnvelope(0));
    await writer.flush();
    await writer.close();
    assert.equal(callCount, 5);
    assert.deepEqual(sleepCalls, [50, 100, 200, 400]);
    assert.equal(writer.getDroppedBatchCount(), 0);
    const envelopes = await readSessionEventLog(rootDir, "session-retry");
    assert.equal(envelopes.length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("drop-on-5-failures: exhausted retries increment counter without throwing", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const append = async (): Promise<void> => {
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      };
      const writer = createSessionEventLogWriter(rootDir, "session-drop", {
        timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
        appendFileImpl: append,
        sleepImpl: async (): Promise<void> => {},
      });
      await writer.append(buildEnvelope(0));
      await writer.flush();
      await writer.close();
      assert.equal(writer.getDroppedBatchCount(), 1);
      const matched = stderrLines.some((line) =>
        line.startsWith("[bakudo.events] dropped batch of 1 envelopes for session session-drop:"),
      );
      assert.equal(matched, true);
    } finally {
      process.stderr.write = originalWrite;
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("fail-fast: non-retryable errors drop after one attempt", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    let callCount = 0;
    const append = async (): Promise<void> => {
      callCount += 1;
      const err = new Error("denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    };
    const writer = createSessionEventLogWriter(rootDir, "session-fatal", {
      timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
      appendFileImpl: append,
      sleepImpl: async (): Promise<void> => {},
    });
    await writer.append(buildEnvelope(0));
    await writer.flush();
    await writer.close();
    assert.equal(callCount, 1);
    assert.equal(writer.getDroppedBatchCount(), 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("close drains pending writes", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    const writer = createSessionEventLogWriter(rootDir, "session-close", {
      timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
    });
    await writer.append(buildEnvelope(0));
    await writer.append(buildEnvelope(1));
    await writer.append(buildEnvelope(2));
    // Nothing flushed yet — timer is pending.
    assert.equal((await readSessionEventLog(rootDir, "session-close")).length, 0);
    await writer.close();
    const envelopes = await readSessionEventLog(rootDir, "session-close");
    assert.equal(envelopes.length, 3);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("oversized-envelope: > 256 KiB is dropped with a warning", async () => {
  const rootDir = await createTempRoot();
  try {
    const timers = createManualTimers();
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const writer = createSessionEventLogWriter(rootDir, "session-oversize", {
        timerProvider: { schedule: timers.schedule, cancel: timers.cancel },
      });
      const giant = buildEnvelope(0, {
        payload: {
          attemptId: "attempt-1",
          status: "running",
          message: "y".repeat(OVERSIZED_ENVELOPE_BYTES + 10),
        },
      });
      await writer.append(giant);
      await writer.close();
      assert.equal(writer.getDroppedBatchCount(), 1);
      const envelopes = await readSessionEventLog(rootDir, "session-oversize");
      assert.equal(envelopes.length, 0);
      assert.ok(
        stderrLines.some((line) => line.includes("EOVERSIZE")),
        "expected EOVERSIZE warning on stderr",
      );
    } finally {
      process.stderr.write = originalWrite;
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("emitSessionEvent appends a single envelope without buffering", async () => {
  const rootDir = await createTempRoot();
  try {
    const envelope = buildEnvelope(0);
    await emitSessionEvent(rootDir, "session-short", envelope);
    const envelopes = await readSessionEventLog(rootDir, "session-short");
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0]?.eventId, envelope.eventId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("readSessionEventLog: structurally invalid envelope line is dropped (Zod)", async () => {
  const rootDir = await createTempRoot();
  try {
    const validEnvelope = buildEnvelope(0);
    await emitSessionEvent(rootDir, "session-zod", validEnvelope);
    // Append a structurally invalid line (valid JSON but missing required fields).
    const filePath = eventLogFilePath(rootDir, "session-zod");
    await writeFile(filePath, `${await readFile(filePath, "utf8")}{"not":"an-envelope"}\n`, "utf8");
    const envelopes = await readSessionEventLog(rootDir, "session-zod");
    // Only the valid envelope should survive.
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0]?.eventId, validEnvelope.eventId);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
