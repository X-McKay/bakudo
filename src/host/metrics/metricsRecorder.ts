/**
 * Phase 6 Wave 6d PR11 — W7 Quantitative Success Metrics.
 *
 * In-memory measurement bucket for the six required UX metrics (plan 06
 * lines 430-440). Callers place named marks with {@link mark} as events occur
 * and then derive latencies with {@link measure}. Measurements are additive
 * (no collapse): each `(name, value)` pair is retained so histogram-style
 * snapshots can compute min/max/median/p95 without losing fidelity.
 *
 * This is deliberately a side-channel, NOT a new `SessionEventEnvelope` kind
 * (lock-in 6 pins the envelope at 17 kinds). If a metric ever needs to reach
 * the NDJSON stream it goes through `host.event_skipped` with
 * `skippedKind: "metric.<name>"` — never a new kind.
 *
 * The recorder uses `performance.now()` from `perf_hooks` (via the `globalThis
 * .performance` shim for uniform test behavior on Node 22).
 */

/**
 * Canonical names of the six required metrics from plan 06 lines 430-440.
 *
 * Wave 6d PR11 review blocker B2: PR11 wires **two** producers in production
 * — `shell.startup_ms` (from `bootstrap.initHost` → first render-loop paint
 * in `createSessionRenderer`) and `workflow.command_count` (one increment
 * per top-level `dispatchHostCommand` call). The other four metrics
 * (`render.ttfr_ms`, `prompt.to_host_line_ms`, `worker.to_review_ms`,
 * `session.list_ms`) are exercised today through
 * `tests/unit/metricsThresholds.test.ts` + `benchmarkHarness` and their
 * production producer wiring is explicitly deferred to the cleanup PR that
 * lands alongside PR7 N1 telemetry wiring. Removing them from
 * `METRIC_NAMES` now would break the schema contract `bakudo doctor` and
 * `bakudo metrics` publish — so we leave them declared and producer-less.
 */
export const METRIC_NAMES = [
  /** 1. shell startup latency on TTY (from process start to render-loop-ready) */
  "shell.startup_ms",
  /** 2. time-to-first-render (from render-loop start to first paint) */
  "render.ttfr_ms",
  /** 3. time from prompt submit to first semantic host line (before dispatch) */
  "prompt.to_host_line_ms",
  /** 4. time from worker completion to persisted review */
  "worker.to_review_ms",
  /** 5. session listing latency with many sessions */
  "session.list_ms",
  /** 6. number of commands needed for common workflows */
  "workflow.command_count",
  /** 7. inspect summary render from persisted data (W6E cleanup #21) */
  "inspect.render_ms",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * Individual recorded measurement. Value units are milliseconds for timings
 * and a raw count for `workflow.command_count`.
 */
export type Measurement = {
  name: MetricName;
  value: number;
  at: number;
};

/**
 * Aggregate-per-metric view produced by {@link snapshot}. `p95` uses
 * linear-interpolation percentile (simple but consistent with Node test
 * infra); callers that need fancier stats should consume `values` directly.
 */
export type MetricAggregate = {
  count: number;
  min: number;
  max: number;
  median: number;
  p95: number;
  mean: number;
  values: ReadonlyArray<number>;
};

export type MetricSnapshot = {
  aggregates: Readonly<Partial<Record<MetricName, MetricAggregate>>>;
  /** Total measurement count across all metrics. */
  totalMeasurements: number;
  /** Wall-clock time the snapshot was taken (ISO 8601 UTC). */
  takenAt: string;
  /**
   * Process-lifetime mirror of the append-only event-log writer's dropped-
   * batch counter (Wave 6d PR11 review B3). `eventLogWriter` calls
   * {@link MetricsRecorder.incDroppedBatch} at both drop sites so consumers
   * of the snapshot (`bakudo metrics`, `bakudo doctor`) surface the live
   * value without having to reach into every individual writer closure.
   */
  droppedEventBatches: number;
};

const perfNow = (): number => {
  const candidate = (globalThis as { performance?: { now: () => number } }).performance;
  if (candidate !== undefined && typeof candidate.now === "function") {
    return candidate.now();
  }
  return Date.now();
};

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? 0;
  if (lowerIndex === upperIndex) return lower;
  const fraction = rank - lowerIndex;
  return lower + (upper - lower) * fraction;
};

const aggregate = (values: ReadonlyArray<number>): MetricAggregate => {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const median = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = count === 0 ? 0 : sum / count;
  return { count, min, max, median, p95, mean, values: sorted };
};

