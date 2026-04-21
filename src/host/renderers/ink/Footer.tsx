import React from "react";
import { Box, Text } from "ink";
import { useAppState } from "./hooks/useAppState.js";

const hintsFor = (state: {
  screen: string;
  overlayKind: string | undefined;
  inFlight: boolean;
}): string[] => {
  if (state.overlayKind === "approval_prompt")
    return ["[1/2/3/4] choose", "[Shift+Tab] cycle", "[?] help", "[Ctrl+C] exit"];
  if (state.overlayKind === "recovery_dialog")
    return ["[r] retry", "[h] halt", "[e] edit", "[?] help", "[Ctrl+C] exit"];
  if (state.overlayKind === "command_palette" || state.overlayKind === "session_picker")
    return ["[↑/↓] move", "[Enter] select", "[?] help", "[Ctrl+C] exit"];
  if (state.overlayKind === "quick_help") return ["[?] close", "[Ctrl+C] exit"];
  if (state.screen === "inspect")
    return ["[Shift+Tab] tabs", "[↑/↓] scroll", "[?] help", "[Ctrl+C] exit"];
  if (state.inFlight) return ["[Esc] cancel", "[Ctrl+C] quit"];
  return ["[/] commands", "[Tab] sidebar", "[?] help", "[Ctrl+C] exit"];
};

export const Footer = () => {
  const screen = useAppState((s) => s.screen);
  const overlayKind = useAppState((s) => s.promptQueue[0]?.kind ?? s.quickHelp?.context);
  const inFlight = useAppState((s) => s.dispatch.inFlight);
  // Show the active provider ID in the bottom-right corner.
  // Falls back to an em-dash while the first planning pass is in progress.
  const provider = useAppState((s) => s.composer.provider);
  const providerLabel = provider.length > 0 ? provider : "\u2014";
  const hints = hintsFor({ screen, overlayKind, inFlight });
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor>{hints.join("  ")}</Text>
      <Text dimColor>{providerLabel}</Text>
    </Box>
  );
};
