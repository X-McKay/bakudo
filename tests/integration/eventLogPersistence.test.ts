import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createSessionEvent } from "../../src/protocol.js";
import {
  createSessionEventLogWriter,
  eventLogFilePath,
  eventLogLegacyPath,
  readSessionEventLog,
} from "../../src/host/eventLogWriter.js";
import { loadEventLog } from "../../src/host/timeline.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-eventlog-int-"));

test("appending N envelopes round-trips through readSessionEventLog", async () => {
  const rootDir = await createTempRoot();
  try {
    const writer = createSessionEventLogWriter(rootDir, "session-rt");
    for (let i = 0; i < 10; i += 1) {
      await writer.append(
        createSessionEvent({
          kind: "worker.attempt_progress",
          sessionId: "session-rt",
          turnId: "turn-1",
          attemptId: "attempt-1",
          actor: "worker",
          payload: { attemptId: "attempt-1", status: "running", message: `n=${i}` },
        }),
      );
    }
    await writer.close();
    const envelopes = await readSessionEventLog(rootDir, "session-rt");
    assert.equal(envelopes.length, 10);
    assert.equal(envelopes[0]?.payload.message, "n=0");
    assert.equal(envelopes[9]?.payload.message, "n=9");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("legacy events.ndjson is renamed to events.v1.ndjson on first v2 write", async () => {
  const rootDir = await createTempRoot();
  try {
    const filePath = eventLogFilePath(rootDir, "session-legacy");
    const legacyPath = eventLogLegacyPath(rootDir, "session-legacy");
    await mkdir(dirname(filePath), { recursive: true });
    const legacyLine = JSON.stringify({
      schemaVersion: 1,
      kind: "task.progress",
      taskId: "t1",
      sessionId: "session-legacy",
      status: "running",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(filePath, `${legacyLine}\n`, "utf8");

    const writer = createSessionEventLogWriter(rootDir, "session-legacy");
    await writer.append(
      createSessionEvent({
        kind: "host.dispatch_started",
        sessionId: "session-legacy",
        turnId: "turn-1",
        attemptId: "attempt-1",
        actor: "host",
        payload: {
          attemptId: "attempt-1",
          goal: "goal",
          mode: "plan",
          assumeDangerousSkipPermissions: false,
        },
      }),
    );
    await writer.close();

    const renamed = await readFile(legacyPath, "utf8");
    assert.ok(renamed.includes('"schemaVersion":1'));

    const fresh = await readFile(filePath, "utf8");
    const lines = fresh.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { schemaVersion: number; kind: string };
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.kind, "host.dispatch_started");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadEventLog reports malformedLineCount separately from parsed envelopes", async () => {
  const rootDir = await createTempRoot();
  try {
    const writer = createSessionEventLogWriter(rootDir, "session-corrupt");
    for (let i = 0; i < 3; i += 1) {
      await writer.append(
        createSessionEvent({
          kind: "worker.attempt_progress",
          sessionId: "session-corrupt",
          actor: "worker",
          payload: { attemptId: "attempt-1", status: "running", message: `i=${i}` },
        }),
      );
    }
    await writer.close();

    const filePath = eventLogFilePath(rootDir, "session-corrupt");
    const content = await readFile(filePath, "utf8");
    await writeFile(filePath, `${content}{ not-json\n`, "utf8");

    const loaded = await loadEventLog(rootDir, "session-corrupt");
    assert.equal(loaded.envelopes.length, 3);
    assert.equal(loaded.malformedLineCount, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadEventLog returns empty state when the log file is absent", async () => {
  const rootDir = await createTempRoot();
  try {
    const loaded = await loadEventLog(rootDir, "session-missing");
    assert.deepEqual(loaded, { envelopes: [], malformedLineCount: 0 });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
