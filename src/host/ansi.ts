import type { TaskMode } from "../protocol.js";
import type { ComposerMode } from "./appState.js";
import { getActiveTheme } from "./themes/index.js";

const runtimeProcess = (
  globalThis as unknown as {
    process?: {
      stdout?: { isTTY?: boolean; columns?: number };
      env?: Record<string, string | undefined>;
    };
  }
).process;

/**
 * Legacy raw SGR sequences. Retained so pre-theme call sites keep compiling
 * and so that helpers that really do want a specific style (e.g. `bold`)
 * have something to reference directly.
 *
 * Color-named entries (`cyan`, `green`, etc.) mirror the **default dark
 * theme** values — they do NOT auto-update when the active theme changes.
 * New code should prefer `tone.*()` (defined below) which reads through the
 * active theme on every call.
 */
export const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  blue: "\u001B[34m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  magenta: "\u001B[35m",
  gray: "\u001B[90m",
} as const;

export const supportsAnsi = (): boolean =>
  runtimeProcess?.stdout?.isTTY === true && runtimeProcess?.env?.NO_COLOR === undefined;

export const paint = (text: string, ...codes: string[]): string =>
  supportsAnsi() ? `${codes.join("")}${text}${ANSI.reset}` : text;

export const bold = (text: string): string => paint(text, ANSI.bold);
export const dim = (text: string): string => paint(text, getActiveTheme().dim);

/**
 * Theme-aware color wrappers. These read the *active* theme on each call —
 * swapping themes via `setActiveTheme` changes their output immediately.
 *
 * The function names (`cyan`, `green`, `yellow`, …) intentionally keep the
 * legacy color vocabulary so pre-Phase-5 callers keep working without a
 * cascade of renames. The *semantics* now route through the theme:
 *
 *   - `cyan(...)`  → `tone.info(...)`      (the role cyan played)
 *   - `green(...)` → `tone.success(...)`
 *   - `yellow(...)`→ `tone.warning(...)`
 *   - `red(...)`   → `tone.error(...)`
 *   - `blue(...)`  → theme.info  (blue and cyan collapse under the `info`
 *                   semantic; no caller currently distinguishes them)
 *   - `gray(...)`  → theme.dim   (gray was only used for de-emphasis)
 *
 * In the default `dark` theme all of these emit the exact same SGR bytes
 * as pre-Phase-5 bakudo, preserving snapshot tests byte-for-byte.
 */
export const cyan = (text: string): string => paint(text, getActiveTheme().info);
export const blue = (text: string): string => paint(text, getActiveTheme().info);
export const green = (text: string): string => paint(text, getActiveTheme().success);
export const yellow = (text: string): string => paint(text, getActiveTheme().warning);
export const red = (text: string): string => paint(text, getActiveTheme().error);
// `gray` is deliberately NOT theme-routed — it's the one color whose legacy
// output (`\u001B[90m`, bright-black) is used as a plain neutral, not a
// semantic role. Routing it through `theme.dim` would emit SGR-2 instead,
// breaking byte-equality with pre-Phase-5 output in cross-sink snapshots.
export const gray = (text: string): string => paint(text, ANSI.gray);

/**
 * Semantic (theme-aware) tone helpers. New code should prefer these over the
 * color-named wrappers above — they document *why* a color is being used and
 * are stable across theme swaps.
 */
export const tone = {
  info: (text: string): string => paint(text, getActiveTheme().info),
  success: (text: string): string => paint(text, getActiveTheme().success),
  warning: (text: string): string => paint(text, getActiveTheme().warning),
  error: (text: string): string => paint(text, getActiveTheme().error),
  prompt: (text: string): string => paint(text, getActiveTheme().prompt),
  autoAccept: (text: string): string => paint(text, getActiveTheme().autoAccept),
  dim: (text: string): string => paint(text, getActiveTheme().dim),
  /**
   * Renders subagent labels. Use ONLY for subagent identifiers —
   * the namespaced key enforces this via lint.
   */
  subagent: (text: string): string => paint(text, getActiveTheme().red_FOR_SUBAGENTS_ONLY),
} as const;

/**
 * Render the product wordmark + optional subtitle as a two-line header.
 * The title is rendered in bold-info color; the subtitle is dimmed.
 * Matches the visual weight of OpenCode / Codex CLI startup headers.
 */
export const renderTitle = (title: string, subtitle?: string): string[] => [
  bold(blue(title)),
  ...(subtitle ? [dim(subtitle)] : []),
];

/**
 * Render a section heading with a trailing separator line.
 * e.g.  "Usage ──────────────────"
 * The separator fills to 40 columns (truncated if title is long).
 */
