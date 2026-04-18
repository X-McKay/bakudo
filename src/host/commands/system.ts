import type { HostCommandRegistry, HostCommandSpec } from "../commandRegistry.js";

/**
 * Build the system command specs. The `registry` parameter is injected at
 * construction time so that `/help` can enumerate commands dynamically without
 * creating a circular import between this module and `commandRegistryDefaults`.
 */
export const buildSystemCommands = (registry: HostCommandRegistry): readonly HostCommandSpec[] => [
  {
    name: "help",
    group: "system",
    description: "Show available commands.",
    handler: ({ deps }) => {
      // Dynamically generate the help list from the registry so it stays in
      // sync as commands are added, removed, or changed. Commands with
      // visible() predicates are filtered against the current app state so
      // only contextually relevant commands are shown. Hidden commands are
      // excluded. The prompt usage hint is prepended as a preamble.
      const visibleSpecs = registry.list(deps.appState).filter((spec) => spec.hidden !== true);
      deps.transcript.push({
        kind: "event",
        label: "help",
        detail: "Type a goal to dispatch a sandbox attempt in the current mode.",
      });
      for (const spec of visibleSpecs) {
        const aliases =
          spec.aliases && spec.aliases.length > 0 ? ` (/${spec.aliases.join(", /")})` : "";
        deps.transcript.push({
          kind: "event",
          label: "help",
          detail: `/${spec.name}${aliases} — ${spec.description}`,
        });
      }
    },
  },
  {
    name: "exit",
    aliases: ["quit"] as const,
    group: "system",
    description: "Exit the interactive shell.",
    handler: () => ({ kind: "exit" as const, code: 0 }),
  },
  {
    name: "init",
    group: "system",
    description: "Write a repo-local AGENTS.md template for bakudo.",
    handler: ({ deps }) => ({
      argv: ["init", ...(deps.appState.composer.autoApprove ? ["--yes"] : [])],
    }),
  },
];
