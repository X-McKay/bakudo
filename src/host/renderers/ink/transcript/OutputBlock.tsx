import React from "react";
import { Box, Text } from "ink";

export const OutputBlock = ({ text }: { text: string }) => (
  <Box flexDirection="column">
    {text.split("\n").map((line, i) => (
      <Text key={i} dimColor>{`  ${line}`}</Text>
    ))}
  </Box>
);
