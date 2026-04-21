import React from "react";
import { Box, Text } from "ink";
import type { RecoveryDialogPayload } from "../../../appState.js";

/**
 * Overlay shown when an attempt fails and the host needs the user to choose
 * between retry / halt / edit. Wired from `launchRecoveryDialog` in
 * `dialogLauncher.ts` via the `recovery_dialog` prompt-queue kind.
 *
 * Keybindings:
 *   [r] retry  — re-run the failed attempt unchanged
 *   [h] halt   — abandon the turn; return control to the composer
 *   [e] edit   — open the composer pre-filled with the original prompt
 */
export const RecoveryDialogOverlay = ({ payload }: { payload: RecoveryDialogPayload }) => (
  <Box borderStyle="round" flexDirection="column" paddingX={1} paddingY={0}>
    <Text bold color="yellow">
      Attempt failed
    </Text>
    <Text dimColor>
      Turn: {payload.turnId}
    </Text>
    <Box marginTop={1} flexDirection="column">
      <Text color="red" wrap="wrap">
        {payload.reason}
      </Text>
    </Box>
    <Box marginTop={1} flexDirection="column">
      <Text>[r] retry &nbsp; [h] halt &nbsp; [e] edit prompt</Text>
      <Text dimColor>[?] help &nbsp; [Ctrl+C] exit</Text>
    </Box>
  </Box>
);
