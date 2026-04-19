import type { RenderFrame, TranscriptItem } from "../renderModel.js";

import type { ComposerMode } from "../appState.js";
import { DEFAULT_BINDINGS } from "../keybindings/defaults.js";
import { getKeybindingsFor } from "../keybindings/hooks.js";
import { buildQuickHelpContents } from "../overlays/quickHelp.js";
import { renderApprovalPromptLines } from "./approvalPromptCopy.js";
import { renderCommandPaletteOverlayLines } from "./commandPaletteOverlay.js";
import { renderSessionPickerOverlayLines } from "./sessionPickerOverlay.js";

const modeLabel = (mode: ComposerMode): string => {
  if (mode === "plan") {
    return "PLAN";
  }
  if (mode === "autopilot") {
    return "AUTOPILOT";
  }
  return "STANDARD";
};

const renderItem = (item: TranscriptItem): string[] => {
  if (item.kind === "user") {
    return [`You: ${item.text}`];
  }
  if (item.kind === "assistant") {
    return [`Bakudo: ${item.text}`];
  }
  if (item.kind === "event") {
    const detail = item.detail ? ` ${item.detail}` : "";
    return [`· ${item.label}${detail}`];
  }
  if (item.kind === "output") {
    return item.text.split("\n").map((line) => `  ${line}`);
  }
  const next = item.nextAction ? ` (next: ${item.nextAction})` : "";
  return [`Review: ${item.outcome} — ${item.summary}${next}`];
};

const renderHeader = (frame: RenderFrame): string => {
  const repo = frame.header.repoLabel ? `  ${frame.header.repoLabel}` : "";
  return `${frame.header.title}  ${modeLabel(frame.header.mode)}  ${frame.header.sessionLabel}${repo}`;
};

const renderOverlay = (frame: RenderFrame): string[] => {
  const overlay = frame.overlay;
  if (overlay === undefined) {
    return [];
  }
  if (overlay.kind === "approval") {
    return [`[approval] ${overlay.message} [y/N]`];
  }
  if (overlay.kind === "approval_prompt") {
    // VERBATIM copy per Phase 4 spec — mirrors the transcript renderer
    // exactly since the plain renderer is used for non-TTY/log capture.
    return renderApprovalPromptLines(overlay.request, overlay.cursorIndex);
  }
  if (overlay.kind === "resume_confirm") {
    return [`[resume?] ${overlay.message} [y/N]`];
  }
  if (overlay.kind === "command_palette") {
    return renderCommandPaletteOverlayLines(overlay.request);
  }
  if (overlay.kind === "timeline_picker") {
    return ["[timeline picker]"];
  }
  if (overlay.kind === "quick_help") {
    const registered = getKeybindingsFor(
      overlay.context === "dialog"
        ? "Dialog"
        : overlay.context === "inspect"
          ? "Inspect"
          : overlay.context === "transcript"
            ? "Transcript"
            : "Composer",
    );
    return buildQuickHelpContents(
      overlay.context,
      DEFAULT_BINDINGS,
      registered.size > 0 ? registered : undefined,
      overlay.dialogKind,
    );
  }
  return renderSessionPickerOverlayLines(overlay.request);
};

export const renderTranscriptFramePlain = (frame: RenderFrame): string[] => {
  const lines: string[] = [];
  lines.push(renderHeader(frame));
  lines.push("");
  for (const item of frame.transcript) {
    lines.push(...renderItem(item));
  }
  lines.push("");
  for (const overlayLine of renderOverlay(frame)) {
    lines.push(overlayLine);
  }
  lines.push(frame.footer.hints.join("  "));
  if (frame.mode === "prompt") {
    lines.push("> ");
  }
  return lines;
};
