/**
 * Phase 6 Wave 6d PR11 review blocker B2 — production producer wiring tests.
 *
 * PR11's first commit landed the {@link MetricsRecorder} + `bakudo metrics`
 * command but hooked *zero* producers into the production singleton (only
 * bootstrap's `shell.startup_begin` mark was recorded — no `measureBetween`,
 * no command counter). The command surface therefore reported zero for every
 * metric in real deployments; only threshold/benchmark tests populated
 * local recorders.
 *
 * This file asserts the two minimum-viable producers are wired:
 *
 *   1. `shell.startup_ms` — the first tick of a session renderer closes the
 *      `shell.startup_begin` → `shell.startup_done` pair and records the
 *      delta under `shell.startup_ms`.
 *   2. `workflow.command_count` — every top-level call to
 *      `dispatchHostCommand` increments the counter by exactly one.
 *
 * The other four required metrics (`render.ttfr_ms`, `prompt.to_host_line_ms`,
 * `worker.to_review_ms`, `session.list_ms`) are still producer-less in
 * production code today and land in the PR7 N1 telemetry wiring cleanup —
 * see the `METRIC_NAMES` deferral comment in `metrics/metricsRecorder.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { dispatchHostCommand } from "../../src/host/interactive.js";
import { createSessionRenderer } from "../../src/host/interactiveRenderLoop.js";
import {
  getMetricsRecorder,
  resetMetricsRecorderForTest,
} from "../../src/host/metrics/metricsRecorder.js";
import { parseHostArgs } from "../../src/host/parsing.js";
import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { createHostStore } from "../../src/host/store/index.js";
import { withCapturedStdout } from "../../src/host/io.js";

const newStore = () => createHostStore(reduceHost, initialHostAppState());

const sinkWriter = { write: () => true };

/**
 * Monkey-patch `process.stdout.write` for the duration of `fn` so the
 * session renderer's plain backend (which writes directly to the stream
 * the backend was constructed with) does not pollute the test output.
 * `withCapturedStdout` only routes `stdoutWrite` callers through its
 * interceptor, not direct-stream writers.
 */
const withSilentStdout = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  const stream = (globalThis as unknown as { process: { stdout: { write: unknown } } }).process
    .stdout;
  const prior = stream.write;
  stream.write = (() => true) as unknown as typeof stream.write;
  try {
    return await fn();
  } finally {
    stream.write = prior;
  }
};

test("producer B2.1: session renderer's first paint records shell.startup_ms", async () => {
  // Mirror bootstrap: the `shell.startup_begin` mark is set as the first
  // thing `initHost` does (see `bootstrap.ts`). Here we set it directly so
  // the test does not depend on a full bootstrap.
  resetMetricsRecorderForTest();
  const recorder = getMetricsRecorder();
  recorder.mark("shell.startup_begin");

  // createSessionRenderer returns a `tick`; the first invocation should
  // close the startup pair.
  await withSilentStdout(() => {
    const { tick, backend } = createSessionRenderer({ store: newStore() });
    try {
      tick({ transcript: [], appState: initialHostAppState() });
    } finally {
      backend.dispose?.();
    }
  });

  const snap = recorder.snapshot();
  const startup = snap.aggregates["shell.startup_ms"];
  assert.ok(
    startup !== undefined,
    "first paint must populate shell.startup_ms under the singleton recorder",
  );
  assert.ok(startup.count === 1, `expected exactly one startup measurement, got ${startup.count}`);
  assert.ok(
    startup.max >= 0,
    `startup duration must be a non-negative number of ms, got ${startup.max}`,
  );
});

test("producer B2.1: second paint does NOT record a duplicate shell.startup_ms", async () => {
  // Guard against drift — only the first paint is load-bearing for
  // time-to-first-render. Re-recording on every frame would skew the p95
  // toward zero after the shell has been running a while.
  resetMetricsRecorderForTest();
  const recorder = getMetricsRecorder();
  recorder.mark("shell.startup_begin");

  await withSilentStdout(() => {
    const { tick, backend } = createSessionRenderer({ store: newStore() });
    try {
      tick({ transcript: [], appState: initialHostAppState() });
      tick({ transcript: [], appState: initialHostAppState() });
      tick({ transcript: [], appState: initialHostAppState() });
    } finally {
      backend.dispose?.();
    }
  });

  const snap = recorder.snapshot();
  const startup = snap.aggregates["shell.startup_ms"];
  assert.ok(startup !== undefined);
  assert.equal(startup.count, 1, "startup must be recorded exactly once per session");
});

test("producer B2.2: dispatchHostCommand increments workflow.command_count by N for N dispatches", async () => {
  resetMetricsRecorderForTest();
  const recorder = getMetricsRecorder();

  // `version` is the cheapest dispatch (no disk, no abox, no session
  // lookup) — good fit for a counter-only assertion.
  const runs = 4;
  for (let i = 0; i < runs; i += 1) {
    const args = parseHostArgs(["version"]);
    await withCapturedStdout(sinkWriter, () => dispatchHostCommand(args));
  }

  const snap = recorder.snapshot();
  const counter = snap.aggregates["workflow.command_count"];
  assert.ok(counter !== undefined, "workflow.command_count must be populated after dispatch");
  assert.equal(counter.count, runs);
  // Each increment records a raw `1`, so count === sum of values.
  assert.equal(counter.min, 1);
  assert.equal(counter.max, 1);
});

test("producer B2.2: snapshot exposes live workflow.command_count for `bakudo metrics`", async () => {
  // End-to-end check: running N host commands then reading the singleton
  // snapshot (the shape `buildMetricsSection`, `buildMetricsReport`, and
  // `bakudo doctor` all share) surfaces the live counter — not zero.
  resetMetricsRecorderForTest();
  const recorder = getMetricsRecorder();

  const runs = 3;
  for (let i = 0; i < runs; i += 1) {
    const args = parseHostArgs(["help"]);
    await withCapturedStdout(sinkWriter, () => dispatchHostCommand(args));
  }

  const measurements = recorder.getMeasurements();
  const commandEvents = measurements.filter((m) => m.name === "workflow.command_count");
  assert.equal(commandEvents.length, runs);
});
