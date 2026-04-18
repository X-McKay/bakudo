import { createCommandRegistry, type HostCommandRegistry } from "./commandRegistry.js";
import { composerCommands } from "./commands/composer.js";
import { inspectCommands } from "./commands/inspect.js";
import { legacyCommands } from "./commands/legacy.js";
import { sessionCommands } from "./commands/session.js";
import { buildSystemCommands } from "./commands/system.js";

export const buildDefaultCommandRegistry = (): HostCommandRegistry => {
  const registry = createCommandRegistry();
  for (const spec of [
    ...sessionCommands,
    ...inspectCommands,
    ...composerCommands,
    // System commands receive the registry so /help can enumerate commands
    // dynamically without a circular import.
    ...buildSystemCommands(registry),
    ...legacyCommands,
  ]) {
    registry.register(spec);
  }
  return registry;
};
