import React from "react";
import { Box, Text } from "ink";
import { renderApprovalPromptLines } from "../../plainRenderer.js";
import type { ApprovalPromptRequest } from "../../../appState.js";

export const ApprovalPromptOverlay = ({
  request,
  cursorIndex,
}: {
  request: ApprovalPromptRequest;
  cursorIndex: number;
}) => {
  const lines = renderApprovalPromptLines(request, cursorIndex);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
};