/**
 * In-memory metric bucket. Every production instance is a singleton
 * ({@link metricsRecorder}); tests construct fresh recorders to avoid
 * cross-test pollution.
 */
export class MetricsRecorder {
  private readonly marks = new Map<string, number>();
  private readonly measurements: Measurement[] = [];
  private droppedEventBatches = 0;

  /**
   * Record a named mark at the current `performance.now()`. Overwrites any
   * previous mark with the same name — useful for start/end pairs.
   */
  public mark(name: string): void {
    this.marks.set(name, perfNow());
  }

  /**
   * Fetch the time-stamp of a previously-set mark. Returns `undefined` when
   * the mark has not been recorded.
   */
  public getMark(name: string): number | undefined {
    return this.marks.get(name);
  }

  /**
   * Compute a duration between two marks and record it under `metric`.
   * Both marks must have been recorded; otherwise returns `null` (the caller
   * decides whether a missing mark is an error or a no-op).
   */
  public measureBetween(metric: MetricName, start: string, end: string): number | null {
    const s = this.marks.get(start);
    const e = this.marks.get(end);
    if (s === undefined || e === undefined) return null;
    const delta = Math.max(0, e - s);
    this.record(metric, delta);
    return delta;
  }

  /**
   * Record a raw measurement without involving marks. Used for synchronous
   * timings measured by the caller (e.g., `const t0 = performance.now(); ...;
   * recorder.record("render.ttfr_ms", performance.now() - t0);`).
   */
  public record(name: MetricName, value: number): void {
    this.measurements.push({ name, value, at: perfNow() });
  }

  /**
   * Count increment for {@link METRIC_NAMES}[5] (command count). Chosen over
   * `record` because counters are usually built up incrementally.
   */
  public incWorkflowCommand(): void {
    this.record("workflow.command_count", 1);
  }

  /**
   * Record a dropped-batch occurrence for the {@link SpanRecorder}
   * (PR7)-style durability counter. Separate from the measurement bucket so
   * snapshots can surface it as a scalar.
   */
  public incDroppedBatch(): void {
    this.droppedEventBatches += 1;
  }

  public getDroppedBatches(): number {
    return this.droppedEventBatches;
  }

  public reset(): void {
    this.marks.clear();
    this.measurements.length = 0;
    this.droppedEventBatches = 0;
  }

  public getMeasurements(): ReadonlyArray<Measurement> {
    return this.measurements.slice();
  }

  /**
   * Derive per-metric aggregates. Metrics with zero recorded values are
   * omitted from the `aggregates` map so callers can distinguish "not yet
   * measured" from "measured as zero".
   */
  public snapshot(): MetricSnapshot {
    const bucket = new Map<MetricName, number[]>();
    for (const m of this.measurements) {
      const arr = bucket.get(m.name) ?? [];
      arr.push(m.value);
      bucket.set(m.name, arr);
    }
    const aggregates: Partial<Record<MetricName, MetricAggregate>> = {};
    for (const [name, values] of bucket) {
      aggregates[name] = aggregate(values);
    }
    return {
      aggregates,
      totalMeasurements: this.measurements.length,
      takenAt: new Date().toISOString(),
      droppedEventBatches: this.droppedEventBatches,
    };
  }
}

/**
 * Singleton recorder used by production call-sites. Tests MUST construct
 * their own {@link MetricsRecorder} to avoid cross-test pollution — the
 * singleton persists for the life of the Node process.
 */
let singleton: MetricsRecorder | null = null;

export const getMetricsRecorder = (): MetricsRecorder => {
  if (singleton === null) singleton = new MetricsRecorder();
  return singleton;
};

/** Test-only hook — resets the singleton so tests start with a clean bucket. */
export const resetMetricsRecorderForTest = (): void => {
  singleton = null;
};

/** Convenience wrapper for callers that don't need a fully featured marker. */
export const timeSync = <T>(recorder: MetricsRecorder, metric: MetricName, fn: () => T): T => {
  const start = perfNow();
  const result = fn();
  recorder.record(metric, perfNow() - start);
  return result;
};

/** Async variant of {@link timeSync}. */
export const timeAsync = async <T>(
  recorder: MetricsRecorder,
  metric: MetricName,
  fn: () => Promise<T>,
): Promise<T> => {
  const start = perfNow();
  const result = await fn();
  recorder.record(metric, perfNow() - start);
  return result;
};

/** Exported so benchmarks can share a single high-resolution clock source. */
export const nowMs = (): number => perfNow();
