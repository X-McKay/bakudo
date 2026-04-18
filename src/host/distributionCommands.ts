/**
 * Dispatch helpers for the Phase 5 PR12 "distribution" commands
 * (`bakudo help <topic>`, `bakudo version`, `bakudo doctor`).
 *
 * Extracted from `src/host/interactive.ts` to keep that file under the
 * 400-line cap. Dynamic imports preserve the existing lazy-loading
 * behavior for these rarely-invoked commands.
 */

import { repoRootFor } from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";
import { printUsage } from "./usage.js";

export const dispatchHelpCommand = async (args: HostCliArgs): Promise<number> => {
  if (args.helpTopic !== undefined && args.helpTopic.length > 0) {
    const { runHelpCli } = await import("./commands/help.js");
    return runHelpCli({ topic: args.helpTopic });
  }
  printUsage();
  return 0;
};

export const dispatchVersionCommand = async (args: HostCliArgs): Promise<number> => {
  const { printVersion } = await import("./commands/version.js");
  const useJson = args.copilot.outputFormat === "json";
  printVersion({ useJson });
  return 0;
};

export const dispatchDoctorCommand = async (args: HostCliArgs): Promise<number> => {
  const { runDoctorCommand } = await import("./commands/doctor.js");
  const flags: string[] = [];
  if (args.copilot.outputFormat === "json") {
    flags.push("--output-format=json");
  }
  const result =
    args.aboxBin !== "abox"
      ? await runDoctorCommand({
          args: flags,
          repoRoot: repoRootFor(args.repo),
          aboxBin: args.aboxBin,
        })
      : await runDoctorCommand({
          args: flags,
          repoRoot: repoRootFor(args.repo),
        });
  return result.exitCode;
};

/**
 * Phase 6 W4 — dispatch path for `bakudo cleanup`. Forwards the raw
 * cleanup-flag tokens captured by `parseHostArgs` to the command's own
 * parser. Mirrors {@link dispatchDoctorCommand}'s lazy-import pattern.
 */
export const dispatchCleanupCommand = async (args: HostCliArgs): Promise<number> => {
  const { runCleanupCommand } = await import("./commands/cleanup.js");
  const result = await runCleanupCommand({
    args: args.cleanupArgs ?? [],
    repoRoot: repoRootFor(args.repo),
    ...(args.storageRoot !== undefined ? { storageRoot: args.storageRoot } : {}),
  });
  return result.exitCode;
};

/**
 * TTY probe: caller passes the isTty bit so the command can pick the
 * default `--format` (text for interactive stdout, json otherwise — plan
 * lock-in 12 is honoured because `--format json` never touches the
 * renderer registry).
 */
const probeStdoutIsTty = (): boolean => {
  const proc = (globalThis as unknown as { process?: { stdout?: { isTTY?: boolean } } }).process;
  return proc?.stdout?.isTTY === true;
};

/**
 * Phase 6 Wave 6c PR8 — dispatch path for `bakudo usage`. Mirrors
 * {@link dispatchCleanupCommand}: forward raw flag tokens to the command
 * module so the flag contract stays local.
 */
export const dispatchUsageCommand = async (args: HostCliArgs): Promise<number> => {
  const { runUsageCommand } = await import("./commands/usage.js");
  const result = await runUsageCommand({
    args: args.usageArgs ?? [],
    repoRoot: repoRootFor(args.repo),
    stdoutIsTty: probeStdoutIsTty(),
    ...(args.storageRoot !== undefined ? { storageRoot: args.storageRoot } : {}),
  });
  return result.exitCode;
};

/**
 * Phase 6 Wave 6c PR8 — dispatch path for `bakudo chronicle`. Same shape
 * as the `usage` dispatcher; the command module owns parse + filter.
 */
export const dispatchChronicleCommand = async (args: HostCliArgs): Promise<number> => {
  const { runChronicleCommand } = await import("./commands/chronicle.js");
  const result = await runChronicleCommand({
    args: args.chronicleArgs ?? [],
    repoRoot: repoRootFor(args.repo),
    stdoutIsTty: probeStdoutIsTty(),
    ...(args.storageRoot !== undefined ? { storageRoot: args.storageRoot } : {}),
  });
  return result.exitCode;
};

/**
 * Phase 6 Wave 6d PR11 — dispatch path for `bakudo metrics`. Prints the
 * in-memory {@link MetricsRecorder} snapshot. TTY-independent JSON via
 * `--format=json` / `--json` per lock-in 12.
 */
export const dispatchMetricsCommand = async (args: HostCliArgs): Promise<number> => {
  const { runMetricsCommand } = await import("./commands/metrics.js");
  const result = await runMetricsCommand({
    args: args.metricsArgs ?? [],
    stdoutIsTty: probeStdoutIsTty(),
  });
  return result.exitCode;
};
