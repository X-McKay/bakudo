import React from "react";
import { Box, Text } from "ink";
import { useAppState } from "./hooks/useAppState.js";

const hintsFor = (state: {
  screen: string;
  activeSessionId?: string;
  overlay?: { kind: string };
}): string[] => {
  if (state.screen === "inspect")
    return ["[Shift+Tab] tabs", "[↑/↓] scroll", "[?] help", "[Ctrl+C] exit"];
  if (state.activeSessionId) return ["[inspect]", "[inspect provenance]", "[new]", "[resume]"];
  return ["[new]", "[resume]", "[help]"];
};

export const Footer = () => {
  const screen = useAppState((s) => s.screen);
  const activeSessionId = useAppState((s) => s.activeSessionId);
  const hints = hintsFor({
    screen,
    ...(activeSessionId !== undefined ? { activeSessionId } : {}),
  });
  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(48)}</Text>
      <Text dimColor>{hints.join("  ")}</Text>
    </Box>
  );
};