export const renderSection = (title: string): string => {
  const label = bold(cyan(title));
  const plainLen = title.length;
  const sepLen = Math.max(2, 40 - plainLen - 1);
  return `${label} ${dim("─".repeat(sepLen))}`;
};

export const renderKeyValue = (label: string, value: string): string =>
  `${dim(label.padEnd(8))} ${value}`;

export const renderCommandHint = (command: string, description: string): string =>
  `${paint(command.padEnd(28), ANSI.bold, ANSI.magenta)} ${dim(description)}`;

export const renderModeChip = (mode: TaskMode | ComposerMode): string => {
  const theme = getActiveTheme();
  if (mode === "plan") {
    return paint(" PLAN ", ANSI.bold, theme.info);
  }
  if (mode === "autopilot") {
    return paint(" AUTO ", ANSI.bold, theme.success);
  }
  if (mode === "standard") {
    return paint(" STD ", ANSI.bold, theme.warning);
  }
  // legacy TaskMode "build"
  return paint(" BUILD ", ANSI.bold, theme.warning);
};

export const renderApprovalChip = (autoApprove: boolean): string => {
  const theme = getActiveTheme();
  return autoApprove
    ? paint("AUTO", ANSI.bold, theme.success)
    : paint("PROMPT", ANSI.bold, theme.autoAccept);
};

/**
 * Render a status badge using Unicode symbols for a polished look.
 * Matches the visual style of Codex CLI / OpenCode status indicators.
 */
export const renderStatusSymbol = (status: string): string => {
  switch (status) {
    case "completed":
    case "succeeded":
    case "success":
      return tone.success("✓");
    case "running":
    case "reviewing":
      return tone.info("◆");
    case "planned":
    case "queued":
      return tone.info("◇");
    case "awaiting_user":
    case "blocked":
    case "blocked_needs_user":
      return tone.warning("◈");
    case "failed":
    case "retryable_failure":
    case "policy_denied":
      return tone.error("✗");
    default:
      return gray("·");
  }
};

export const overviewPanelLines = (): string[] => [
  dim("Enter a goal to run with the current mode."),
  dim("Use /status to inspect sessions, /review for the host verdict, /exit to leave."),
];

export const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

export const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

export const displayWidth = (value: string): number => stripAnsi(value).length;

export const fitDisplay = (value: string, width: number): string => {
  if (width <= 0) {
    return "";
  }
  const plain = stripAnsi(value);
  if (plain.length <= width) {
    return `${value}${" ".repeat(width - plain.length)}`;
  }
  if (width <= 3) {
    return plain.slice(0, width);
  }
  return `${plain.slice(0, width - 3)}...`;
};

export const wrapPlain = (value: string, width: number): string[] => {
  const plain = stripAnsi(value);
  if (width <= 0) {
    return [plain];
  }
  const wrapped: string[] = [];
  let remaining = plain;
  while (remaining.length > width) {
    wrapped.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  wrapped.push(remaining);
  return wrapped;
};

/**
 * Render a framed box using Unicode box-drawing characters.
 * Matches the visual style of OpenCode / Codex CLI dialog boxes.
 *
 *   ╭─ title ─────────────────────╮
 *   │ content line                │
 *   ╰─────────────────────────────╯
 */
export const renderBox = (
  title: string,
  lines: string[],
  width: number,
  height?: number,
): string[] => {
  const innerWidth = Math.max(8, width - 4);
  // Build top border: ╭─ title ──...──╮
  const titlePlain = stripAnsi(title);
  const titlePart = titlePlain.length > 0 ? `─ ${title} ` : "";
  const titlePlainLen = titlePlain.length > 0 ? titlePlain.length + 3 : 0;
  const topFillLen = Math.max(0, width - 2 - titlePlainLen);
  const top = `╭${titlePart}${"─".repeat(topFillLen)}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  const content = lines.flatMap((line) =>
    wrapPlain(line, innerWidth).map((part) => `│ ${fitDisplay(part, innerWidth)} │`),
  );
  const targetHeight = height === undefined ? content.length : Math.max(content.length, height);
  const padded = [...content];
  while (padded.length < targetHeight) {
    padded.push(`│ ${" ".repeat(innerWidth)} │`);
  }
  return [top, ...padded, bottom];
};

export const mergeColumns = (left: string[], right: string[], gap = "  "): string[] => {
  const height = Math.max(left.length, right.length);
  const leftWidth = Math.max(...left.map((line) => displayWidth(line)), 0);
  const rows: string[] = [];
  for (let index = 0; index < height; index += 1) {
    const leftLine = left[index] ?? " ".repeat(leftWidth);
    const rightLine = right[index] ?? "";
    rows.push(`${fitDisplay(leftLine, leftWidth)}${gap}${rightLine}`);
  }
  return rows;
};
