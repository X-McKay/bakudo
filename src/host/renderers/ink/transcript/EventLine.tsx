import React from "react";
import { Box, Text } from "ink";

const iconForLabel = (label: string): { symbol: string; color: string } => {
  if (/error|fail/i.test(label)) return { symbol: "✗", color: "red" };
  if (/warn/i.test(label)) return { symbol: "◈", color: "yellow" };
  if (/success|ok|done/i.test(label)) return { symbol: "✓", color: "green" };
  return { symbol: "✓", color: "cyan" };
};

export const EventLine = ({ label, detail }: { label: string; detail?: string }) => {
  const { symbol, color } = iconForLabel(label);
  return (
    <Box flexDirection="row">
      <Text color={color}>{symbol} </Text>
      <Text dimColor>{detail ?? label}</Text>
    </Box>
  );
};
