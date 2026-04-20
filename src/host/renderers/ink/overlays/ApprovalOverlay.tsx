import React from "react";
import { Box, Text } from "ink";

export const ApprovalOverlay = ({ message }: { message: string }) => (
  <Box borderStyle="round" flexDirection="column" paddingX={1}>
    <Text>{message}</Text>
    <Text dimColor>[y/N]</Text>
  </Box>
);
