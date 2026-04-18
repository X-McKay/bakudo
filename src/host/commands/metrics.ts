/**
 * Phase 6 Wave 6d PR11 — `bakudo metrics` command.
 *
 * Prints the current in-memory {@link MetricsRecorder} snapshot. Analogous
 * to `bakudo doctor`: text output for TTY, a single JSON line for
 * `--format=json` (lock-in 12: `--json` is TTY-independent).
 *
 * This surface is intentionally minimal — the primary deliverable is the
 * measurement layer itself; the command makes the bucket observable
 * without a test run.
 */

import type { HostCommandSpec } from "../commandRegistry.js";
import { stdoutWrite } from "../io.js";
import { getMetricsRecorder, METRIC_NAMES } from "../metrics/metricsRecorder.js";

export type MetricsCommandArgs = {
  format: "text" | "json";
};

export type MetricsCommandInput = {
  args: ReadonlyArray<string>;
  stdoutIsTty?: boolean;
};

export type MetricsReport = {
  takenAt: string;
  totalMeasurements: number;
  droppedEventBatches: number;
  metrics: ReadonlyArray<{
    name: string;
    count: number;
    min: number;
    median: number;
    p95: number;
    max: number;
    mean: number;
  }>;
};

const parseMetricsArgs = (
  args: ReadonlyArray<string>,
  isTty: boolean,
): { ok: true; args: MetricsCommandArgs } | { ok: false; error: string } => {
  let format: "text" | "json" | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg.includes("=") ? arg.slice("--format=".length) : args[i + 1];
      if (value !== "text" && value !== "json") {
        return { ok: false, error: "metrics: --format must be 'text' or 'json'" };
      }
      format = value;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--text") {
      format = "text";
      continue;
    }
    return { ok: false, error: `metrics: unknown flag: ${arg}` };
  }
  return { ok: true, args: { format: format ?? (isTty ? "text" : "json") } };
};

/** Build a stable, ordered {@link MetricsReport} from the live recorder. */
export const buildMetricsReport = (): MetricsReport => {
  const r = getMetricsRecorder();
  const snap = r.snapshot();
  const metrics: MetricsReport["metrics"] = METRIC_NAMES.flatMap((name) => {
    const agg = snap.aggregates[name];
    if (agg === undefined) return [];
    return [
      {
        name,
        count: agg.count,
        min: agg.min,
        median: agg.median,
        p95: agg.p95,
        max: agg.max,
        mean: agg.mean,
      },
    ];
  });
  return {
    takenAt: snap.takenAt,
    totalMeasurements: snap.totalMeasurements,
    droppedEventBatches: r.getDroppedBatches(),
    metrics,
  };
};

/** Render a human-readable view of {@link MetricsReport}. */
export const formatMetricsReport = (report: MetricsReport): string[] => {
  const fmt = (n: number): string => n.toFixed(2);
  const header = [
    "bakudo metrics",
    `taken-at: ${report.takenAt}`,
    `measurements: ${report.totalMeasurements}`,
    `dropped-event-batches: ${report.droppedEventBatches}`,
    "",
  ];
  if (report.metrics.length === 0) {
    return [...header, "(no measurements recorded yet)"];
  }
  const table = [
    "name                         count  min     median  p95     max     mean",
    "---------------------------  -----  ------  ------  ------  ------  ------",
  ];
  for (const m of report.metrics) {
    const name = m.name.padEnd(27);
    const count = String(m.count).padStart(5);
    table.push(
      `${name}  ${count}  ${fmt(m.min).padStart(6)}  ${fmt(m.median).padStart(6)}  ${fmt(m.p95).padStart(6)}  ${fmt(m.max).padStart(6)}  ${fmt(m.mean).padStart(6)}`,
    );
  }
  return [...header, ...table];
};

/** One-shot CLI entrypoint for `bakudo metrics`. */
export const runMetricsCommand = async (
  input: MetricsCommandInput,
): Promise<{ report?: MetricsReport; exitCode: number; error?: string }> => {
  const parsed = parseMetricsArgs(input.args, input.stdoutIsTty ?? false);
  if (!parsed.ok) {
    stdoutWrite(`${parsed.error}\n`);
    return { exitCode: 2, error: parsed.error };
  }
  const report = buildMetricsReport();
  if (parsed.args.format === "json") {
    stdoutWrite(`${JSON.stringify(report)}\n`);
  } else {
    stdoutWrite(`${formatMetricsReport(report).join("\n")}\n`);
  }
  return { report, exitCode: 0 };
};

/** In-shell `/metrics` handler. Always text-mode inside the shell. */
export const metricsCommandSpec: HostCommandSpec = {
  name: "metrics",
  group: "system",
  description: "Show the in-memory UX metrics snapshot (counts, median, p95).",
  handler: async ({ deps }) => {
    const report = buildMetricsReport();
    for (const line of formatMetricsReport(report)) {
      deps.transcript.push({ kind: "event", label: "metrics", detail: line });
    }
  },
};
