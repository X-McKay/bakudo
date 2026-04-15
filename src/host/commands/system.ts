import type { HostCommandSpec } from "../commandRegistry.js";

export const systemCommands: readonly HostCommandSpec[] = [
  {
    name: "help",
    group: "system",
    description: "Show available commands.",
    handler: ({ deps }) => {
      // Help ordering mirrors phase doc lines 788–797: prompt usage first,
      // then session controls, inspect, composer/mode, autopilot, legacy
      // compat aliases, finally /exit.
      const registryCommands = [
        "Type a goal to dispatch a sandbox attempt in the current mode.",
        "/new",
        "/resume [session]",
        "/sessions",
        "/inspect [summary|review|artifacts|sandbox|logs]",
        "/mode [standard|plan|autopilot]",
        "/autopilot",
        "/compact",
        "/clear",
        "/init",
        "/run /build /plan /status /tasks /review /sandbox /logs",
        "/help",
        "/exit (/quit)",
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
