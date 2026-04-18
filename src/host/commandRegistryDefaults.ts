import { createCommandRegistry, type HostCommandRegistry } from "./commandRegistry.js";
import { composerCommands } from "./commands/composer.js";
import { buildConfigCommands } from "./commands/config.js";
import { doctorCommandSpec } from "./commands/doctor.js";
import { helpTopicCommandSpec } from "./commands/help.js";
import { inspectCommands } from "./commands/inspect.js";
import { legacyCommands } from "./commands/legacy.js";
import { runCommandSpec } from "./commands/runCommand.js";
import { sessionCommands } from "./commands/session.js";
import { buildSystemCommands } from "./commands/system.js";
import { timelineCommandSpec } from "./commands/timeline.js";
import { versionCommandSpec } from "./commands/version.js";
import type { BakudoConfig, ConfigLayer } from "./config.js";

export type CommandRegistryOptions = {
  getConfig?: () => { merged: BakudoConfig; layers: ConfigLayer[] };
};

export const buildDefaultCommandRegistry = (
  options: CommandRegistryOptions = {},
): HostCommandRegistry => {
  const registry = createCommandRegistry();
  const configCommands =
    options.getConfig !== undefined ? buildConfigCommands(options.getConfig) : [];
  for (const spec of [
    ...sessionCommands,
    timelineCommandSpec,
    ...inspectCommands,
    ...composerCommands,
    ...configCommands,
    versionCommandSpec,
    doctorCommandSpec,
    helpTopicCommandSpec,
    // System commands receive the registry so /help can enumerate commands
    // dynamically without a circular import.
    ...buildSystemCommands(registry),
    ...legacyCommands,
    runCommandSpec,
  ]) {
    registry.register(spec);
  }
  return registry;
};
