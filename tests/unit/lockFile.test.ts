import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DEFAULT_STALE_LOCK_MS,
  SESSION_LOCK_FILE_NAME,
  SessionLockBusyError,
  acquireSessionLock,
  classifyLockStaleness,
  isPidAlive,
  readSessionLock,
  sessionLockFilePath,
} from "../../src/host/lockFile.js";

const createTempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-lock-"));

test("sessionLockFilePath: co-locates `.lock` with `session.json`", () => {
  const dir = "/tmp/foo";
  assert.equal(sessionLockFilePath(dir), join(dir, SESSION_LOCK_FILE_NAME));
});

test("acquireSessionLock: writes a well-formed lock file", async () => {
  const dir = await createTempDir();
  try {
    const handle = await acquireSessionLock("s1", dir, { pid: 12345 });
    const read = await readSessionLock(dir);
    assert.equal(read.kind, "present");
    if (read.kind !== "present") return;
    assert.equal(read.lock.sessionId, "s1");
    assert.equal(read.lock.ownerPid, 12345);
    assert.match(read.lock.acquiredAt, /^\d{4}-\d{2}-\d{2}T/);
    await handle.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireSessionLock: second acquire on same dir throws SessionLockBusyError", async () => {
  const dir = await createTempDir();
  try {
    const a = await acquireSessionLock("s1", dir, { pid: 111 });
    await assert.rejects(
      acquireSessionLock("s1", dir, { pid: 222 }),
      (error: unknown) =>
        error instanceof SessionLockBusyError && (error as SessionLockBusyError).ownerPid === 111,
    );
    await a.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireSessionLock: release removes the `.lock` file and is idempotent", async () => {
  const dir = await createTempDir();
  try {
    const handle = await acquireSessionLock("s1", dir, { pid: 7 });
    await handle.release();
    await handle.release(); // second call — must not throw
    const exists = await stat(sessionLockFilePath(dir)).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, "lock file removed after release");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: does NOT unlink a foreign lock file after a stale-break race", async () => {
  const dir = await createTempDir();
  try {
    const first = await acquireSessionLock("s1", dir, { pid: 7 });
    // Simulate another host stealing the lock after ours was considered stale.
    await writeFile(
      sessionLockFilePath(dir),
      JSON.stringify({ sessionId: "s1", ownerPid: 999, acquiredAt: "2099-01-01T00:00:00.000Z" }),
      "utf8",
    );
    await first.release();
    const read = await readSessionLock(dir);
    assert.equal(read.kind, "present");
    if (read.kind !== "present") return;
    assert.equal(read.lock.ownerPid, 999, "foreign owner's lock preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyLockStaleness: dead pid → stale(pid_dead)", () => {
  const verdict = classifyLockStaleness({
    lock: { sessionId: "s1", ownerPid: 42, acquiredAt: new Date().toISOString() },
    mtimeMs: Date.now(),
    pidAlive: () => false,
  });
  assert.deepEqual(verdict, { stale: true, reason: "pid_dead" });
});

test("classifyLockStaleness: live pid + fresh mtime → not stale", () => {
  const verdict = classifyLockStaleness({
    lock: { sessionId: "s1", ownerPid: 42, acquiredAt: new Date().toISOString() },
    mtimeMs: Date.now(),
    pidAlive: () => true,
  });
  assert.deepEqual(verdict, { stale: false });
});

test("classifyLockStaleness: live pid + aged mtime → stale(age_exceeded)", () => {
  const verdict = classifyLockStaleness({
    lock: { sessionId: "s1", ownerPid: 42, acquiredAt: new Date().toISOString() },
    mtimeMs: Date.now() - (DEFAULT_STALE_LOCK_MS + 1000),
    pidAlive: () => true,
  });
  assert.deepEqual(verdict, { stale: true, reason: "age_exceeded" });
});

test("acquireSessionLock: reclaimStale=true reclaims a stale lock", async () => {
  const dir = await createTempDir();
  try {
    // Plant a stale lock belonging to pid 99 (tests: pidAlive override).
    await writeFile(
      sessionLockFilePath(dir),
      JSON.stringify({ sessionId: "s1", ownerPid: 99, acquiredAt: "2000-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const handle = await acquireSessionLock("s1", dir, {
      pid: 1000,
      reclaimStale: true,
      pidAlive: () => false,
    });
    const read = await readSessionLock(dir);
    assert.equal(read.kind, "present");
    if (read.kind !== "present") return;
    assert.equal(read.lock.ownerPid, 1000, "reclaimed by new owner");
    await handle.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireSessionLock: reclaimStale=false refuses to break a stale lock", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(
      sessionLockFilePath(dir),
      JSON.stringify({ sessionId: "s1", ownerPid: 99, acquiredAt: "2000-01-01T00:00:00.000Z" }),
      "utf8",
    );
    await assert.rejects(
      acquireSessionLock("s1", dir, { pid: 1000, pidAlive: () => false }),
      (error: unknown) => error instanceof SessionLockBusyError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireSessionLock: corrupt lock + reclaimStale=true clears and acquires", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(sessionLockFilePath(dir), "{not json", "utf8");
    const handle = await acquireSessionLock("s1", dir, { pid: 42, reclaimStale: true });
    const read = await readSessionLock(dir);
    assert.equal(read.kind, "present");
    await handle.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireSessionLock: parallel acquires — exactly one wins, others throw", async () => {
  const dir = await createTempDir();
  try {
    const attempts = Array.from({ length: 8 }, (_, i) =>
      acquireSessionLock("concurrent", dir, { pid: 1000 + i }).then(
        (handle) => ({ ok: true as const, handle, pid: 1000 + i }),
        (error) => ({ ok: false as const, error: error as Error, pid: 1000 + i }),
      ),
    );
    const results = await Promise.all(attempts);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1, "exactly one acquire succeeds");
    assert.equal(losers.length, 7, "all others fail");
    for (const loser of losers) {
      if (loser.ok) continue;
      assert.ok(
        loser.error instanceof SessionLockBusyError,
        `loser pid=${loser.pid} threw SessionLockBusyError`,
      );
    }
    for (const winner of winners) {
      if (!winner.ok) continue;
      await winner.handle.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSessionLock: returns 'missing' when file does not exist", async () => {
  const dir = await createTempDir();
  try {
    const read = await readSessionLock(dir);
    assert.equal(read.kind, "missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readSessionLock: returns 'corrupt' for malformed JSON", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(sessionLockFilePath(dir), "garbage", "utf8");
    const read = await readSessionLock(dir);
    assert.equal(read.kind, "corrupt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isPidAlive: rejects negative/zero/non-finite PIDs", () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-5), false);
  assert.equal(isPidAlive(Number.NaN), false);
});

test("acquireSessionLock then verify raw `session.json` sibling path", async () => {
  // Ensures the lock file lives inside the session dir, not in the storage root.
  const dir = await createTempDir();
  try {
    const handle = await acquireSessionLock("sid", dir, { pid: 1 });
    const content = await readFile(sessionLockFilePath(dir), "utf8");
    assert.match(content, /"sessionId":"sid"/);
    await handle.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
