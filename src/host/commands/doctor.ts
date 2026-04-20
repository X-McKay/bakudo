/**
 * `bakudo doctor` — environment-diagnostic command. Emits either a
 * human-readable, headed report or a single JSON envelope suitable for
 * automation when `--output-format=json` is passed.
 *
 * Per the Phase 5 W5 design note at
 * `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md:461-464`, the
 * envelope includes: node version, abox path + capabilities, renderer
 * backend, active agent profile, config cascade paths read, keybindings
 * file path, and the reserved-shortcut conflict report.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { BAKUDO_VERSION } from "../../version.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { loadConfigCascade } from "../config.js";
import {
  parseExplainConfigFlag,
  runExplainConfig,
  runExplainConfigForSlash,
} from "../explainConfig.js";
import { aboxProbeToChecks, probeAbox, type AboxProbe } from "../doctorAboxProbe.js";
import { checkKvmAccess, checkVirtiofsdCaps, preflightToDoctorCheck } from "../hostPreflight.js";
import {
  checkAgentProfile,
  checkConfigCascade,
  checkKeybindingsPath,
  checkNodeVersion,
  checkRepoWriteability,
  checkRendererBackend,
  checkTelemetry,
  checkTerminalCapability,
  describeTerminalCapability,
  rendererBackendName,
  type DoctorCheckResult,
  worstStatus,
} from "../doctorCheck.js";
import { stdoutWrite } from "../io.js";
import { xdgKeybindingsPath } from "../keybindings/userBindings.js";
import { validateBindings } from "../keybindings/validate.js";
import { repoRootFor, storageRootFor } from "../sessionRunSupport.js";
import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import { selectRendererBackend } from "../rendererBackend.js";
import { initialHostAppState } from "../appState.js";
import { reduceHost } from "../reducer.js";
import { createHostStore } from "../store/index.js";
import { resolveEffectiveRedactionPolicy, summarizeRedactionPolicy } from "../redaction.js";
import { countSpanFilesOnDisk, describeOtlpEndpoint } from "../telemetry/otelSpans.js";
import { bakudoLogDir } from "../telemetry/xdgPaths.js";
import { buildMetricsSection, type DoctorMetricsSection } from "../metrics/doctorMetricsSection.js";
import { DEFAULT_RETENTION_POLICY } from "../retentionPolicy.js";
import { describeUiMode, getActiveUiMode } from "../uiMode.js";
import { resolveDoctorVirtiofsdPath } from "../virtiofsdPath.js";
import { detectLegacyLayout, realMigrationFs, type MigrationPaths } from "../xdgMigration.js";
import { computeStorageTotalBytes } from "./cleanup.js";

// PR11 review N3 — the `DoctorEnvelope` type moved to `doctorEnvelopeTypes.ts`
// so this file stays under the 400-LOC cap. Re-export keeps the existing
// import path (`./commands/doctor.js`) stable for callers and tests.
export type { DoctorEnvelope } from "./doctorEnvelopeTypes.js";
import type { DoctorEnvelope } from "./doctorEnvelopeTypes.js";
export type { DoctorMetricsSection };

export type DoctorContext = {
  repoRoot: string;
  aboxBin?: string;
  stdout?: RendererStdout;
  env: Record<string, string | undefined>;
  nodeRuntime: string;
};

type RawKeybindings = {
  path: string;
  conflicts: string[];
};

const NODE_REQUIRED_MAJOR = 22;

const fakeStdoutForBackendProbe = (isTTY: boolean): RendererStdout => ({
  isTTY,
  write: () => true,
});

/**
 * Read the user keybindings file (if any) and run it through the
 * validator so we can surface conflicts by message. Missing file ⇒ no
 * conflicts. Unparseable JSON ⇒ reported as a single conflict message.
 */
const probeKeybindingConflicts = async (path: string): Promise<RawKeybindings> => {
  try {
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      return { path, conflicts: [`<root>: invalid JSON — ${msg}`] };
    }
    const validation = validateBindings(parsed);
    return {
      path,
      conflicts: validation.ok ? [] : validation.errors,
    };
  } catch {
    // File doesn't exist — no conflicts.
    return { path, conflicts: [] };
  }
};

/**
 * Run every configured check and return the full envelope. Pure wrt
 * the filesystem except for the `abox` spawn + repo-writeability probe +
 * config-cascade reads.
 */
