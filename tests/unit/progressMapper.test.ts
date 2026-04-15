import assert from "node:assert/strict";
import test from "node:test";

import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { mapWorkerEventToNarration, type ProgressStage } from "../../src/host/progressMapper.js";
import {
  createProgressCoalescer,
  PROGRESS_COALESCE_INTERVAL_MS,
} from "../../src/host/progressCoalescer.js";
import type { TranscriptItem } from "../../src/host/renderModel.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";

const makeEvent = (overrides: Partial<WorkerTaskProgressEvent> = {}): WorkerTaskProgressEvent => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
  kind: "task.started",
  taskId: "task-1",
  sessionId: "session-1",
  status: "running",
  timestamp: "2026-04-15T00:00:00.000Z",
  ...overrides,
});

test("mapWorkerEventToNarration: queued / started / completed / failed emit expected lines", () => {
  const queued = mapWorkerEventToNarration(makeEvent({ kind: "task.queued", status: "queued" }));
  assert.equal(queued.stage, "queued");
  assert.equal(queued.line, "Queued sandbox attempt.");
  assert.equal(queued.tone, "info");

  const started = mapWorkerEventToNarration(makeEvent({ kind: "task.started", status: "running" }));
  assert.equal(started.stage, "started");
  assert.equal(started.line, "Sandbox worker started.");

  const completed = mapWorkerEventToNarration(
    makeEvent({ kind: "task.completed", status: "succeeded" }),
  );
  assert.equal(completed.stage, "completed");
  assert.equal(completed.line, "Worker completed. Reviewing result.");

  const failed = mapWorkerEventToNarration(makeEvent({ kind: "task.failed", status: "failed" }));
  assert.equal(failed.stage, "failed");
  assert.equal(failed.line, "Worker failed. Reviewing result.");
  assert.equal(failed.tone, "error");
});

test("mapWorkerEventToNarration: running_output suppressed on repeat", () => {
  const first = mapWorkerEventToNarration(
    makeEvent({ kind: "task.progress", status: "running" }),
    "started",
  );
  assert.equal(first.stage, "running_output");
  assert.equal(first.line, "Worker is producing output.");

  const second = mapWorkerEventToNarration(
    makeEvent({ kind: "task.progress", status: "running" }),
    "running_output",
  );
  assert.equal(second.stage, "running_output");
  assert.equal(second.line, undefined);
});

test("mapWorkerEventToNarration: timedOut escalates to timed_out stage", () => {
  const escalated = mapWorkerEventToNarration(
    makeEvent({ kind: "task.progress", status: "running", timedOut: true }),
    "running_output",
  );
  assert.equal(escalated.stage, "timed_out");
  assert.equal(escalated.line, "Worker hit its timeout and is being stopped.");
  assert.equal(escalated.tone, "warning");
});

type ManualTimer = { fn: () => void; ms: number; cancelled: boolean };

const createManualScheduler = (): {
  schedule: (callback: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  tick: () => void;
  pending: ManualTimer[];
} => {
  const pending: ManualTimer[] = [];
  return {
    pending,
    schedule(callback, ms) {
      const handle: ManualTimer = { fn: callback, ms, cancelled: false };
      pending.push(handle);
      return handle;
    },
    cancel(handle) {
      const timer = handle as ManualTimer | undefined;
      if (timer) {
        timer.cancelled = true;
      }
    },
    tick() {
      const snapshot = pending.slice();
      pending.length = 0;
      for (const timer of snapshot) {
        if (!timer.cancelled) {
          timer.fn();
        }
      }
    },
  };
};

test("coalescer: collapses repeated progress events within a 16ms window", () => {
  const items: TranscriptItem[] = [];
  const scheduler = createManualScheduler();
  const coalesce = createProgressCoalescer((item) => items.push(item), {
    scheduleFlush: scheduler.schedule,
    cancelFlush: scheduler.cancel,
  });

  coalesce(makeEvent({ kind: "task.progress", status: "running" }));
  coalesce(makeEvent({ kind: "task.progress", status: "running" }));
  coalesce(makeEvent({ kind: "task.progress", status: "running" }));

  // No emission yet; pending flush scheduled.
  assert.equal(items.length, 0);
  assert.equal(scheduler.pending.length, 1);
  assert.equal(scheduler.pending[0]?.ms, PROGRESS_COALESCE_INTERVAL_MS);

  scheduler.tick();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "assistant");
  if (items[0]?.kind === "assistant") {
    assert.equal(items[0].text, "Worker is producing output.");
  }

  // Further running events at the same stage do not re-emit.
  coalesce(makeEvent({ kind: "task.progress", status: "running" }));
  scheduler.tick();
  assert.equal(items.length, 1);
});

test("coalescer: timed_out escalation flushes immediately", () => {
  const items: TranscriptItem[] = [];
  const scheduler = createManualScheduler();
  const coalesce = createProgressCoalescer((item) => items.push(item), {
    scheduleFlush: scheduler.schedule,
    cancelFlush: scheduler.cancel,
  });

  coalesce(makeEvent({ kind: "task.progress", status: "running" }));
  // Pending, not flushed yet.
  assert.equal(items.length, 0);

  coalesce(makeEvent({ kind: "task.progress", status: "running", timedOut: true }));
  // Escalation flushed synchronously without waiting for the tick.
  assert.equal(items.length, 1);
  if (items[0]?.kind === "assistant") {
    assert.equal(items[0].tone, "warning");
    assert.match(items[0].text, /timeout/);
  }
});

test("coalescer: failed event flushes immediately", () => {
  const items: TranscriptItem[] = [];
  const coalesce = createProgressCoalescer((item) => items.push(item));
  coalesce(makeEvent({ kind: "task.failed", status: "failed" }));
  // failed is terminal + high priority so flush is synchronous.
  assert.equal(items.length, 1);
  if (items[0]?.kind === "assistant") {
    assert.equal(items[0].tone, "error");
  }
});

test("coalescer: queued -> started -> completed sequence emits three lines", () => {
  const items: TranscriptItem[] = [];
  const scheduler = createManualScheduler();
  const coalesce = createProgressCoalescer((item) => items.push(item), {
    scheduleFlush: scheduler.schedule,
    cancelFlush: scheduler.cancel,
  });

  coalesce(makeEvent({ kind: "task.queued", status: "queued" }));
  scheduler.tick();
  coalesce(makeEvent({ kind: "task.started", status: "running" }));
  scheduler.tick();
  coalesce(makeEvent({ kind: "task.completed", status: "succeeded" }));
  // completed is terminal; flush synchronous.
  assert.equal(items.length, 3);
  const stages = items.map((item) => (item.kind === "assistant" ? (item.text as string) : ""));
  assert.deepEqual(stages, [
    "Queued sandbox attempt.",
    "Sandbox worker started.",
    "Worker completed. Reviewing result.",
  ]);
});

test("coalescer: flushNow is idempotent and safe when nothing pending", () => {
  const items: TranscriptItem[] = [];
  const coalesce = createProgressCoalescer((item) => items.push(item));
  coalesce.flushNow();
  coalesce.flushNow();
  assert.equal(items.length, 0);
});

test("coalescer: lastEmittedStage reflects most recently flushed stage", () => {
  const items: TranscriptItem[] = [];
  const coalesce = createProgressCoalescer((item) => items.push(item));
  coalesce(makeEvent({ kind: "task.queued", status: "queued" }));
  coalesce.flushNow();
  const stage: ProgressStage | undefined = coalesce.lastEmittedStage();
  assert.equal(stage, "queued");
});
