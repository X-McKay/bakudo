import React from "react";
import { Box, Text } from "ink";

export const UserMessage = ({ text }: { text: string }) => (
  <Box flexDirection="row">
    <Text dimColor>› </Text>
    <Text>{text}</Text>
  </Box>
);
