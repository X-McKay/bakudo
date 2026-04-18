/**
 * Phase 6 Wave 6d A6.10 edge #4 — Configuration-inheritance disputes.
 *
 * When the user sees unexpected config behavior, `bakudo doctor
 * --explain-config <key>` should be able to answer "which config layer
 * set this key" (plan 06 line 960). This module is the pure lookup —
 * it walks the already-loaded cascade layers in reverse precedence
 * (highest-precedence-first) and reports the first layer whose config
 * object owns a non-undefined value for the key.
 *
 * Kept tiny + separate so `doctor.ts` stays under the 400-LOC cap.
 */

import type { BakudoConfig, ConfigLayer } from "./config.js";
import { loadConfigCascade } from "./config.js";
import { stdoutWrite } from "./io.js";
import { repoRootFor } from "./orchestration.js";

/**
 * Result of an explain-config lookup. `layer` is `null` when no layer
 * declares the key (i.e. the effective value is the compiled default and
 * no user layer overrode it — the `defaults` layer matches in that case
 * since it ALWAYS has every key present).
 */
export type ExplainConfigReport = {
  key: string;
  effectiveValue: unknown;
  layerSource: string | null;
  /** All layers we checked, newest → oldest (highest precedence first). */
  checkedLayers: string[];
};

const DOTTED_PATH_SEPARATOR = /\./;

/**
 * Follow a dotted path inside a config object. Returns `undefined` when
 * any segment is missing. Arrays index numerically (`logs.0`).
 */
const pathLookup = (root: unknown, path: string): unknown => {
  const segments = path.split(DOTTED_PATH_SEPARATOR).filter((s) => s.length > 0);
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    const keyed = current as Record<string, unknown>;
    if (!(segment in keyed)) return undefined;
    current = keyed[segment];
  }
  return current;
};

/**
 * Find the first (highest-precedence) layer that declares the given key.
 * Walks `layers` from the end of the array (last-merged, highest priority
 * in {@link loadConfigCascade}) backwards to the front (`defaults`, lowest
 * priority).
 *
 * The `defaults` layer is always present and always has every compiled
 * default key, so when a user-layer override exists this returns the
 * user layer; when no override exists, `defaults` wins. The caller can
 * distinguish "explicitly configured" vs "compiled default" by looking
 * at the returned `layerSource` string.
 */
export const explainConfigKey = (layers: ConfigLayer[], key: string): ExplainConfigReport => {
  const checked: string[] = [];
  let effectiveValue: unknown = undefined;
  let layerSource: string | null = null;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (layer === undefined) continue;
    checked.push(layer.source);
    const value = pathLookup(layer.config as BakudoConfig, key);
    if (value !== undefined) {
      effectiveValue = value;
      layerSource = layer.source;
      break;
    }
  }
  return { key, effectiveValue, layerSource, checkedLayers: checked };
};

/**
 * Extract `--explain-config <key>` (or `=<key>`) from a doctor flag array.
 * Returns the key string when present, `null` otherwise. Wave 6d A6.10 #4.
 */
export const parseExplainConfigFlag = (args: string[]): string | null => {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--explain-config") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
      return null;
    }
    if (arg.startsWith("--explain-config=")) {
      return arg.slice("--explain-config=".length);
    }
  }
  return null;
};

/**
 * Execute the explain-config sub-command (CLI path). Loads the cascade
 * from `repoRoot`, resolves the key, and writes the report to stdout
 * (JSON when `useJson` is true; plain text lines otherwise). Returns the
 * report so callers can inspect it (tests + doctor spec).
 */
export const runExplainConfig = async (input: {
  repoRoot: string;
  key: string;
  useJson: boolean;
}): Promise<ExplainConfigReport> => {
  const cascade = await loadConfigCascade(input.repoRoot, {});
  const report = explainConfigKey(cascade.layers, input.key);
  if (input.useJson) {
    stdoutWrite(`${JSON.stringify(report)}\n`);
  } else {
    stdoutWrite(`${formatExplainConfigReport(report).join("\n")}\n`);
  }
  return report;
};

/**
 * Execute the explain-config sub-command for the `/doctor` slash path.
 * Identical lookup; pushes output lines into the transcript rather than
 * stdout so it reads as a normal command response.
 */
export const runExplainConfigForSlash = async (input: {
  args: string[];
  useJson: boolean;
  pushLine: (line: string) => void;
}): Promise<ExplainConfigReport | null> => {
  const key = parseExplainConfigFlag(input.args);
  if (key === null) return null;
  const cascade = await loadConfigCascade(repoRootFor(undefined), {});
  const report = explainConfigKey(cascade.layers, key);
  const payload = input.useJson ? [JSON.stringify(report)] : formatExplainConfigReport(report);
  for (const line of payload) input.pushLine(line);
  return report;
};

/**
 * Format the report as human-readable lines. One line per fact so the
 * output is easy to grep from an operator shell.
 */
export const formatExplainConfigReport = (report: ExplainConfigReport): string[] => {
  const lines: string[] = [];
  lines.push(`config key: ${report.key}`);
  if (report.layerSource === null) {
    lines.push("origin: (unset in every layer — no compiled default either)");
  } else {
    lines.push(`origin: ${report.layerSource}`);
  }
  lines.push(`effective value: ${JSON.stringify(report.effectiveValue) ?? "(undefined)"}`);
  lines.push(
    `checked layers (highest precedence first): ${report.checkedLayers.join(" → ") || "(none)"}`,
  );
  return lines;
};
