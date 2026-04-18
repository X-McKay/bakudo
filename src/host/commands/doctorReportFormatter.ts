/**
 * Human-readable renderer for the `bakudo doctor` envelope. Split out of
 * `doctor.ts` in Wave 6c PR7 so the primary command file stays under the
 * 400-LOC cap while the telemetry section grows the envelope.
 *
 * Kept pure — same input, same output. The command dispatcher joins with
 * `\n`; the slash-command dispatcher pushes each line as a transcript
 * `event` item (see `doctorCommandSpec`).
 */

import type { DoctorEnvelope } from "./doctor.js";
import type { DoctorStatus } from "../doctorCheck.js";

const statusBadge = (status: DoctorStatus): string => {
  switch (status) {
    case "pass":
      return "[OK]";
    case "warn":
      return "[WARN]";
    case "fail":
      return "[FAIL]";
  }
};

/**
 * Render the envelope as a sequence of printable lines (no line
 * terminators). See {@link DoctorEnvelope} for the input contract.
 */
export const formatDoctorReport = (envelope: DoctorEnvelope): string[] => {
  const lines: string[] = [];
  lines.push(`bakudo doctor — bakudo ${envelope.bakudoVersion}`);
  lines.push(`overall: ${statusBadge(envelope.status)}`);
  lines.push("");
  lines.push("Checks");
  for (const c of envelope.checks) {
    lines.push(`  ${statusBadge(c.status)} ${c.name}: ${c.summary}`);
    if (c.detail !== undefined && c.detail.length > 0) {
      lines.push(`      ${c.detail}`);
    }
    if (c.remediation !== undefined) {
      lines.push(`      → ${c.remediation}`);
    }
  }
  lines.push("");
  lines.push("Environment");
  lines.push(`  node runtime: ${envelope.node.runtime} (required >= ${envelope.node.required})`);
  lines.push(`  abox bin: ${envelope.abox.bin}`);
  if (envelope.abox.version !== undefined) {
    lines.push(`  abox version: ${envelope.abox.version}`);
  }
  lines.push(`  abox capabilities: ${envelope.abox.capabilities}`);
  lines.push(`  renderer backend: ${envelope.rendererBackend}`);
  lines.push(`  agent profile: ${envelope.agentProfile}`);
  lines.push(`  keybindings: ${envelope.keybindingsPath}`);
  lines.push(`  config layers: ${envelope.configCascadePaths.join(" | ")}`);
  // Phase 6 W1 — plan 06 hard rule 3: bug reports must record the UI mode.
  lines.push(`  ui mode: ${envelope.uiMode.active} (${envelope.uiMode.description})`);
  // Phase 6 W4 — storage footprint + active retention policy.
  const mb = (envelope.storage.totalArtifactBytes / (1024 * 1024)).toFixed(2);
  const days = Math.round(envelope.storage.retentionPolicy.intermediateMaxAgeMs / 86_400_000);
  lines.push(
    `  storage: ${mb} MB at ${envelope.storage.storageRoot}` +
      ` (layout: ${envelope.storage.layout}, retention: intermediate >${days}d)`,
  );
  // Phase 6 W5 hard rule 384 — redaction / env policy mode (effective
  // merged policy post Wave 6c PR7 — see resolveEffectiveRedactionPolicy).
  lines.push(
    `  redaction: ${envelope.redaction.active ? "active" : "inactive"}` +
      ` (env allowlist: ${envelope.redaction.envAllowlistCount},` +
      ` env deny patterns: ${envelope.redaction.envDenyPatternCount},` +
      ` text patterns: ${envelope.redaction.textPatternCount})`,
  );
  // Phase 6 Wave 6c PR7 (A6.1 plan line 870) — telemetry section.
  const otlpSuffix = envelope.telemetry.otlp.configured
    ? envelope.telemetry.otlp.host !== undefined
      ? `yes (host=${envelope.telemetry.otlp.host})`
      : "yes"
    : "no";
  lines.push(
    `  telemetry: ${envelope.telemetry.note}` +
      ` (spans on disk: ${envelope.telemetry.spansOnDisk},` +
      ` dropped batches: ${envelope.telemetry.droppedEventBatches},` +
      ` OTLP endpoint: ${otlpSuffix})`,
  );
  lines.push("");
  return lines;
};
