/**
 * Phase 6 Wave 6d PR11 — `bakudo metrics` command unit tests.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { withCapturedStdout } from "../../src/host/io.js";
import {
  buildMetricsReport,
  formatMetricsReport,
  runMetricsCommand,
} from "../../src/host/commands/metrics.js";
import {
  getMetricsRecorder,
  resetMetricsRecorderForTest,
} from "../../src/host/metrics/metricsRecorder.js";

const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

test("buildMetricsReport: empty recorder yields totals=0 and no per-metric rows", () => {
  resetMetricsRecorderForTest();
  const report = buildMetricsReport();
  assert.equal(report.totalMeasurements, 0);
  assert.equal(report.droppedEventBatches, 0);
  assert.equal(report.metrics.length, 0);
});

test("buildMetricsReport: surfaces recorded metrics in canonical order", () => {
  resetMetricsRecorderForTest();
  const r = getMetricsRecorder();
  r.record("render.ttfr_ms", 42);
  r.record("session.list_ms", 11);
  r.record("session.list_ms", 9);
  const report = buildMetricsReport();
  const names = report.metrics.map((m) => m.name);
  // METRIC_NAMES order: shell.startup, render.ttfr, prompt.to_host, worker.to_review, session.list, workflow.command_count.
  assert.deepEqual(names, ["render.ttfr_ms", "session.list_ms"]);
  const listMs = report.metrics.find((m) => m.name === "session.list_ms");
  assert.ok(listMs);
  assert.equal(listMs.count, 2);
  assert.equal(listMs.min, 9);
  assert.equal(listMs.max, 11);
});

test("formatMetricsReport: empty report mentions 'no measurements recorded yet'", () => {
  resetMetricsRecorderForTest();
  const lines = formatMetricsReport(buildMetricsReport());
  assert.ok(lines.some((l) => l.includes("no measurements recorded yet")));
});

test("formatMetricsReport: populated report contains a tabular body", () => {
  resetMetricsRecorderForTest();
  getMetricsRecorder().record("render.ttfr_ms", 15);
  const lines = formatMetricsReport(buildMetricsReport());
  assert.ok(lines.some((l) => l.includes("name")));
  assert.ok(lines.some((l) => l.includes("render.ttfr_ms")));
});

test("runMetricsCommand: --format=json prints exactly one JSON envelope", async () => {
  resetMetricsRecorderForTest();
  getMetricsRecorder().record("shell.startup_ms", 123);
  const cap = capture();
  const result = await withCapturedStdout(cap.writer, () =>
    runMetricsCommand({ args: ["--format=json"], stdoutIsTty: false }),
  );
  const body = cap.chunks.join("").trim();
  const parsed = JSON.parse(body) as {
    totalMeasurements: number;
    metrics: Array<{ name: string }>;
  };
  assert.ok(parsed.totalMeasurements > 0);
  assert.ok(parsed.metrics.some((m) => m.name === "shell.startup_ms"));
  assert.equal(result.exitCode, 0);
});

test("runMetricsCommand: --json alias matches --format=json (lock-in 12: TTY-independent)", async () => {
  resetMetricsRecorderForTest();
  const cap = capture();
  await withCapturedStdout(cap.writer, () =>
    runMetricsCommand({ args: ["--json"], stdoutIsTty: true }),
  );
  const body = cap.chunks.join("").trim();
  // Must parse as JSON even though stdoutIsTty=true.
  const parsed = JSON.parse(body) as { totalMeasurements: number };
  assert.equal(typeof parsed.totalMeasurements, "number");
});

test("runMetricsCommand: non-TTY default is JSON (machine-readable by default)", async () => {
  resetMetricsRecorderForTest();
  const cap = capture();
  await withCapturedStdout(cap.writer, () => runMetricsCommand({ args: [], stdoutIsTty: false }));
  const body = cap.chunks.join("").trim();
  // Non-TTY defaults to JSON output — body is parseable JSON.
  assert.doesNotThrow(() => JSON.parse(body));
});

test("runMetricsCommand: TTY default is text (human-readable by default)", async () => {
  resetMetricsRecorderForTest();
  const cap = capture();
  await withCapturedStdout(cap.writer, () => runMetricsCommand({ args: [], stdoutIsTty: true }));
  const body = cap.chunks.join("");
  assert.ok(body.includes("bakudo metrics"));
});

test("runMetricsCommand: unknown flag returns exit code 2 with user-input error", async () => {
  resetMetricsRecorderForTest();
  const cap = capture();
  const result = await withCapturedStdout(cap.writer, () =>
    runMetricsCommand({ args: ["--bogus"], stdoutIsTty: false }),
  );
  assert.equal(result.exitCode, 2);
  assert.ok(result.error?.includes("unknown flag"));
});

test("runMetricsCommand: --format=xml (invalid value) returns exit code 2", async () => {
  resetMetricsRecorderForTest();
  const cap = capture();
  const result = await withCapturedStdout(cap.writer, () =>
    runMetricsCommand({ args: ["--format=xml"], stdoutIsTty: false }),
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.error ?? "", /text.*json|'text'.*'json'/u);
});

test("runMetricsCommand: parse error in JSON mode emits canonical error envelope (lock-in 19)", async () => {
  // Wave 6d PR11 review blocker B1: when the caller asked for `--format=json`
  // and the argv parser then rejects an *adjacent* typo, we must surface the
  // failure as `{ok:false, kind:"error", error:{code,message,details?}}`
  // instead of a plain line. Mirrors the PR8 precedent in chronicle / usage.
  resetMetricsRecorderForTest();
  const cap = capture();
  const result = await withCapturedStdout(cap.writer, () =>
    runMetricsCommand({ args: ["--sinc", "1d", "--format=json"], stdoutIsTty: false }),
  );
  assert.equal(result.exitCode, 2);
  const body = cap.chunks.join("").trim();
  const parsed = JSON.parse(body) as {
    ok: boolean;
    kind: string;
    error: { code: string; message: string };
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.kind, "error");
  assert.equal(parsed.error.code, "user_input");
  assert.ok(parsed.error.message.length > 0);
});

test("runMetricsCommand: parse error in text mode still emits a plain diagnostic line", async () => {
  // Confirm the plain-text path is preserved for interactive TTY callers —
  // only JSON-requesting callers get the envelope.
  resetMetricsRecorderForTest();
  const cap = capture();
  const result = await withCapturedStdout(cap.writer, () =>
    runMetricsCommand({ args: ["--sinc", "1d", "--format=text"], stdoutIsTty: true }),
  );
  assert.equal(result.exitCode, 2);
  const body = cap.chunks.join("").trim();
  // Not JSON: trying to parse throws.
  assert.throws(() => JSON.parse(body));
  assert.ok(body.includes("metrics:"));
});