export const runDoctorChecks = async (ctx: DoctorContext): Promise<DoctorEnvelope> => {
  const { repoRoot, env, nodeRuntime } = ctx;
  const stdout = ctx.stdout ?? fakeStdoutForBackendProbe(false);

  // 1. Node version.
  const nodeCheck = checkNodeVersion({ runtime: nodeRuntime, required: NODE_REQUIRED_MAJOR });

  // 2 + 3. Minimal host preflight (Phase 0 F-P).
  const virtiofsdPath = await resolveDoctorVirtiofsdPath({ env });
  const virtiofsdCheck = preflightToDoctorCheck(await checkVirtiofsdCaps({ virtiofsdPath }));
  const kvmCheck = preflightToDoctorCheck(await checkKvmAccess());

  // 4 + 5. abox availability + capabilities (via spawn probe).
  const aboxBin = ctx.aboxBin ?? "abox";
  const aboxProbe: AboxProbe = await probeAbox({ bin: aboxBin });
  const aboxChecks = aboxProbeToChecks(aboxProbe);

  // 6. Repo writeability.
  const repoCheck = await checkRepoWriteability(repoRoot);

  // 7. Terminal capability.
  const terminalCheck = checkTerminalCapability({ isTTY: stdout.isTTY === true, env });
  const terminalCap = describeTerminalCapability({ isTTY: stdout.isTTY === true, env });

  // 8. Active renderer backend (probe with a fake stdout structurally).
  // The InkBackend constructor captures its `store` for later mount; we pass
  // a throwaway store here because `doctor` never mounts the backend — it
  // only reads `constructor.name` via `rendererBackendName`.
  const probeStore = createHostStore(reduceHost, initialHostAppState());
  const probeBackend: RendererBackend = selectRendererBackend({ stdout, store: probeStore });
  const backendWithCtor = probeBackend as unknown as { constructor?: { name?: string } };
  const rendererCheck = checkRendererBackend(backendWithCtor);
  const rendererName = rendererBackendName(backendWithCtor);

  // 9 + 10. Config cascade + agent profile.
  const cascade = await loadConfigCascade(repoRoot, {});
  const configCheck = checkConfigCascade(cascade.layers);
  const agentProfileName = (() => {
    const agents = cascade.merged.agents;
    if (agents === undefined) {
      return "default";
    }
    const names = Object.keys(agents);
    return names[0] ?? "default";
  })();
  const agentCheck = checkAgentProfile(agentProfileName);

  // 11. Keybindings file path.
  const keybindingsPath = xdgKeybindingsPath();
  const keybindingsCheck = await checkKeybindingsPath(keybindingsPath);

  // 12. Reserved-shortcut conflicts (run validate against loaded user config if any).
  const keybindingProbe = await probeKeybindingConflicts(keybindingsPath);
  const conflictCheck: DoctorCheckResult =
    keybindingProbe.conflicts.length === 0
      ? {
          name: "keybindings-conflicts",
          status: "pass",
          summary: "no reserved-shortcut conflicts",
        }
      : {
          name: "keybindings-conflicts",
          status: "warn",
          summary: `${keybindingProbe.conflicts.length} conflict(s) in keybindings.json`,
          detail: keybindingProbe.conflicts.join("; "),
          remediation: "Edit ~/.config/bakudo/keybindings.json to remove reserved-key overrides.",
        };

  // 13. Telemetry (Wave 6c PR7 — local-only OTel + time-delta log stack).
  const telemetryCheck = checkTelemetry();
  const logDir = bakudoLogDir();
  const spansOnDisk = await countSpanFilesOnDisk(logDir);
  const otlp = describeOtlpEndpoint(env);

  // 14. Storage footprint (Phase 6 W4). Best-effort: a missing storage root
  // (fresh repo) yields zero bytes rather than a check failure.
  const storageRoot = storageRootFor(repoRoot, undefined);
  let totalArtifactBytes = 0;
  try {
    totalArtifactBytes = await computeStorageTotalBytes(storageRoot);
  } catch {
    // Tolerate scan failures — `bakudo cleanup --dry-run` provides the
    // detailed surface; doctor must never `fail` on storage probing.
  }

  // Phase 6 Wave 6e PR16 — detect the current on-disk layout generation.
  const migrationPaths: MigrationPaths = {
    repoRoot,
    home: homedir(),
    xdgLogDir: logDir,
  };
  const layoutDetection = await detectLegacyLayout(
    realMigrationFs({ mutate: false }),
    migrationPaths,
  );

  const checks: DoctorCheckResult[] = [
    nodeCheck,
    virtiofsdCheck,
    kvmCheck,
    ...aboxChecks,
    repoCheck,
    terminalCheck,
    rendererCheck,
    configCheck,
    agentCheck,
    keybindingsCheck,
    conflictCheck,
    telemetryCheck,
  ];
  // PR11 review N3 — share the singleton `droppedEventBatches` across the
  // `telemetry` and `metrics` fields instead of hard-coding zero.
  const metricsSection = buildMetricsSection();
  const envelope: DoctorEnvelope = {
    name: "bakudo-doctor",
    bakudoVersion: BAKUDO_VERSION,
    status: worstStatus(checks),
    checks,
    node: { runtime: nodeRuntime, required: NODE_REQUIRED_MAJOR },
    abox: {
      available: aboxProbe.available,
      ...(aboxProbe.version !== undefined ? { version: aboxProbe.version } : {}),
      capabilities: aboxProbe.capabilities,
      bin: aboxProbe.bin,
    },
    rendererBackend: rendererName,
    agentProfile: agentProfileName,
    configCascadePaths: cascade.layers.map((l) => l.source),
    keybindingsPath,
    keybindingsConflicts: keybindingProbe.conflicts,
    terminal: {
      isTty: terminalCap.isTty,
      supportsAnsi: terminalCap.supportsAnsi,
      noColor: terminalCap.noColor,
      ...(terminalCap.term !== undefined ? { term: terminalCap.term } : {}),
      ...(terminalCap.colorfgbg !== undefined ? { colorfgbg: terminalCap.colorfgbg } : {}),
    },
    telemetry: {
      // Wave 6c PR7 review-fix N6: the telemetry primitives
      // (`TimeDeltaLogger`, `SpanRecorder`) exist but are NOT yet wired into
      // production call-sites (`executeAttempt`, `writeSessionArtifact`,
      // etc.). Reporting `enabled: true` would be a literal lie — operators
      // reading `doctor` would misread it as confirming a live feature.
      // Flip back to `true` in the follow-up PR that wires the recorders
      // into the production hot path.
      enabled: false,
      note:
        otlp.configured === true
          ? "local spans + OTLP export active"
          : "local-only (spans recorded on disk; no OTLP export)",
      logDir,
      spansOnDisk,
      droppedEventBatches: metricsSection.droppedEventBatches,
      otlp:
        otlp.host === undefined
          ? { configured: otlp.configured }
          : { configured: otlp.configured, host: otlp.host },
    },
    uiMode: {
      active: getActiveUiMode(),
      description: describeUiMode(getActiveUiMode()),
    },
    storage: {
      storageRoot,
      totalArtifactBytes,
      layout: layoutDetection.layout,
      retentionPolicy: {
        intermediateMaxAgeMs: DEFAULT_RETENTION_POLICY.intermediateMaxAgeMs,
        intermediateKinds: DEFAULT_RETENTION_POLICY.intermediateKinds,
        protectedKinds: DEFAULT_RETENTION_POLICY.protectedKinds,
      },
    },
    redaction: summarizeRedactionPolicy(
      resolveEffectiveRedactionPolicy(cascade.merged.redaction ?? undefined),
    ),
    metrics: metricsSection,
  };

  return envelope;
};

