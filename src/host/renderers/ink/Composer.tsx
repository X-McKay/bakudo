import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useAppState } from "./hooks/useAppState.js";
import { useStore } from "./StoreProvider.js";
import { Spinner } from "./Spinner.js";

const modeColor = (mode: string): string => {
  if (mode === "plan") return "cyan";
  if (mode === "autopilot") return "green";
  return "yellow";
};

export const Composer = () => {
  const store = useStore();
  const mode = useAppState((s) => s.composer.mode);
  const autoApprove = useAppState((s) => s.composer.autoApprove);
  const model = useAppState((s) => s.composer.model);
  const agent = useAppState((s) => s.composer.agent);
  const provider = useAppState((s) => s.composer.provider);
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

  const approvalLabel = autoApprove ? "AUTO" : "PROMPT";
  const metadataRow = [mode, model || "—", agent || "—", provider || "—", approvalLabel]
    .filter(Boolean)
    .join(" · ");
  const rail = modeColor(mode);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={rail} bold>{"┃ "}</Text>
        {dispatch.inFlight ? (
          <Box flexDirection="row">
            <Spinner color={rail} />
            <Text dimColor>{` ${dispatch.label}${dispatch.detail ? ` · ${dispatch.detail}` : ""}`}</Text>
          </Box>
        ) : (
          <Text>{buffer.length > 0 ? buffer : ""}</Text>
        )}
      </Box>
      <Box flexDirection="row">
        <Text dimColor>{`  ${metadataRow}`}</Text>
      </Box>
    </Box>
  );
};
