import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SessionStore } from "../../src/sessionStore.js";
import {
  SessionLockBusyError,
  SessionLockNotHeldError,
  acquireSessionLock,
} from "../../src/host/lockFile.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-store-lock-"));

test("SessionStore enforceLock=true: writes without a held lock throw", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root, { enforceLock: true });
    // `createSession` acquires its own lock internally, so we need a
    // second-write path. Pre-seed the session using a no-enforcement store,
    // then attempt to write through an enforcement store.
    const seeder = new SessionStore(root, { enforceLock: false });
    await seeder.createSession({
      sessionId: "s-1",
      goal: "seed",
      repoRoot: ".",
      createdAt: "2026-04-18T10:00:00.000Z",
    });
    // Now attempt to saveSession on the enforcement store without acquiring.
    const existing = await store.loadSession("s-1");
    assert.ok(existing !== null);
    if (existing === null) return;
    await assert.rejects(
      store.saveSession({ ...existing, status: "planned" }),
      (error: unknown) => error instanceof SessionLockNotHeldError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStore enforceLock=false: legacy writes succeed without a held lock", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root); // default: enforceLock=false
    const created = await store.createSession({
      sessionId: "s-legacy",
      goal: "legacy",
      repoRoot: ".",
      createdAt: "2026-04-18T10:00:00.000Z",
    });
    assert.equal(created.sessionId, "s-legacy");
    const loaded = await store.loadSession("s-legacy");
    assert.equal(loaded?.sessionId, "s-legacy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStore.withLock: grants a lock handle and releases on exit", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root, { enforceLock: true });
    const created = await store.createSession({
      sessionId: "s-withlock",
      goal: "test",
      repoRoot: ".",
    });
    // Second write must go through withLock.
    await store.withLock(created.sessionId, async () => {
      await store.saveSession({ ...created, status: "completed" });
    });
    // After withLock returns, a further write should fail again.
    await assert.rejects(
      store.saveSession({ ...created, status: "failed" }),
      (error: unknown) => error instanceof SessionLockNotHeldError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStore.withLock: re-entrant acquires are merged", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root, { enforceLock: true });
    await store.createSession({
      sessionId: "s-reentrant",
      goal: "re",
      repoRoot: ".",
    });
    let inner = 0;
    await store.withLock("s-reentrant", async () => {
      await store.withLock("s-reentrant", async () => {
        inner += 1;
      });
    });
    assert.equal(inner, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrency: two writers compete — only one wins the write, the other sees SessionLockBusyError", async () => {
  const root = await createTempRoot();
  try {
    // Prime the session via a non-enforcement store (this is the test seed
    // path; in production both writers would race at `createAndRunFirstTurn`
    // entry, and `createSession` auto-acquires, so the first writer wins).
    const seeder = new SessionStore(root, { enforceLock: false });
    await seeder.createSession({ sessionId: "s-race", goal: "race", repoRoot: "." });

    // Writer A acquires the lock and holds it during its mutation.
    const storeA = new SessionStore(root, { enforceLock: true });
    const storeB = new SessionStore(root, { enforceLock: true });

    let winner: "A" | "B" | null = null;
    const loserErrors: unknown[] = [];

    const jobA = storeA.withLock("s-race", async () => {
      winner ??= "A";
      // Artificial hold — during this window, storeB's acquire must fail.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    });

    // Kick off B slightly later so it's guaranteed to hit A's lock.
    const jobB = (async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      try {
        await storeB.withLock("s-race", async () => {
          winner ??= "B";
        });
      } catch (error) {
        loserErrors.push(error);
      }
    })();

    await Promise.all([jobA, jobB]);
    assert.equal(winner, "A", "first acquirer wins");
    assert.equal(loserErrors.length, 1, "second writer threw");
    assert.ok(
      loserErrors[0] instanceof SessionLockBusyError,
      "loser error is SessionLockBusyError",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrency: direct two-store lock race (no withLock) — one wins, one SessionLockBusy", async () => {
  const root = await createTempRoot();
  try {
    const dir = join(root, "sid");
    const results = await Promise.allSettled([
      acquireSessionLock("sid", dir, { pid: 1 }),
      acquireSessionLock("sid", dir, { pid: 2 }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    assert.equal(winners.length, 1, "one acquire fulfilled");
    assert.equal(losers.length, 1, "one acquire rejected");
    assert.ok(
      losers[0]!.status === "rejected" && losers[0]!.reason instanceof SessionLockBusyError,
    );
    for (const result of winners) {
      if (result.status !== "fulfilled") continue;
      await result.value.release();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStore.registerLock: externally-acquired lock authorises subsequent writes", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root, { enforceLock: true });
    await store.createSession({ sessionId: "s-register", goal: "reg", repoRoot: "." });
    const handle = await acquireSessionLock("s-register", store.paths("s-register").sessionDir, {
      pid: 1234,
    });
    const unregister = store.registerLock(handle);
    try {
      const existing = await store.loadSession("s-register");
      await store.saveSession({ ...existing!, status: "completed" });
    } finally {
      unregister();
      await handle.release();
    }
    // After unregister, new writes must fail.
    const existing = await store.loadSession("s-register");
    await assert.rejects(
      store.saveSession({ ...existing!, status: "failed" }),
      (error: unknown) => error instanceof SessionLockNotHeldError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
