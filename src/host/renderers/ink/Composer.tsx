import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { CommandPaletteRequest, RecoveryDialogPayload, SessionPickerPayload } from "../../appState.js";
import { matchesFuzzy } from "../../fuzzyFilter.js";
import { answerPrompt, cancelPrompt } from "../../promptResolvers.js";
import { useAppState } from "./hooks/useAppState.js";
import { useStore } from "./StoreProvider.js";
import { Spinner } from "./Spinner.js";

const modeColor = (mode: string): string => {
  if (mode === "plan") return "cyan";
  if (mode === "autopilot") return "green";
  return "yellow";
};

const selectPaletteCommand = (payload: CommandPaletteRequest): string => {
  const visible = payload.input.length === 0
    ? payload.items
    : payload.items.filter((item) => matchesFuzzy(item.name, payload.input));
  if (visible.length === 0) {
    return "";
  }
  return visible[Math.min(payload.selectedIndex, visible.length - 1)]?.name ?? "";
};

const selectSessionId = (payload: SessionPickerPayload): string => {
  const visible = payload.input.length === 0
    ? payload.items
    : payload.items.filter((item) => matchesFuzzy(item.label, payload.input));
  if (visible.length === 0) {
    return "";
  }
  return visible[Math.min(payload.selectedIndex, visible.length - 1)]?.sessionId ?? "";
};

export const Composer = () => {
  const store = useStore();
  const mode = useAppState((s) => s.composer.mode);
  const autoApprove = useAppState((s) => s.composer.autoApprove);
  const model = useAppState((s) => s.composer.model);
  const agent = useAppState((s) => s.composer.agent);
  const provider = useAppState((s) => s.composer.provider);
  const dispatch = useAppState((s) => s.dispatch);
  const headPrompt = useAppState((s) => s.promptQueue[0]);
  const approvalDialogCursor = useAppState((s) => s.approvalDialogCursor);
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
    if (headPrompt !== undefined) {
      if (key.escape) {
        cancelPrompt(headPrompt.id);
        return;
      }

      if (headPrompt.kind === "approval_prompt") {
        if (input >= "1" && input <= "4") {
          answerPrompt(headPrompt.id, input);
          return;
        }
        if (key.return) {
          answerPrompt(headPrompt.id, String(approvalDialogCursor + 1));
          return;
        }
        if (key.upArrow || (input === "\t" && key.shift)) {
          store.dispatch({ type: "approval_dialog_cursor_up" });
          return;
        }
        if (key.downArrow || input === "\t") {
          store.dispatch({ type: "approval_dialog_cursor_down" });
          return;
        }
        return;
      }

      if (headPrompt.kind === "command_palette") {
        const payload = headPrompt.payload as CommandPaletteRequest;
        if (key.return) {
          answerPrompt(headPrompt.id, selectPaletteCommand(payload));
          return;
        }
        if (key.downArrow || input === "\t" || (key.ctrl && input.toLowerCase() === "n")) {
          store.dispatch({ type: "palette_select_next", id: headPrompt.id });
          return;
        }
        if (key.upArrow || (input === "\t" && key.shift) || (key.ctrl && input.toLowerCase() === "p")) {
          store.dispatch({ type: "palette_select_prev", id: headPrompt.id });
          return;
        }
        if (key.backspace || key.delete) {
          store.dispatch({
            type: "palette_input_change",
            id: headPrompt.id,
            input: payload.input.slice(0, -1),
          });
          return;
        }
        if (key.ctrl || key.meta) return;
        if (input.length > 0) {
          store.dispatch({
            type: "palette_input_change",
            id: headPrompt.id,
            input: payload.input + input,
          });
        }
        return;
      }

      if (headPrompt.kind === "session_picker") {
        const payload = headPrompt.payload as SessionPickerPayload;
        if (key.return) {
          answerPrompt(headPrompt.id, selectSessionId(payload));
          return;
        }
        if (key.downArrow || input === "\t" || (key.ctrl && input.toLowerCase() === "n")) {
          store.dispatch({ type: "session_picker_select_next", id: headPrompt.id });
          return;
        }
        if (key.upArrow || (input === "\t" && key.shift) || (key.ctrl && input.toLowerCase() === "p")) {
          store.dispatch({ type: "session_picker_select_prev", id: headPrompt.id });
          return;
        }
        if (key.backspace || key.delete) {
          store.dispatch({
            type: "session_picker_input_change",
            id: headPrompt.id,
            input: payload.input.slice(0, -1),
          });
          return;
        }
        if (key.ctrl || key.meta) return;
        if (input.length > 0) {
          store.dispatch({
            type: "session_picker_input_change",
            id: headPrompt.id,
            input: payload.input + input,
          });
        }
        return;
      }

      if (headPrompt.kind === "recovery_dialog") {
        // [r] retry  [h] halt  [e] edit  — Esc is handled above by cancelPrompt
        const _payload = headPrompt.payload as RecoveryDialogPayload;
        void _payload;
        if (input.toLowerCase() === "r") {
          answerPrompt(headPrompt.id, "retry");
          return;
        }
        if (input.toLowerCase() === "h") {
          answerPrompt(headPrompt.id, "halt");
          return;
        }
        if (input.toLowerCase() === "e") {
          answerPrompt(headPrompt.id, "edit");
          return;
        }
        // Swallow all other keys while the recovery dialog is active.
        return;
      }

      if (key.return) {
        answerPrompt(headPrompt.id, bufferRef.current.trim());
        updateBuffer("");
        return;
      }
      if (key.backspace || key.delete) {
        updateBuffer(bufferRef.current.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input.length > 0) {
        updateBuffer(bufferRef.current + input);
      }
      return;
    }

    // Disable text entry while a dispatch is in flight and no prompt is active.
    if (dispatch.inFlight) return;

    // [Tab] (no modifier) toggles the sidebar when the buffer is empty and idle.
    if (input === "\t" && !key.shift && bufferRef.current.length === 0) {
      store.dispatch({ type: "toggle_sidebar" });
      return;
    }

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
    if (input.length > 0) {
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
