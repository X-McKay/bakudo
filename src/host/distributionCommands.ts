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
