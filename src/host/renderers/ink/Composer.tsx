import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { useStore } from "./StoreProvider.js";

export const Composer = () => {
  const store = useStore();
  const dispatch = useAppState((s) => s.dispatch);
  const pendingApproval = useAppState((s) => s.promptQueue[0]?.kind === "approval_prompt");
  const [buffer, setBuffer] = useState("");
  // Mirror buffer in a ref so the useInput callback sees the latest value
  // synchronously — React may batch state updates across multiple stdin chunks
  // (and the useEffectEvent in ink's useInput only refreshes its closure on
  // re-render), so reading from state alone gives stale values in tests.
  const bufferRef = useRef("");

  const updateBuffer = (next: string) => {
    bufferRef.current = next;
    setBuffer(next);
  };

  useInput((input, key) => {
    // Disable text entry while dispatch is in flight or an approval prompt is open.
    if (dispatch.inFlight) return;
    if (pendingApproval) return; // Approval-prompt keys handled by the overlay; composer passive.

    if (key.return) {
      const text = bufferRef.current.trim();
      if (text.length === 0) return;
      store.dispatch({ type: "submit", text });
      updateBuffer("");
      return;
    }
    if (key.backspace || key.delete) {
      updateBuffer(bufferRef.current.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input && input.length > 0) {
      updateBuffer(bufferRef.current + input);
    }
  });

  if (dispatch.inFlight) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> "}</Text>
        <Text dimColor>{`${dispatch.label}${dispatch.detail ? ` · ${dispatch.detail}` : ""}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Text>{"> "}</Text>
      <Text>{buffer}</Text>
    </Box>
  );
};
