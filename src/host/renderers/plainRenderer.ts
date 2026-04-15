import type { RenderFrame, TranscriptItem } from "../renderModel.js";

const modeLabel = (mode: "build" | "plan"): string => (mode === "build" ? "BUILD" : "PLAN");

const renderItem = (item: TranscriptItem): string => {
  if (item.kind === "user") {
    return `You: ${item.text}`;
  }
  if (item.kind === "assistant") {
    return `Bakudo: ${item.text}`;
  }
  if (item.kind === "event") {
    const detail = item.detail ? ` ${item.detail}` : "";
    return `· ${item.label}${detail}`;
  }
  const next = item.nextAction ? ` (next: ${item.nextAction})` : "";
  return `Review: ${item.outcome} — ${item.summary}${next}`;
};

const renderHeader = (frame: RenderFrame): string => {
  const repo = frame.header.repoLabel ? `  ${frame.header.repoLabel}` : "";
  return `${frame.header.title}  ${modeLabel(frame.header.mode)}  ${frame.header.sessionLabel}${repo}`;
};

export const renderTranscriptFramePlain = (frame: RenderFrame): string[] => {
  const lines: string[] = [];
  lines.push(renderHeader(frame));
  lines.push("");
  for (const item of frame.transcript) {
    lines.push(renderItem(item));
  }
  lines.push("");
  lines.push(frame.footer.hints.join("  "));
  if (frame.mode === "prompt") {
    lines.push("> ");
  }
  return lines;
};
