import { bold, dim, gray, renderBox, renderModeChip, tone } from "../ansi.js";
import { DEFAULT_BINDINGS } from "../keybindings/defaults.js";
import { getKeybindingsFor } from "../keybindings/hooks.js";
import { buildQuickHelpContents } from "../overlays/quickHelp.js";
import { renderApprovalPromptLines } from "./approvalPromptCopy.js";
import { renderCommandPaletteOverlayLines } from "./commandPaletteOverlay.js";
import { renderSessionPickerOverlayLines } from "./sessionPickerOverlay.js";
import type { RenderFrame, TranscriptItem } from "../renderModel.js";

const toneWrap = (
  text: string,
  toneName: "info" | "success" | "warning" | "error" | undefined,
): string => {
  if (toneName === "info") {
    return tone.info(text);
  }
  if (toneName === "success") {
    return tone.success(text);
  }
  if (toneName === "warning") {
    return tone.warning(text);
  }
  if (toneName === "error") {
    return tone.error(text);
  }
  return text;
};

const renderItem = (item: TranscriptItem): string[] => {
  if (item.kind === "user") {
    return [`${dim("You: ")}${item.text}`];
  }
  if (item.kind === "assistant") {
    return [`${bold("Bakudo: ")}${toneWrap(item.text, item.tone)}`];
  }
  if (item.kind === "event") {
    const detail = item.detail ? ` ${item.detail}` : "";
    return [dim(`· ${item.label}${detail}`)];
  }
  if (item.kind === "output") {
    return item.text.split("\n").map((line) => `  ${dim(line)}`);
  }
  const next = item.nextAction ? ` (next: ${item.nextAction})` : "";
  return [`${bold("Review: ")}${item.outcome} — ${item.summary}${next}`];
};

const renderHeader = (frame: RenderFrame): string => {
  const chip = renderModeChip(frame.header.mode);
  const repo = frame.header.repoLabel ? `  ${gray(frame.header.repoLabel)}` : "";
  return `${bold(frame.header.title)}  ${chip}  ${gray(frame.header.sessionLabel)}${repo}`;
};

const renderOverlay = (frame: RenderFrame): string[] => {
  const overlay = frame.overlay;
  if (overlay === undefined) {
    return [];
  }
  if (overlay.kind === "approval") {
    return [tone.warning(`[approval] ${overlay.message} [y/N]`)];
  }
  if (overlay.kind === "approval_prompt") {
    // VERBATIM copy per Phase 4 spec (04-provenance-first-inspection-and-approval.md
    // §Approval Prompt UX). No tone wrapping — must match byte-for-byte.
    return renderApprovalPromptLines(overlay.request, overlay.cursorIndex);
  }
  if (overlay.kind === "resume_confirm") {
    return [tone.warning(`[resume?] ${overlay.message} [y/N]`)];
  }
  if (overlay.kind === "command_palette") {
    return renderCommandPaletteOverlayLines(overlay.request).map((line) => tone.info(line));
  }
  if (overlay.kind === "timeline_picker") {
    return [tone.info("[timeline picker]")];
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
    const body = buildQuickHelpContents(
      overlay.context,
      DEFAULT_BINDINGS,
      registered.size > 0 ? registered : undefined,
      overlay.dialogKind,
    );
    return renderBox("?", body, 60).map((line) => tone.info(line));
  }
  return renderSessionPickerOverlayLines(overlay.request).map((line) => tone.info(line));
};

export const renderTranscriptFrame = (frame: RenderFrame): string[] => {
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
  lines.push(dim(frame.footer.hints.join("  ")));
  if (frame.mode === "prompt") {
    lines.push("> ");
  }
  return lines;
};
