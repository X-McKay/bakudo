/**
 * Phase 6 Wave 6d PR11 — W7 metrics recorder unit tests.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  METRIC_NAMES,
  MetricsRecorder,
  getMetricsRecorder,
  resetMetricsRecorderForTest,
  timeAsync,
  timeSync,
} from "../../src/host/metrics/metricsRecorder.js";

test("MetricsRecorder: records and aggregates multiple values for the same metric", () => {
  const r = new MetricsRecorder();
  r.record("render.ttfr_ms", 10);
  r.record("render.ttfr_ms", 20);
  r.record("render.ttfr_ms", 30);
  const snap = r.snapshot();
  const agg = snap.aggregates["render.ttfr_ms"];
  assert.ok(agg, "aggregate exists");
  assert.equal(agg.count, 3);
  assert.equal(agg.min, 10);
  assert.equal(agg.max, 30);
  assert.equal(agg.mean, 20);
  assert.equal(agg.median, 20);
  assert.deepEqual([...agg.values], [10, 20, 30]);
  assert.equal(snap.totalMeasurements, 3);
});

test("MetricsRecorder: unrecorded metric is absent from aggregates", () => {
  const r = new MetricsRecorder();
  r.record("render.ttfr_ms", 1);
  const snap = r.snapshot();
  assert.ok(!("session.list_ms" in snap.aggregates));
});

test("MetricsRecorder: marks + measureBetween record a positive delta", () => {
  const r = new MetricsRecorder();
  r.mark("start");
  // Tight loop to ensure perf.now advances predictably across fast runners.
  const end = Date.now() + 5;
  while (Date.now() < end) {
    /* busy wait */
  }
  r.mark("end");
  const delta = r.measureBetween("prompt.to_host_line_ms", "start", "end");
  assert.ok(delta !== null);
  assert.ok(delta >= 0);
  const snap = r.snapshot();
  assert.equal(snap.aggregates["prompt.to_host_line_ms"]?.count, 1);
});

test("MetricsRecorder: measureBetween returns null when either mark is missing", () => {
  const r = new MetricsRecorder();
  r.mark("only-start");
  assert.equal(r.measureBetween("shell.startup_ms", "only-start", "missing"), null);
  assert.equal(r.measureBetween("shell.startup_ms", "missing", "only-start"), null);
});

test("MetricsRecorder: incWorkflowCommand adds a count of 1 per call", () => {
  const r = new MetricsRecorder();
  r.incWorkflowCommand();
  r.incWorkflowCommand();
  r.incWorkflowCommand();
  const agg = r.snapshot().aggregates["workflow.command_count"];
  assert.ok(agg);
  assert.equal(agg.count, 3);
  assert.equal(agg.mean, 1);
});

test("MetricsRecorder: droppedBatches counter behaves as a monotonic count", () => {
  const r = new MetricsRecorder();
  assert.equal(r.getDroppedBatches(), 0);
  r.incDroppedBatch();
  r.incDroppedBatch();
  assert.equal(r.getDroppedBatches(), 2);
});

test("MetricsRecorder: reset() clears marks, measurements, and dropped counter", () => {
  const r = new MetricsRecorder();
  r.mark("a");
  r.record("render.ttfr_ms", 5);
  r.incDroppedBatch();
  r.reset();
  assert.equal(r.snapshot().totalMeasurements, 0);
  assert.equal(r.getDroppedBatches(), 0);
  assert.equal(r.getMark("a"), undefined);
});

test("MetricsRecorder: p95 is at the high end for a skewed distribution", () => {
  const r = new MetricsRecorder();
  // 99 small + 1 large — p95 should be well above the median.
  for (let i = 0; i < 99; i += 1) r.record("session.list_ms", 10);
  r.record("session.list_ms", 1000);
  const agg = r.snapshot().aggregates["session.list_ms"];
  assert.ok(agg);
  assert.equal(agg.median, 10);
  assert.ok(agg.p95 >= 10);
  assert.equal(agg.max, 1000);
});

test("timeSync: records the elapsed ms of a synchronous callback", () => {
  const r = new MetricsRecorder();
  timeSync(r, "render.ttfr_ms", () => {
    const until = Date.now() + 3;
    while (Date.now() < until) {
      /* busy wait */
    }
  });
  const agg = r.snapshot().aggregates["render.ttfr_ms"];
  assert.ok(agg);
  assert.equal(agg.count, 1);
  assert.ok(agg.mean >= 0);
});

test("timeAsync: records the elapsed ms of an async callback", async () => {
  const r = new MetricsRecorder();
  await timeAsync(r, "worker.to_review_ms", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const agg = r.snapshot().aggregates["worker.to_review_ms"];
  assert.ok(agg);
  assert.equal(agg.count, 1);
});

test("METRIC_NAMES: all six required metrics are named (plan 06 lines 430-440)", () => {
  assert.equal(METRIC_NAMES.length, 6);
  assert.ok(METRIC_NAMES.includes("shell.startup_ms"));
  assert.ok(METRIC_NAMES.includes("render.ttfr_ms"));
  assert.ok(METRIC_NAMES.includes("prompt.to_host_line_ms"));
  assert.ok(METRIC_NAMES.includes("worker.to_review_ms"));
  assert.ok(METRIC_NAMES.includes("session.list_ms"));
  assert.ok(METRIC_NAMES.includes("workflow.command_count"));
});

test("singleton: getMetricsRecorder returns the same instance until reset", () => {
  resetMetricsRecorderForTest();
  const a = getMetricsRecorder();
  const b = getMetricsRecorder();
  assert.equal(a, b);
  resetMetricsRecorderForTest();
  const c = getMetricsRecorder();
  assert.notEqual(a, c);
});
