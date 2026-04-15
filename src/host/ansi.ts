import type { TaskMode } from "../protocol.js";

const runtimeProcess = (
  globalThis as unknown as {
    process?: {
      stdout?: { isTTY?: boolean; columns?: number };
      env?: Record<string, string | undefined>;
    };
  }
).process;

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
export const dim = (text: string): string => paint(text, ANSI.dim);
export const cyan = (text: string): string => paint(text, ANSI.cyan);
export const blue = (text: string): string => paint(text, ANSI.blue);
export const green = (text: string): string => paint(text, ANSI.green);
export const yellow = (text: string): string => paint(text, ANSI.yellow);
export const red = (text: string): string => paint(text, ANSI.red);
export const gray = (text: string): string => paint(text, ANSI.gray);

export const renderTitle = (title: string, subtitle?: string): string[] => [
  bold(blue(title)),
  ...(subtitle ? [dim(subtitle)] : []),
];

export const renderSection = (title: string): string => bold(cyan(title));

export const renderKeyValue = (label: string, value: string): string =>
  `${dim(label.padEnd(8))} ${value}`;

export const renderCommandHint = (command: string, description: string): string =>
  `${paint(command.padEnd(28), ANSI.bold, ANSI.magenta)} ${dim(description)}`;

export const renderModeChip = (mode: TaskMode): string =>
  mode === "build" ? paint("BUILD", ANSI.bold, ANSI.yellow) : paint("PLAN", ANSI.bold, ANSI.cyan);

export const renderApprovalChip = (autoApprove: boolean): string =>
  autoApprove ? paint("AUTO", ANSI.bold, ANSI.green) : paint("PROMPT", ANSI.bold, ANSI.magenta);

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

export const renderBox = (
  title: string,
  lines: string[],
  width: number,
  height?: number,
): string[] => {
  const innerWidth = Math.max(8, width - 4);
  const top = `+${"-".repeat(Math.max(0, width - 2))}+`;
  const heading = `| ${fitDisplay(title, innerWidth)} |`;
  const content = lines.flatMap((line) =>
    wrapPlain(line, innerWidth).map((part) => `| ${fitDisplay(part, innerWidth)} |`),
  );
  const targetHeight = height === undefined ? content.length : Math.max(content.length, height);
  const padded = [...content];
  while (padded.length < targetHeight) {
    padded.push(`| ${" ".repeat(innerWidth)} |`);
  }
  return [top, heading, top, ...padded, top];
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
