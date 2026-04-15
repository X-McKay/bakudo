import type { HostCommandSpec } from "../commandRegistry.js";

export const systemCommands: readonly HostCommandSpec[] = [
  {
    name: "help",
    group: "system",
    description: "Show available commands.",
    handler: ({ deps }) => {
      const registryCommands = [
        "/new",
        "/resume",
        "/sessions",
        "/inspect [tab]",
        "/mode [standard|plan|autopilot]",
        "/autopilot",
        "/compact",
        "/clear",
        "/help",
        "/exit (/quit)",
        "/init",
        "/run /build /plan /status /tasks /review /sandbox /logs",
      ];
      for (const entry of registryCommands) {
        deps.transcript.push({ kind: "event", label: "help", detail: entry });
      }
    },
  },
  {
    name: "exit",
    aliases: ["quit"] as const,
    group: "system",
    description: "Exit the interactive shell.",
    // Actual exit is handled in runInteractiveShell; registry still returns
    // handled so the fallthrough path isn't consulted.
    handler: () => {},
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
