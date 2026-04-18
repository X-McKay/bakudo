/**
 * Wave 6c PR7 / A6.6 — automatic heap snapshots at RSS threshold.
 *
 * Plan lines 927-936. Covers:
 *
 *   - Gate env var `BAKUDO_AUTO_HEAP_SNAPSHOT=1`.
 *   - Default threshold is 2 GiB; override via
 *     `BAKUDO_HEAP_SNAPSHOT_RSS_THRESHOLD_BYTES`.
 *   - Filename shape: `heap-{pid}-{iso}.heapsnapshot`.
 *   - Retention of 3 snapshots via `rotateHeapSnapshots`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_HEAP_RSS_THRESHOLD_BYTES,
  HEAP_SNAPSHOTS_KEEP,
  HEAP_WATCHDOG_GATE_ENV,
  HEAP_RSS_THRESHOLD_ENV,
  isWatchdogEnabled,
  parseThresholdEnv,
  rotateHeapSnapshots,
  startHeapWatchdog,
} from "../../src/host/telemetry/heapWatchdog.js";

test("DEFAULT_HEAP_RSS_THRESHOLD_BYTES matches plan default of 2 GiB", () => {
  assert.equal(DEFAULT_HEAP_RSS_THRESHOLD_BYTES, 2 * 1024 * 1024 * 1024);
});

test("HEAP_SNAPSHOTS_KEEP is 3 per plan A6.6 rotation requirement", () => {
  assert.equal(HEAP_SNAPSHOTS_KEEP, 3);
});

test("gate env var name is BAKUDO_AUTO_HEAP_SNAPSHOT", () => {
  assert.equal(HEAP_WATCHDOG_GATE_ENV, "BAKUDO_AUTO_HEAP_SNAPSHOT");
});

test("threshold env var name matches the plan", () => {
  assert.equal(HEAP_RSS_THRESHOLD_ENV, "BAKUDO_HEAP_SNAPSHOT_RSS_THRESHOLD_BYTES");
});

test("isWatchdogEnabled: only '1' turns the watchdog on", () => {
  assert.equal(isWatchdogEnabled({ BAKUDO_AUTO_HEAP_SNAPSHOT: "1" }), true);
  assert.equal(isWatchdogEnabled({ BAKUDO_AUTO_HEAP_SNAPSHOT: "true" }), false);
  assert.equal(isWatchdogEnabled({ BAKUDO_AUTO_HEAP_SNAPSHOT: "0" }), false);
  assert.equal(isWatchdogEnabled({}), false);
});

test("parseThresholdEnv: valid number overrides the default", () => {
  assert.equal(parseThresholdEnv("12345"), 12345);
});

test("parseThresholdEnv: invalid input falls back to default", () => {
  assert.equal(parseThresholdEnv(undefined), DEFAULT_HEAP_RSS_THRESHOLD_BYTES);
  assert.equal(parseThresholdEnv(""), DEFAULT_HEAP_RSS_THRESHOLD_BYTES);
  assert.equal(parseThresholdEnv("abc"), DEFAULT_HEAP_RSS_THRESHOLD_BYTES);
  assert.equal(parseThresholdEnv("-5"), DEFAULT_HEAP_RSS_THRESHOLD_BYTES);
});

test("startHeapWatchdog: checkNow returns null when RSS is below threshold", async () => {
  const handle = startHeapWatchdog({
    intervalMs: 60_000, // never actually fires within the test
    thresholdBytes: 1_000_000_000,
    rssProbe: () => 500_000_000,
    writeSnapshot: async () => "never-called",
  });
  try {
    const out = await handle.checkNow();
    assert.equal(out, null);
    assert.equal(handle.lastSnapshot(), null);
  } finally {
    handle.stop();
  }
});

test("startHeapWatchdog: checkNow writes a snapshot when RSS exceeds threshold and rotates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-heap-"));
  try {
    const writes: string[] = [];
    const handle = startHeapWatchdog({
      intervalMs: 60_000,
      thresholdBytes: 100,
      logDir: dir,
      keep: 3,
      rssProbe: () => 1_000,
      writeSnapshot: async (path) => {
        writes.push(path);
        await writeFile(path, "snapshot-body", "utf8");
        return path;
      },
    });
    try {
      const p1 = await handle.checkNow();
      const p2 = await handle.checkNow();
      const p3 = await handle.checkNow();
      const p4 = await handle.checkNow();
      assert.ok(p1 !== null);
      assert.ok(p2 !== null);
      assert.ok(p3 !== null);
      assert.ok(p4 !== null);
      const remaining = await readdir(dir);
      const snapshots = remaining.filter((n) => n.endsWith(".heapsnapshot"));
      assert.ok(snapshots.length <= 3, `expected <=3, got ${snapshots.length}`);
      // Each call produced a file; rotation trimmed the older ones.
      assert.equal(writes.length, 4);
      assert.ok(handle.lastSnapshot() !== null);
    } finally {
      handle.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startHeapWatchdog: stop is idempotent", () => {
  const handle = startHeapWatchdog({
    intervalMs: 60_000,
    thresholdBytes: 100,
    rssProbe: () => 0,
    writeSnapshot: async () => "x",
  });
  handle.stop();
  handle.stop();
  // No throw = pass.
});

test("rotateHeapSnapshots: keeps only `keep` newest snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-heap-"));
  try {
    for (let i = 0; i < 5; i += 1) {
      await writeFile(
        join(dir, `heap-42-2026-04-15T12-00-${String(i).padStart(2, "0")}-000Z.heapsnapshot`),
        "x",
        "utf8",
      );
      await new Promise((res) => setTimeout(res, 6));
    }
    const removed = await rotateHeapSnapshots(dir, 3);
    assert.equal(removed.length, 2);
    const remaining = await readdir(dir);
    assert.equal(remaining.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotateHeapSnapshots: non-heap files are left alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-heap-"));
  try {
    await writeFile(join(dir, "random.txt"), "x", "utf8");
    await writeFile(join(dir, "heap-1-a.heapsnapshot"), "x", "utf8");
    const removed = await rotateHeapSnapshots(dir, 3);
    assert.equal(removed.length, 0);
    const remaining = await readdir(dir);
    assert.ok(remaining.includes("random.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
