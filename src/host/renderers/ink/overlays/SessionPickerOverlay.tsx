import React from "react";
import { Box, Text } from "ink";
import { renderSessionPickerOverlayLines } from "../../plainRenderer.js";
import type { SessionPickerPayload } from "../../../appState.js";

export const SessionPickerOverlay = ({ request }: { request: SessionPickerPayload }) => {
  const lines = renderSessionPickerOverlayLines(request);
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
