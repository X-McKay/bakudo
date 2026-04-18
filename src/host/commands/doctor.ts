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

import { BAKUDO_VERSION } from "../../version.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { loadConfigCascade } from "../config.js";
import { aboxProbeToChecks, probeAbox, type AboxProbe } from "../doctorAboxProbe.js";
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
  type DoctorStatus,
  type RendererBackendName,
  worstStatus,
} from "../doctorCheck.js";
import { stdoutWrite } from "../io.js";
import { xdgKeybindingsPath } from "../keybindings/userBindings.js";
import { validateBindings } from "../keybindings/validate.js";
import { repoRootFor, storageRootFor } from "../orchestration.js";
import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import { selectRendererBackend } from "../rendererBackend.js";
import { DEFAULT_RETENTION_POLICY } from "../retentionPolicy.js";
import { describeUiMode, getActiveUiMode, type UiMode } from "../uiMode.js";
import { computeStorageTotalBytes } from "./cleanup.js";

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
  telemetry: { enabled: false; note: string };
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
   */
  storage: {
    storageRoot: string;
    totalArtifactBytes: number;
    retentionPolicy: {
      intermediateMaxAgeMs: number;
      intermediateKinds: ReadonlyArray<string>;
      protectedKinds: ReadonlyArray<string>;
    };
  };
};

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

  // 2 + 3. abox availability + capabilities (via spawn probe).
  const aboxBin = ctx.aboxBin ?? "abox";
  const aboxProbe: AboxProbe = await probeAbox({ bin: aboxBin });
  const aboxChecks = aboxProbeToChecks(aboxProbe);

  // 4. Repo writeability.
  const repoCheck = await checkRepoWriteability(repoRoot);

  // 5. Terminal capability.
  const terminalCheck = checkTerminalCapability({ isTTY: stdout.isTTY === true, env });
  const terminalCap = describeTerminalCapability({ isTTY: stdout.isTTY === true, env });

  // 6. Active renderer backend (probe with a fake stdout structurally).
  const probeBackend: RendererBackend = selectRendererBackend({ stdout });
  const backendWithCtor = probeBackend as unknown as { constructor?: { name?: string } };
  const rendererCheck = checkRendererBackend(backendWithCtor);
  const rendererName = rendererBackendName(backendWithCtor);

  // 7 + 8. Config cascade + agent profile.
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

  // 9. Keybindings file path.
  const keybindingsPath = xdgKeybindingsPath();
  const keybindingsCheck = await checkKeybindingsPath(keybindingsPath);

  // 10. Reserved-shortcut conflicts (run validate against loaded user config if any).
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

  // 11. Telemetry (stubbed).
  const telemetryCheck = checkTelemetry();

  // 12. Storage footprint (Phase 6 W4). Best-effort: a missing storage root
  // (fresh repo) yields zero bytes rather than a check failure.
  const storageRoot = storageRootFor(repoRoot, undefined);
  let totalArtifactBytes = 0;
  try {
    totalArtifactBytes = await computeStorageTotalBytes(storageRoot);
  } catch {
    // Tolerate scan failures — `bakudo cleanup --dry-run` provides the
    // detailed surface; doctor must never `fail` on storage probing.
  }

  const checks: DoctorCheckResult[] = [
    nodeCheck,
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
      enabled: false,
      note: "real OTel wiring deferred to Phase 6 W7",
    },
    uiMode: {
      active: getActiveUiMode(),
      description: describeUiMode(getActiveUiMode()),
    },
    storage: {
      storageRoot,
      totalArtifactBytes,
      retentionPolicy: {
        intermediateMaxAgeMs: DEFAULT_RETENTION_POLICY.intermediateMaxAgeMs,
        intermediateKinds: DEFAULT_RETENTION_POLICY.intermediateKinds,
        protectedKinds: DEFAULT_RETENTION_POLICY.protectedKinds,
      },
    },
  };

  return envelope;
};

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
 * Human-readable renderer. Produces an array of lines so callers can
 * join with their own line-separator (CLI uses `\n`, slash-command
 * pushes each line as an `event` transcript item).
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
    `  storage: ${mb} MB at ${envelope.storage.storageRoot} (retention: intermediate >${days}d)`,
  );
  lines.push("");
  return lines;
};

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
