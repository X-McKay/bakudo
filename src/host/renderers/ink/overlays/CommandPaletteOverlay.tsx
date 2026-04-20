import React from "react";
import { Box, Text } from "ink";
import { renderCommandPaletteOverlayLines } from "../../commandPaletteOverlay.js";
import type { CommandPaletteRequest } from "../../../appState.js";

export const CommandPaletteOverlay = ({ request }: { request: CommandPaletteRequest }) => {
  const lines = renderCommandPaletteOverlayLines(request);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Text key={i} color="cyan">
          {line}
        </Text>
      ))}
    </Box>
  );
};
