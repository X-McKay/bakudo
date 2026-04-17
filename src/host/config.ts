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
