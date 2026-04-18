/**
 * Phase 6 Wave 6d PR11 review N3 — extracted from `doctor.ts` to keep that
 * file under the 400-LOC cap after telemetry/metrics wiring work. The
 * envelope shape is a stable automation contract; every field's comment is
 * preserved verbatim from the original definition.
 */

import type { DoctorCheckResult, DoctorStatus, RendererBackendName } from "../doctorCheck.js";
import type { DoctorMetricsSection } from "../metrics/doctorMetricsSection.js";
import type { RedactionPolicySummary } from "../redaction.js";
import type { UiMode } from "../uiMode.js";

/**
 * Envelope produced by `bakudo doctor --output-format=json`. Key names
 * are load-bearing for automation — treat as a stable contract.
 */
export type DoctorEnvelope = {
  name: "bakudo-doctor";
  bakudoVersion: string;
  status: DoctorStatus;
  checks: DoctorCheckResult[];
  node: { runtime: string; required: number };
  abox: { available: boolean; version?: string; capabilities: string; bin: string };
  rendererBackend: RendererBackendName;
  agentProfile: string;
  configCascadePaths: string[];
  keybindingsPath: string;
  keybindingsConflicts: string[];
  terminal: {
    isTty: boolean;
    supportsAnsi: boolean;
    noColor: boolean;
    term?: string;
    colorfgbg?: string;
  };
  /**
   * Phase 6 Wave 6c PR7 — local-only OTel telemetry status (plan line 870).
   * `spansOnDisk` counts `spans-*.json` files in the bakudo log dir;
   * `droppedEventBatches` echoes the classic durability counter; `otlp`
   * describes the export endpoint (yes/no + host, NEVER bearer token).
   */
  telemetry: {
    enabled: boolean;
    note: string;
    logDir: string;
    spansOnDisk: number;
    droppedEventBatches: number;
    otlp: { configured: boolean; host?: string };
  };
  /**
   * Active UI rollout mode for the invocation (Phase 6 W1). Copy this into
   * bug reports along with `bakudoVersion` — plan 06 hard rule 3 requires
   * the mode be recorded so a report specifies which surface the user hit.
   */
  uiMode: { active: UiMode; description: string };
  /**
   * Phase 6 W4 — storage footprint + active retention policy snapshot.
   * Surfaced in `bakudo doctor` so operators can spot growth without
   * running a full `bakudo cleanup --dry-run`. Additive — older automation
   * that does not know about this field continues to parse cleanly.
   *
   * Phase 6 Wave 6e PR16: `layout` reports the on-disk layout generation
   * (`"legacy"` = pre-XDG `.bakudo/`; `"xdg"` = post-migration). Additive.
   */
  storage: {
    storageRoot: string;
    totalArtifactBytes: number;
    layout: "legacy" | "xdg";
    retentionPolicy: {
      intermediateMaxAgeMs: number;
      intermediateKinds: ReadonlyArray<string>;
      protectedKinds: ReadonlyArray<string>;
    };
  };
  /**
   * Phase 6 W5 hard rule 384 — the active redaction / env-allowlist policy
   * summary so operators can tell at a glance whether secret scrubbing is
   * enabled. Counts only; pattern bodies are not surfaced (the patterns
   * themselves are not secret but users don't benefit from seeing them).
   */
  redaction: RedactionPolicySummary;
  /** Phase 6 Wave 6d PR11 — W7 metrics snapshot (plan lines 430-440). */
  metrics: DoctorMetricsSection;
};
