import type { ComposerMode } from "../appState.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { reduceHost } from "../reducer.js";

const KNOWN_MODES: readonly ComposerMode[] = ["standard", "plan", "autopilot"];

const isComposerMode = (value: string): value is ComposerMode =>
  (KNOWN_MODES as readonly string[]).includes(value);

export const composerCommands: readonly HostCommandSpec[] = [
  {
    name: "mode",
    group: "composer",
    description: "Set composer mode (standard|plan|autopilot) or cycle if no argument.",
    handler: ({ args, deps }) => {
      const requested = args[0];
      if (requested === undefined) {
        deps.appState = reduceHost(deps.appState, { type: "cycle_mode" });
        deps.shellState.currentMode = deps.appState.composer.mode === "plan" ? "plan" : "build";
        deps.shellState.autoApprove = deps.appState.composer.autoApprove;
        deps.transcript.push({
          kind: "event",
          label: "mode",
          detail: deps.appState.composer.mode,
        });
        return;
      }
      // Accept legacy "build" as an alias for "standard".
      const normalized: string = requested === "build" ? "standard" : requested;
      if (!isComposerMode(normalized)) {
        deps.transcript.push({
          kind: "assistant",
          text: `mode must be one of ${KNOWN_MODES.join("|")}`,
          tone: "error",
        });
        return;
      }
      deps.appState = reduceHost(deps.appState, { type: "set_mode", mode: normalized });
      deps.shellState.currentMode = normalized === "plan" ? "plan" : "build";
      deps.shellState.autoApprove = deps.appState.composer.autoApprove;
      deps.transcript.push({ kind: "event", label: "mode", detail: normalized });
    },
  },
  {
    name: "autopilot",
    aliases: ["approve"] as const,
    group: "composer",
    description: "Shortcut for /mode autopilot.",
    handler: ({ deps }) => {
      deps.appState = reduceHost(deps.appState, { type: "set_mode", mode: "autopilot" });
      deps.shellState.currentMode = "build";
      deps.shellState.autoApprove = true;
      deps.transcript.push({ kind: "event", label: "mode", detail: "autopilot" });
    },
  },
  {
    name: "compact",
    group: "composer",
    description: "Compact the session transcript (Phase 2 — not yet available).",
    handler: ({ deps }) => {
      deps.transcript.push({
        kind: "event",
        label: "compact",
        detail: "not yet available (Phase 2)",
      });
    },
  },
  {
    name: "clear",
    group: "composer",
    description: "Clear the transcript and redraw the shell.",
    handler: ({ deps }) => {
      deps.transcript.length = 0;
    },
  },
];
