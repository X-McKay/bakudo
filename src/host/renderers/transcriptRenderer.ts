import { bold, cyan, dim, gray, green, red, renderModeChip, yellow } from "../ansi.js";
import { renderApprovalPromptLines } from "./approvalPromptCopy.js";
import type { RenderFrame, TranscriptItem } from "../renderModel.js";

const toneWrap = (
  text: string,
  tone: "info" | "success" | "warning" | "error" | undefined,
): string => {
  if (tone === "info") {
    return cyan(text);
  }
  if (tone === "success") {
    return green(text);
  }
  if (tone === "warning") {
    return yellow(text);
  }
  if (tone === "error") {
    return red(text);
  }
  return text;
};

const renderItem = (item: TranscriptItem): string => {
  if (item.kind === "user") {
    return `${dim("You: ")}${item.text}`;
  }
  if (item.kind === "assistant") {
    return `${bold("Bakudo: ")}${toneWrap(item.text, item.tone)}`;
  }
  if (item.kind === "event") {
    const detail = item.detail ? ` ${item.detail}` : "";
    return dim(`· ${item.label}${detail}`);
  }
  const next = item.nextAction ? ` (next: ${item.nextAction})` : "";
  return `${bold("Review: ")}${item.outcome} — ${item.summary}${next}`;
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
    return [yellow(`[approval] ${overlay.message} [y/N]`)];
  }
  if (overlay.kind === "approval_prompt") {
    // VERBATIM copy per Phase 4 spec (04-provenance-first-inspection-and-approval.md
    // §Approval Prompt UX). No tone wrapping — must match byte-for-byte.
    return renderApprovalPromptLines(overlay.request);
  }
  if (overlay.kind === "resume_confirm") {
    return [yellow(`[resume?] ${overlay.message} [y/N]`)];
  }
  if (overlay.kind === "command_palette") {
    return [cyan("[command palette]")];
  }
  if (overlay.kind === "timeline_picker") {
    return [cyan("[timeline picker]")];
  }
  return [cyan("[session picker]")];
};

export const renderTranscriptFrame = (frame: RenderFrame): string[] => {
  const lines: string[] = [];
  lines.push(renderHeader(frame));
  lines.push("");
  for (const item of frame.transcript) {
    lines.push(renderItem(item));
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
