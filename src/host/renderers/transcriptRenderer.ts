import { bold, dim, gray, renderBox, renderModeChip, renderStatusSymbol, tone } from "../ansi.js";
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
    // Render multi-line output blocks as indented, dimmed text — no bullet prefix.
    // This is the UX Realignment "output" kind (08-ux-realignment.md §1).
    return item.text.split("\n").map((line) => `  ${dim(line)}`);
  }
  // "review" kind — show a polished outcome card with Unicode status symbol.
  const symbol = renderStatusSymbol(item.outcome);
  const next = item.nextAction ? `  ${dim(`→ ${item.nextAction}`)}` : "";
  return [`${bold("Review: ")}${symbol} ${item.outcome} — ${item.summary}${next}`];
};

const renderHeader = (frame: RenderFrame): string => {
  const chip = renderModeChip(frame.header.mode);
  const repo = frame.header.repoLabel ? `  ${gray(frame.header.repoLabel)}` : "";
  return `${bold(frame.header.title)}  ${chip}  ${gray(frame.header.sessionLabel)}${repo}`;
};

const stylizeApprovalPromptLine = (line: string): string => {
  const wantsPrefix = "Bakudo: Worker wants to run: ";
  if (line.startsWith(wantsPrefix)) {
    const command = line.slice(wantsPrefix.length);
    return `${tone.info("Bakudo:")} Worker wants to run: ${bold(command)}`;
  }
  const agentPrefix = "Bakudo: This matches no existing allow rule in agent=";
  if (line.startsWith(agentPrefix) && line.endsWith(".")) {
    const agent = line.slice(agentPrefix.length, -1);
    return `${tone.info("Bakudo:")} This matches no existing allow rule in ${bold(`agent=${agent}`)}.`;
  }
  return line;
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
    // Keep the core approval lines verbatim after ANSI stripping, but frame
    // them as a dialog in TTY mode so the prompt reads like a distinct step.
    return [
      tone.warning("──────── approval required ────────"),
      ...renderApprovalPromptLines(overlay.request, overlay.cursorIndex).map(stylizeApprovalPromptLine),
      tone.warning("────────────────────────────────────"),
    ];
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
  // Footer: separator + hint bar (08-ux-realignment.md §4)
  lines.push(dim("─".repeat(48)));
  lines.push(dim(frame.footer.hints.join("  ")));
  if (frame.mode === "prompt") {
    lines.push("> ");
  }
  return lines;
};
