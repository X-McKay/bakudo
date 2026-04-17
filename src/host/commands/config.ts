import type { HostCommandSpec } from "../commandRegistry.js";
import type { BakudoConfig, ConfigLayer } from "../config.js";

/**
 * Format the merged config with source annotations for `/config show`.
 * Each key shows which layer it came from (the last layer to provide it wins).
 */
const formatConfigShow = (merged: BakudoConfig, layers: ConfigLayer[]): string[] => {
  const lines: string[] = ["Config (merged)"];
  const entries = Object.entries(merged) as [string, unknown][];

  for (const [key, value] of entries) {
    // Walk layers in reverse (highest priority first) to find the source.
    let source = "defaults";
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i]!;
      if ((layer.config as Record<string, unknown>)[key] !== undefined) {
        source = layer.source;
        break;
      }
    }
    const formatted = Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
    lines.push(`  ${key}: ${formatted}  (from ${source})`);
  }

  return lines;
};

export const buildConfigCommands = (
  getMergedConfig: () => { merged: BakudoConfig; layers: ConfigLayer[] },
): readonly HostCommandSpec[] => [
  {
    name: "config",
    group: "system",
    description: "Show the merged config cascade with source annotations.",
    handler: ({ args, deps }) => {
      const subcommand = args[0];
      if (subcommand !== undefined && subcommand !== "show") {
        deps.transcript.push({
          kind: "assistant",
          text: `Unknown config subcommand: ${subcommand}. Try /config show.`,
          tone: "warning",
        });
        return;
      }
      const { merged, layers } = getMergedConfig();
      const lines = formatConfigShow(merged, layers);
      for (const line of lines) {
        deps.transcript.push({ kind: "event", label: "config", detail: line });
      }
    },
  },
];
