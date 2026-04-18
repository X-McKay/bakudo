/**
 * Phase 6 Wave 6d PR11 — factor the metrics-section builder out of
 * `doctor.ts` so the command module stays under the 400-LOC cap. The
 * section surfaces the singleton {@link MetricsRecorder} snapshot in a
 * shape operators can eyeball ("count / median / p95") without reading
 * every raw value.
 */

import { getMetricsRecorder } from "./metricsRecorder.js";

export type DoctorMetricsSection = {
  totalMeasurements: number;
  droppedEventBatches: number;
  aggregates: Readonly<Record<string, { count: number; median: number; p95: number }>>;
};

/** Build the compact `metrics` envelope section for `bakudo doctor`. */
export const buildMetricsSection = (): DoctorMetricsSection => {
  const r = getMetricsRecorder();
  const snap = r.snapshot();
  const aggregates: Record<string, { count: number; median: number; p95: number }> = {};
  for (const [name, agg] of Object.entries(snap.aggregates)) {
    if (agg !== undefined) {
      aggregates[name] = { count: agg.count, median: agg.median, p95: agg.p95 };
    }
  }
  return {
    totalMeasurements: snap.totalMeasurements,
    droppedEventBatches: r.getDroppedBatches(),
    aggregates,
  };
};
