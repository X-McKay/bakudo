import {
  APPROVAL_DIALOG_CURSOR_COUNT,
  type ApprovalPromptRequest,
  type CommandPaletteRequest,
  type SessionPickerPayload,
} from "../appState.js";
import type { ComposerMode } from "../appState.js";
import { renderPermissionDisplayCommand, suggestAllowAlwaysPattern } from "../approvalPolicy.js";
import { matchesFuzzy } from "../fuzzyFilter.js";
import { DEFAULT_BINDINGS } from "../keybindings/defaults.js";
import { getKeybindingsFor } from "../keybindings/hooks.js";
import { buildQuickHelpContents } from "../overlays/quickHelp.js";
import type { RenderFrame, TranscriptItem } from "../renderModel.js";

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

const normalizeApprovalCursor = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const floored = Math.floor(value);
  if (floored < 0) {
    return 0;
  }
  if (floored >= APPROVAL_DIALOG_CURSOR_COUNT) {
    return APPROVAL_DIALOG_CURSOR_COUNT - 1;
  }
  return floored;
};

/**
 * Render the VERBATIM Phase 4 approval-prompt overlay. Exact copy is
 * specified in `plans/bakudo-ux/04-provenance-first-inspection-and-approval.md`
 * §"Approval Prompt UX" and echoed in `phase-4-record-design.md` §3.4.
 *
 * No tone/ANSI wrapping — the overlay mirrors into the plain renderer which
 * must stay colour-free. `cursorIndex` drives the ❯ marker across the four
 * option rows (0 = allow once … 3 = show context). Defaults to `0`.
 */
export const renderApprovalPromptLines = (
  request: ApprovalPromptRequest,
  cursorIndex: number = 0,
): string[] => {
  const displayCommand = renderPermissionDisplayCommand(request.tool, request.argument);
  const pattern = suggestAllowAlwaysPattern(request.tool, request.argument);
  const agent = request.policySnapshot.agent;
  const normalized = normalizeApprovalCursor(cursorIndex);
  const marker = (idx: number): string => (idx === normalized ? "  \u276F " : "    ");
  return [
    `Bakudo: Worker wants to run: ${displayCommand}`,
    `Bakudo: This matches no existing allow rule in agent=${agent}.`,
    "",
    `${marker(0)}[1] allow once`,
    `${marker(1)}[2] allow always for ${request.tool}(${pattern})`,
    `${marker(2)}[3] deny`,
    `${marker(3)}[4] show context (inspect attempt spec)`,
    "",
    "Choice [1/2/3/4] (Shift+Tab to go back):",
  ];
};

/**
 * Filter the command-palette item list by the current query.
 * Extracted so renderer and reducer share the same predicate.
 */
export const filterPaletteItems = (
  request: CommandPaletteRequest,
): ReadonlyArray<CommandPaletteRequest["items"][number]> => {
  if (request.input.length === 0) {
    return request.items;
  }
  return request.items.filter((item) => matchesFuzzy(item.name, request.input));
};

/**
 * Build the command-palette overlay lines. Plain (no ANSI) — consumers can
 * colorize at render time.
 */
export const renderCommandPaletteOverlayLines = (request: CommandPaletteRequest): string[] => {
  const visible = filterPaletteItems(request);
  const header = `> ${request.input}`;
  const banner = "[command palette]";
  if (visible.length === 0) {
    return [header, banner, "(no matches)"];
  }
  const selected = Math.min(request.selectedIndex, visible.length - 1);
  const rows = visible.map((item, index) => {
    const cursor = index === selected ? "❯" : " ";
    return `${cursor} /${item.name}  — ${item.description}`;
  });
  return [header, banner, ...rows];
};

export const filterSessionPickerItems = (
  payload: SessionPickerPayload,
): ReadonlyArray<SessionPickerPayload["items"][number]> => {
  if (payload.input.length === 0) {
    return payload.items;
  }
  return payload.items.filter((item) => matchesFuzzy(item.label, payload.input));
};

export const renderSessionPickerOverlayLines = (payload: SessionPickerPayload): string[] => {
  const visible = filterSessionPickerItems(payload);
  const header = `> ${payload.input}`;
  const banner = "[session picker]";
  if (visible.length === 0) {
    return [header, banner, "(no matches)"];
  }
  const selected = Math.min(payload.selectedIndex, visible.length - 1);
  const rows = visible.map((item, index) => {
    const cursor = index === selected ? "❯" : " ";
    return `${cursor} ${item.label}`;
  });
  return [header, banner, ...rows];
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
    // Keep the approval lines verbatim and add a lightweight frame so the
    // plain renderer still reads as a dialog in logs and non-TTY output.
    return [
      "-------- approval required --------",
      ...renderApprovalPromptLines(overlay.request, overlay.cursorIndex),
      "-----------------------------------",
    ];
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
