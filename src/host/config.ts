import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { ComposerMode } from "./appState.js";
import { stderrWrite } from "./io.js";

/**
 * Zod schema for the bakudo config surface. Phase 2 — intentionally minimal.
 * Future phases grow `agents`, `hooks`, `permissions`, `keybindings`, `theme`.
 *
 * Unknown keys are silently stripped so a repo-local config from a newer bakudo
 * version does not crash an older one (tolerant-merge, OpenCode pattern).
 */
export const BakudoConfigSchema = z
  .object({
    mode: z.enum(["standard", "plan", "autopilot"]).optional(),
    autoApprove: z.boolean().optional(),
    logLevel: z.enum(["none", "error", "warning", "info", "debug", "all", "default"]).optional(),
    experimental: z.boolean().optional(),
    flushIntervalMs: z.number().optional(),
    flushSizeThreshold: z.number().optional(),
    retryDelays: z.array(z.number()).optional(),
  })
  .strip();

export type BakudoConfig = z.infer<typeof BakudoConfigSchema>;

export const BakudoConfigDefaults: Required<BakudoConfig> = {
  mode: "standard" as ComposerMode,
  autoApprove: false,
  logLevel: "default",
  experimental: false,
  flushIntervalMs: 100,
  flushSizeThreshold: 4096,
  retryDelays: [50, 100, 200, 400, 800],
};

/**
 * Validate a raw value as a config layer. Returns the parsed (stripped) config
 * on success; logs a one-line warning and returns `null` on failure.
 */
export const validateConfigLayer = (raw: unknown, source: string): BakudoConfig | null => {
  const result = BakudoConfigSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  stderrWrite(
    `[bakudo.config] skipping invalid config layer "${source}": ${result.error.message}\n`,
  );
  return null;
};

/**
 * Fields where array values replace (overwrite) rather than concatenate.
 * `retryDelays` is a scheduling tuple — concatenation would break timing.
 */
const REPLACE_ARRAY_FIELDS = new Set<string>(["retryDelays"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep-merge two config objects. Arrays concatenate by default (OpenCode
 * pattern) except fields in {@link REPLACE_ARRAY_FIELDS} which overwrite.
 * Primitives: last non-undefined wins.
 */
const mergeTwo = (base: BakudoConfig, layer: BakudoConfig): BakudoConfig => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, layerValue] of Object.entries(layer)) {
    if (layerValue === undefined) {
      continue;
    }
    const baseValue = (base as Record<string, unknown>)[key];
    if (Array.isArray(layerValue)) {
      if (REPLACE_ARRAY_FIELDS.has(key)) {
        out[key] = layerValue;
      } else if (Array.isArray(baseValue)) {
        out[key] = [...baseValue, ...layerValue];
      } else {
        out[key] = layerValue;
      }
    } else if (isPlainObject(layerValue) && isPlainObject(baseValue)) {
      out[key] = Object.assign({}, baseValue, layerValue);
    } else {
      out[key] = layerValue;
    }
  }
  return out as BakudoConfig;
};

/**
 * Deep-merge `base` with zero or more layers. Null layers are silently
 * skipped. Priority: rightmost non-undefined wins.
 */
export const deepMergeConfig = (
  base: BakudoConfig,
  ...layers: (BakudoConfig | null)[]
): BakudoConfig => {
  let merged = base;
  for (const layer of layers) {
    if (layer !== null) {
      merged = mergeTwo(merged, layer);
    }
  }
  return merged;
};

export type ConfigLayer = { source: string; config: BakudoConfig };

/**
 * Resolve the XDG config path for `<app>/<file>`. Respects `$XDG_CONFIG_HOME`;
 * falls back to `~/.config`.
 */
export const xdgConfigPath = (app: string, file: string): string => {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, app, file);
};

const readJsonFile = async (filePath: string): Promise<unknown | null> => {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
};

/**
 * Load the 5-source config cascade and deep-merge them.
 *
 * Priority (highest wins per key):
 *  1. CLI flags (`cliOverrides`)
 *  2. `$BAKUDO_CONFIG` (explicit override file)
 *  3. `./.bakudo/config.json` (repo-local)
 *  4. `~/.config/bakudo/config.json` (user, XDG)
 *  5. Compiled defaults
 */
export const loadConfigCascade = async (
  repoRoot: string,
  cliOverrides: Partial<BakudoConfig>,
): Promise<{ merged: BakudoConfig; layers: ConfigLayer[] }> => {
  const layers: ConfigLayer[] = [];

  // Layer 5: compiled defaults (always present).
  layers.push({ source: "defaults", config: { ...BakudoConfigDefaults } });

  // Layer 4: user config.
  const userPath = xdgConfigPath("bakudo", "config.json");
  const userRaw = await readJsonFile(userPath);
  const userConfig = userRaw !== null ? validateConfigLayer(userRaw, `user (${userPath})`) : null;
  if (userConfig !== null) {
    layers.push({ source: `user (${userPath})`, config: userConfig });
  }

  // Layer 3: repo-local config.
  const repoConfigPath = join(repoRoot, ".bakudo", "config.json");
  const repoRaw = await readJsonFile(repoConfigPath);
  const repoConfig =
    repoRaw !== null ? validateConfigLayer(repoRaw, `repo (${repoConfigPath})`) : null;
  if (repoConfig !== null) {
    layers.push({ source: `repo (${repoConfigPath})`, config: repoConfig });
  }

  // Layer 2: $BAKUDO_CONFIG override.
  const overridePath = process.env.BAKUDO_CONFIG;
  if (overridePath !== undefined && overridePath.length > 0) {
    const overrideRaw = await readJsonFile(overridePath);
    const overrideConfig =
      overrideRaw !== null
        ? validateConfigLayer(overrideRaw, `$BAKUDO_CONFIG (${overridePath})`)
        : null;
    if (overrideConfig !== null) {
      layers.push({ source: `$BAKUDO_CONFIG (${overridePath})`, config: overrideConfig });
    }
  }

  // Layer 1: CLI flags.
  const cliConfig = validateConfigLayer(cliOverrides, "cli");
  if (cliConfig !== null && Object.keys(cliConfig).length > 0) {
    layers.push({ source: "cli", config: cliConfig });
  }

  // Merge all layers in priority order (layers array is low→high).
  const merged = deepMergeConfig({}, ...layers.map((l) => l.config));

  // Final defensive validation — should be impossible given per-layer stripping.
  const finalResult = BakudoConfigSchema.safeParse(merged);
  if (!finalResult.success) {
    stderrWrite(
      `[bakudo.config] merged config failed validation, falling back to defaults: ${finalResult.error.message}\n`,
    );
    return { merged: { ...BakudoConfigDefaults }, layers };
  }

  return { merged: finalResult.data, layers };
};
