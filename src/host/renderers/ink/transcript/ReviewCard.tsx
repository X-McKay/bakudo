import React from "react";
import { Box, Text } from "ink";

const outcomeSymbol = (outcome: string): { symbol: string; color: string } => {
  if (/success|completed|succeeded/i.test(outcome)) return { symbol: "✓", color: "green" };
  if (/fail|denied/i.test(outcome)) return { symbol: "✗", color: "red" };
  if (/running|reviewing/i.test(outcome)) return { symbol: "◆", color: "cyan" };
  return { symbol: "·", color: "white" };
};

export const ReviewCard = ({
  outcome,
  summary,
  nextAction,
}: {
  outcome: string;
  summary: string;
  nextAction?: string;
}) => {
  const { symbol, color } = outcomeSymbol(outcome);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>Review: </Text>
        <Text color={color}>{symbol} </Text>
        <Text>{`${outcome} — ${summary}`}</Text>
      </Box>
      {nextAction ? (
        <Box flexDirection="row">
          <Text dimColor>{`  → ${nextAction}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
