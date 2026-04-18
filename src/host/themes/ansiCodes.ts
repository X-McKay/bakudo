/**
 * Centralized SGR escape-sequence builders used by the theme variants.
 *
 * Exported so tests (and future theme authors) can compose values without
 * hand-rolling escape sequences. The variant files stay flat-readable: each
 * field is one call like `sgr("36")` or `rgbFg(78, 186, 101)`.
 */

const ESC = "\u001B";

/** Raw SGR with the given numeric parameter string, e.g. `"36"`, `"1;36"`. */
export const sgr = (params: string): string => `${ESC}[${params}m`;

/** 24-bit truecolor foreground: `\u001B[38;2;r;g;bm`. */
export const rgbFg = (r: number, g: number, b: number): string => sgr(`38;2;${r};${g};${b}`);

/** 24-bit truecolor background: `\u001B[48;2;r;g;bm`. */
export const rgbBg = (r: number, g: number, b: number): string => sgr(`48;2;${r};${g};${b}`);

// Standard 16-color foreground SGR codes (kept as bare constants so the
// ANSI-only variants compile into legible tables).
export const ANSI_FG = {
  black: sgr("30"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  white: sgr("37"),
  gray: sgr("90"),
  brightRed: sgr("91"),
  brightGreen: sgr("92"),
  brightYellow: sgr("93"),
  brightBlue: sgr("94"),
  brightMagenta: sgr("95"),
  brightCyan: sgr("96"),
  brightWhite: sgr("97"),
} as const;

// Backgrounds cap at 48 (40-47 normal, 100-107 bright).
export const ANSI_BG = {
  black: sgr("40"),
  white: sgr("47"),
  gray: sgr("100"),
  blue: sgr("44"),
  brightBlue: sgr("104"),
  cyan: sgr("46"),
  brightCyan: sgr("106"),
} as const;

export const ANSI_DIM = sgr("2");
export const ANSI_RESET = sgr("0");
export const ANSI_BOLD = sgr("1");
