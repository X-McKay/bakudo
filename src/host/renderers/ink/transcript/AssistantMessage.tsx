import React from "react";
import { Box, Text } from "ink";

type Tone = "info" | "success" | "warning" | "error" | undefined;

const toneColor = (tone: Tone): string | undefined => {
  if (tone === "success") return "green";
  if (tone === "warning") return "yellow";
  if (tone === "error") return "red";
  if (tone === "info") return "cyan";
  return undefined;
};

export const AssistantMessage = ({ text, tone }: { text: string; tone?: Tone }) => {
  const color = toneColor(tone);
  return (
    <Box flexDirection="row">
      <Text dimColor>• </Text>
      {color !== undefined ? <Text color={color}>{text}</Text> : <Text>{text}</Text>}
    </Box>
  );
};