export { formatDoctorReport } from "./doctorReportFormatter.js";
import { formatDoctorReport } from "./doctorReportFormatter.js";

/**
 * Run the doctor and emit output. Returns an exit code: 0 for pass/warn,
 * 1 for fail. `--output-format=json` is detected via the flag array so
 * both CLI and slash invocations share a single entrypoint.
 */
export const runDoctorCommand = async (input: {
  args: string[];
  repoRoot?: string;
  aboxBin?: string;
  stdout?: RendererStdout;
  env?: Record<string, string | undefined>;
  nodeRuntime?: string;
}): Promise<{ envelope: DoctorEnvelope; exitCode: number }> => {
  const useJson = input.args.includes("--output-format=json") || input.args.includes("--json");
  const repoRoot = input.repoRoot ?? repoRootFor(undefined);
  const nodeRuntime =
    input.nodeRuntime ??
    (globalThis as unknown as { process?: { version?: string } }).process?.version ??
    "unknown";
  const env =
    input.env ??
    (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env ??
    {};
  // Wave 6d A6.10 edge #4 — `--explain-config <key>` short-circuits the full
  // doctor run (it is a focused query, not a health check). Exit 0 for a
  // well-formed lookup; a missing key is a no-op here.
  const explainKey = parseExplainConfigFlag(input.args);
  if (explainKey !== null) {
    await runExplainConfig({ repoRoot, key: explainKey, useJson });
    const synth = { name: "bakudo-doctor", status: "pass" } as unknown as DoctorEnvelope;
    return { envelope: synth, exitCode: 0 };
  }
  const envelope = await runDoctorChecks({
    repoRoot,
    ...(input.aboxBin !== undefined ? { aboxBin: input.aboxBin } : {}),
    ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
    env,
    nodeRuntime,
  });
  if (useJson) {
    stdoutWrite(`${JSON.stringify(envelope)}\n`);
  } else {
    stdoutWrite(`${formatDoctorReport(envelope).join("\n")}\n`);
  }
  return { envelope, exitCode: envelope.status === "fail" ? 1 : 0 };
};

export const doctorCommandSpec: HostCommandSpec = {
  name: "doctor",
  group: "system",
  description: "Diagnose the bakudo environment (node, abox, renderer, config, keybindings).",
  handler: async ({ args, deps }) => {
    const useJson = args.includes("--output-format=json") || args.includes("--json");
    // Wave 6d A6.10 #4 — `/doctor --explain-config <key>` slash variant.
    const handled = await runExplainConfigForSlash({
      args,
      useJson,
      pushLine: (line) => deps.transcript.push({ kind: "event", label: "doctor", detail: line }),
    });
    if (handled !== null) return;
    const envelope = await runDoctorChecks({
      repoRoot: repoRootFor(undefined),
      env:
        (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
          .process?.env ?? {},
      nodeRuntime:
        (globalThis as unknown as { process?: { version?: string } }).process?.version ?? "unknown",
    });
    if (useJson) {
      deps.transcript.push({
        kind: "event",
        label: "doctor",
        detail: JSON.stringify(envelope),
      });
      return;
    }
    for (const line of formatDoctorReport(envelope)) {
      deps.transcript.push({ kind: "event", label: "doctor", detail: line });
    }
  },
};
