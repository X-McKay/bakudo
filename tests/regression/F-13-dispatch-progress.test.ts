import assert from "node:assert/strict";
import test from "node:test";

import { startDispatchProgress } from "../../src/host/dispatchProgress.js";

test("F-13: startDispatchProgress emits a line after the interval in text mode", () => {
  const lines: string[] = [];
  const scheduled: Array<() => void> = [];
  const cleared: unknown[] = [];
  let nowMs = 0;

  const ticker = startDispatchProgress({
    taskId: "attempt-1",
    useJson: false,
    write: (line) => lines.push(line),
    intervalMs: 10_000,
    now: () => nowMs,
    setIntervalFn: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    clearIntervalFn: (handle) => {
      cleared.push(handle);
    },
  });

  ticker.start();
  assert.equal(scheduled.length, 1);

  nowMs = 12_000;
  scheduled[0]?.();

  assert.equal(lines.length, 1);
  assert.match(
    lines[0] ?? "",
    /\.\.\. dispatching attempt-1 \(12s elapsed, awaiting first worker event\)/u,
  );

  ticker.stop();
  assert.equal(cleared.length, 1);
});

test("F-13: startDispatchProgress stays silent in json mode", () => {
  const lines: string[] = [];
  let scheduled = false;

  const ticker = startDispatchProgress({
    taskId: "attempt-1",
    useJson: true,
    write: (line) => lines.push(line),
    setIntervalFn: () => {
      scheduled = true;
      return 1;
    },
    clearIntervalFn: () => {},
  });

  ticker.start();
  ticker.stop();

  assert.equal(scheduled, false);
  assert.deepEqual(lines, []);
});
