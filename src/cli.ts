#!/usr/bin/env node

import { ABoxAdapter } from "./aboxAdapter.js";
import { loadConfig, buildPolicyConfig, buildRuntimeConfig } from "./config.js";
import { runHostCli, shouldUseHostCli } from "./hostCli.js";
import { EXIT_CODES } from "./host/errors.js";
import { printVersion } from "./host/commands/version.js";
import { isMainModule } from "./mainModule.js";
import { AgentHarness, buildPolicy } from "./orchestrator.js";
import { ToolRuntime } from "./tools.js";

type CliArgs = {
  goal: string;
  config: string;
  streams: string[];
  aboxBin: string;
  repo?: string;
};

const LEGACY_TOP_LEVEL_FLAGS = new Set(["--goal", "--config", "--streams", "--abox-bin", "--repo"]);

const isVersionFlag = (arg: string | undefined): boolean => arg === "--version" || arg === "-V";

export const parseArgs = (argv: string[]): CliArgs => {
  const result: CliArgs = {
    goal: "",
    config: "config/default.json",
    streams: ["default"],
    aboxBin: "abox",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--goal") {
      result.goal = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--config") {
      result.config = argv[i + 1] ?? result.config;
      i += 1;
    } else if (arg === "--streams") {
      const next = argv[i + 1] ?? "";
      result.streams = next.split(",").filter(Boolean);
      i += 1;
    } else if (arg === "--abox-bin") {
      result.aboxBin = argv[i + 1] ?? result.aboxBin;
      i += 1;
    } else if (arg === "--repo") {
      const val = argv[i + 1];
      if (val !== undefined) result.repo = val;
      i += 1;
    }
  }

  if (!result.goal) {
    throw new Error("missing required argument --goal");
  }

  return result;
};

export const runCli = async (argv: string[]): Promise<number> => {
  if (shouldUseHostCli(argv)) {
    if (isVersionFlag(argv[0])) {
      const useJson = argv.includes("--output-format=json") || argv.includes("--json");
      printVersion({ useJson });
      return 0;
    }
    return runHostCli(argv);
  }

  const firstArg = argv[0];
  if (
    firstArg !== undefined &&
    firstArg.startsWith("--") &&
    !LEGACY_TOP_LEVEL_FLAGS.has(firstArg)
  ) {
    process.stderr.write(
      `harness_error: unrecognized top-level flag: ${firstArg} (run 'bakudo --help' for options)\n`,
    );
    return EXIT_CODES.FAILURE;
  }

  const args = parseArgs(argv);
  const fileConfig = await loadConfig(args.config);
  const runtimeConfig = buildRuntimeConfig(fileConfig);

  const runtime = new ToolRuntime(new ABoxAdapter(args.aboxBin, args.repo));
  const policy = buildPolicy(
    buildPolicyConfig(fileConfig, runtimeConfig.mode, runtimeConfig.assumeDangerousSkipPermissions),
  );
  const harness = new AgentHarness(runtime, policy, runtimeConfig);

  const memory = await harness.executeGoal(args.goal, args.streams);
  process.stdout.write(memory.summarize() + "\n");
  return 0;
};

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`harness_error: ${message}\n`);
      process.exitCode = 1;
    });
}
