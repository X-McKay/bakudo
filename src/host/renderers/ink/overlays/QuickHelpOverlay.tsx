import React from "react";
import { Box, Text } from "ink";
import { getKeybindingsFor } from "../../../keybindings/hooks.js";
import { buildQuickHelpContents } from "../../../overlays/quickHelp.js";
import { DEFAULT_BINDINGS } from "../../../keybindings/defaults.js";
import type { QuickHelpContext } from "../../../appState.js";

export const QuickHelpOverlay = ({
  context,
  dialogKind,
}: {
  context: QuickHelpContext;
  dialogKind?: string;
}) => {
  const registered = getKeybindingsFor(
    context === "dialog"
      ? "Dialog"
      : context === "inspect"
        ? "Inspect"
        : context === "transcript"
          ? "Transcript"
          : "Composer",
  );
  const lines = buildQuickHelpContents(
    context,
    DEFAULT_BINDINGS,
    registered.size > 0 ? registered : undefined,
    dialogKind,
  );
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
};
