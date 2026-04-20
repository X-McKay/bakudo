import React from "react";
import { Box, Text } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { getActiveTheme } from "../../themes/index.js";

const modeChipColor = (mode: string, theme: ReturnType<typeof getActiveTheme>): string => {
  if (mode === "plan") return "cyan";
  if (mode === "autopilot") return "green";
  return "yellow";
};

const modeChipLabel = (mode: string): string => {
  if (mode === "plan") return " PLAN ";
  if (mode === "autopilot") return " AUTO ";
  return " STD ";
};

const truncateSession = (id: string | undefined, turn: string | undefined): string => {
  if (!id) return "new session";
  const stripped = id.startsWith("session-") ? id.slice("session-".length) : id;
  const short = stripped.length > 14 ? `${stripped.slice(0, 10)}…${stripped.slice(-3)}` : stripped;
  const sessionLabel = `session ${short}`;
  if (!turn) return sessionLabel;
  const turnMatch = /^turn-(.+)$/u.exec(turn);
  const turnLabel = turnMatch ? `turn ${turnMatch[1]}` : turn;
  return `${sessionLabel} / ${turnLabel}`;
};

export const Header = ({ repoLabel }: { repoLabel?: string }) => {
  const mode = useAppState((s) => s.composer.mode);
  const activeSessionId = useAppState((s) => s.activeSessionId);
  const activeTurnId = useAppState((s) => s.activeTurnId);
  const theme = getActiveTheme();
  const chipColor = modeChipColor(mode, theme);

  return (
    <Box flexDirection="row" gap={2}>
      <Text bold>Bakudo</Text>
      <Text color={chipColor} bold>{modeChipLabel(mode)}</Text>
      <Text dimColor>{truncateSession(activeSessionId, activeTurnId)}</Text>
      {repoLabel !== undefined ? <Text dimColor>{repoLabel}</Text> : null}
    </Box>
  );
};
