import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Mode, type AutonomyBudget } from "./models.js";
import { defaultHarnessConfig, type HarnessConfig } from "./orchestrator.js";
import type { PolicyConfig } from "./policy.js";

/**
 * Default config file name relative to either the caller cwd or the install root.
 * The string is exposed so CLI defaults can render it for `--help`.
 */
export const DEFAULT_CONFIG_FILE = "config/default.json";

const installRoot = (): string => {
  // src/config.ts -> dist/src/config.js at runtime; install root is two levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
};

/**
 * Resolve the bakudo default config to an absolute path.
 *
 * Resolution order:
 *  1. An explicit caller-supplied path is used verbatim. The caller is
 *     responsible for ensuring it exists; loadConfig will surface ENOENT.
 *  2. `<cwd>/config/default.json` — preserves the in-repo dev workflow.
 *  3. `<install-root>/config/default.json` — the published bundle ships the
 *     default config alongside `dist/`, so installed bakudo works regardless
 *     of caller cwd.
 *
 * Returns the first existing candidate, falling back to the install-root path
 * even when missing (so loadConfig produces a stable, actionable error
 * message rather than a cwd-dependent one).
 */
export const resolveDefaultConfigPath = (
  override?: string | undefined,
  cwd: string = process.cwd(),
): string => {
  if (override !== undefined && override.length > 0 && override !== DEFAULT_CONFIG_FILE) {
    return resolve(cwd, override);
  }
  const cwdCandidate = resolve(cwd, DEFAULT_CONFIG_FILE);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return resolve(installRoot(), DEFAULT_CONFIG_FILE);
};

export type RuntimeFileConfig = {
  runtime?: Partial<{
    mode: Mode;
    maxParallelStreams: number;
    autoEscalate: boolean;
    assumeDangerousSkipPermissions: boolean;
    checkpointEveryNSteps: number;
  }>;
  policy?: Partial<{
    allowedTools: string[];
    writeTools: string[];
    networkTools: string[];
    destructiveTools: string[];
    requireEscalationForWrite: boolean;
    requireEscalationForNetwork: boolean;
  }>;
  budget?: Partial<AutonomyBudget>;
};

export const loadConfig = async (path: string): Promise<RuntimeFileConfig> => {
  const resolved = resolveDefaultConfigPath(path);
  const raw = await readFile(resolved, "utf8");
  return JSON.parse(raw) as RuntimeFileConfig;
};

export const buildRuntimeConfig = (fileConfig: RuntimeFileConfig): HarnessConfig => {
  const defaults = defaultHarnessConfig();
  return {
    mode: fileConfig.runtime?.mode ?? defaults.mode,
    maxParallelStreams: fileConfig.runtime?.maxParallelStreams ?? defaults.maxParallelStreams,
    autoEscalate: fileConfig.runtime?.autoEscalate ?? defaults.autoEscalate,
    assumeDangerousSkipPermissions:
      fileConfig.runtime?.assumeDangerousSkipPermissions ?? defaults.assumeDangerousSkipPermissions,
    checkpointEveryNSteps:
      fileConfig.runtime?.checkpointEveryNSteps ?? defaults.checkpointEveryNSteps,
    budget: {
      maxTotalSteps: fileConfig.budget?.maxTotalSteps ?? defaults.budget.maxTotalSteps,
      maxWriteOps: fileConfig.budget?.maxWriteOps ?? defaults.budget.maxWriteOps,
      maxNetworkOps: fileConfig.budget?.maxNetworkOps ?? defaults.budget.maxNetworkOps,
      maxDestructiveOps: fileConfig.budget?.maxDestructiveOps ?? defaults.budget.maxDestructiveOps,
    },
  };
};

export const buildPolicyConfig = (
  fileConfig: RuntimeFileConfig,
  mode: Mode,
  assumeDangerous: boolean,
): PolicyConfig => ({
  mode,
  allowedTools: new Set(
    fileConfig.policy?.allowedTools ?? ["shell", "shell_write", "git_status", "fetch_url"],
  ),
  writeTools: new Set(fileConfig.policy?.writeTools ?? ["shell_write"]),
  networkTools: new Set(fileConfig.policy?.networkTools ?? ["fetch_url"]),
  destructiveTools: new Set(fileConfig.policy?.destructiveTools ?? []),
  requireEscalationForWrite: fileConfig.policy?.requireEscalationForWrite ?? false,
  requireEscalationForNetwork: fileConfig.policy?.requireEscalationForNetwork ?? false,
  assumeDangerousSkipPermissions: assumeDangerous,
});
