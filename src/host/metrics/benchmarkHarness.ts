/**
 * Phase 6 Wave 6d PR11 — W7 benchmark harness.
 *
 * Shared rig consumed by `tests/benchmarks/*.bench.ts`. Each benchmark flow
 * runs end-to-end against a synthetic sandbox (stubbed abox adapter — NO real
 * spawn) and records the latency of interest into a {@link MetricsRecorder}.
 *
 * Convention:
 *   1. Do a small number of warmup iterations (not counted).
 *   2. Do `samples` measured iterations.
 *   3. Report min / median / p95 / mean of the measured set plus the full
 *      `values` array so downstream tooling can render a histogram.
 *
 * Benchmarks are deliberately NOT picked up by `mise run check` — their
 * filenames end in `.bench.ts` (compile to `.bench.js`) while the default
 * test glob is `*.test.js` (see `package.json#scripts.test`).
 */

import { MetricsRecorder, nowMs, type MetricName } from "./metricsRecorder.js";

export type BenchmarkResult = {
  name: string;
  metric: MetricName;
  samples: number;
  warmup: number;
  min: number;
  median: number;
  p95: number;
  mean: number;
  max: number;
  values: ReadonlyArray<number>;
};

export type BenchmarkSpec<T> = {
  /** Display name, e.g., "open-shell-and-resume-latest". */
  name: string;
  /** Metric key recorded per iteration. */
  metric: MetricName;
  /** Optional setup run once before any iteration. Not timed. */
  setup?: () => Promise<T> | T;
  /** The actual flow under test. Times the returned promise. */
  run: (ctx: T) => Promise<void> | void;
  /** Number of warmup iterations (not measured). Default: 3. */
  warmup?: number;
  /** Number of measured iterations. Default: 10 (matches guidance on median-of-10). */
  samples?: number;
};

const sortAsc = (arr: ReadonlyArray<number>): number[] => [...arr].sort((a, b) => a - b);
const quantile = (sorted: ReadonlyArray<number>, q: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const rank = q * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low] ?? 0;
  const fraction = rank - low;
  return (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * fraction;
};

/**
 * Drive the benchmark. Per the "warm local run" guidance in the plan
 * (line 447), the median of the measured samples is the comparison point for
 * thresholds; single timings are noisy.
 */
export const runBenchmark = async <T>(spec: BenchmarkSpec<T>): Promise<BenchmarkResult> => {
  const warmup = spec.warmup ?? 3;
  const samples = spec.samples ?? 10;
  const ctx = (spec.setup !== undefined ? await spec.setup() : (undefined as unknown)) as T;
  const recorder = new MetricsRecorder();
  for (let i = 0; i < warmup; i += 1) {
    await spec.run(ctx);
  }
  for (let i = 0; i < samples; i += 1) {
    const start = nowMs();
    await spec.run(ctx);
    recorder.record(spec.metric, nowMs() - start);
  }
  const values = recorder.getMeasurements().map((m) => m.value);
  const sorted = sortAsc(values);
  return {
    name: spec.name,
    metric: spec.metric,
    samples,
    warmup,
    min: sorted[0] ?? 0,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    mean: values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length,
    max: sorted[sorted.length - 1] ?? 0,
    values: sorted,
  };
};

/** Pretty-print a benchmark result in a stable, grep-friendly format. */
export const formatBenchmarkResult = (result: BenchmarkResult): string => {
  const fmt = (n: number): string => `${n.toFixed(2)}ms`;
  return [
    `bench=${result.name}`,
    `metric=${result.metric}`,
    `samples=${result.samples}`,
    `warmup=${result.warmup}`,
    `min=${fmt(result.min)}`,
    `median=${fmt(result.median)}`,
    `p95=${fmt(result.p95)}`,
    `mean=${fmt(result.mean)}`,
    `max=${fmt(result.max)}`,
  ].join(" ");
};

/**
 * Write a benchmark result to stdout in a format readable by a machine
 * (single JSON line) AND humans (the pretty-print above). Benchmarks run
 * manually via `node dist/tests/benchmarks/<name>.bench.js` — we emit both
 * shapes so the operator can scan the output in a terminal and a CI job can
 * grep a single JSON line.
 */
export const reportBenchmark = (result: BenchmarkResult): void => {
  const proc = (globalThis as unknown as { process?: { stdout?: { write: (s: string) => void } } })
    .process;
  const write = (s: string): void => {
    if (proc?.stdout?.write !== undefined) proc.stdout.write(s);
  };
  write(`${formatBenchmarkResult(result)}\n`);
  write(`${JSON.stringify(result)}\n`);
};
