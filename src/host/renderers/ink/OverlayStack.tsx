import React from "react";
import { useAppState } from "./hooks/useAppState.js";
import { selectRenderFrame } from "../../renderModel.js";
import { CommandPaletteOverlay } from "./overlays/CommandPaletteOverlay.js";
import { ApprovalOverlay } from "./overlays/ApprovalOverlay.js";
import { ApprovalPromptOverlay } from "./overlays/ApprovalPromptOverlay.js";
import { QuickHelpOverlay } from "./overlays/QuickHelpOverlay.js";
import { SessionPickerOverlay } from "./overlays/SessionPickerOverlay.js";
import { TimelinePickerOverlay } from "./overlays/TimelinePickerOverlay.js";
import { ResumeConfirmOverlay } from "./overlays/ResumeConfirmOverlay.js";

export const OverlayStack = () => {
  const state = useAppState((s) => s);
  const frame = selectRenderFrame({ state, transcript: [] });
  const overlay = frame.overlay;
  if (!overlay) return null;
  if (overlay.kind === "command_palette") {
    return <CommandPaletteOverlay request={overlay.request} />;
  }
  if (overlay.kind === "approval") {
    return <ApprovalOverlay message={overlay.message} />;
  }
  if (overlay.kind === "approval_prompt") {
    return <ApprovalPromptOverlay request={overlay.request} cursorIndex={overlay.cursorIndex} />;
  }
  if (overlay.kind === "quick_help") {
    return overlay.dialogKind === undefined ? (
      <QuickHelpOverlay context={overlay.context} />
    ) : (
      <QuickHelpOverlay context={overlay.context} dialogKind={overlay.dialogKind} />
    );
  }
  if (overlay.kind === "session_picker") {
    return <SessionPickerOverlay request={overlay.request} />;
  }
  if (overlay.kind === "timeline_picker") {
    return <TimelinePickerOverlay />;
  }
  return <ResumeConfirmOverlay message={overlay.message} />;
};
