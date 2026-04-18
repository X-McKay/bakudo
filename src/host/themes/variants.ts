/**
 * Six theme variants — truecolor light/dark, daltonized light/dark, and
 * ANSI-16-only light/dark. Each exports the same {@link Theme} shape per
 * plan `05-rich-tui-and-distribution-hardening.md` §"Theme Palette With
 * Semantic Naming" point 5.
 *
 * Invariant (enforced by tests): within a variant, `success` is a green-ish
 * tone, `error` is a red-ish tone, `warning` amber/yellow, `info` cyan/blue.
 * The daltonized variants swap green→blue on `success` / `diffAdded` to stay
 * distinguishable from `error` under deuteranopia.
 *
 * **Default dark-variant stability contract:** the `dark` variant's
 * `success` / `error` / `warning` / `info` / `dim` / `prompt` values are
 * calibrated to emit the exact SGR escape sequences that pre-theme bakudo
 * emitted (`\u001B[32m`, `\u001B[31m`, etc.). This preserves byte-for-byte
 * snapshot compatibility for transcripts captured before Phase 5 PR6. Don't
 * change these without also updating every snapshot test in lockstep.
 */
import { ANSI_BG, ANSI_DIM, ANSI_FG, rgbBg, rgbFg } from "./ansiCodes.js";
import type { Theme } from "./palette.js";

/**
 * Dark theme (default). Values chosen to emit the exact SGR codes that
 * pre-theme bakudo printed through the legacy `ANSI.cyan` / `ANSI.green` /
 * ... table in `src/host/ansi.ts`. Snapshot tests depend on this.
 */
export const darkTheme: Theme = {
  foreground: ANSI_FG.white,
  background: ANSI_BG.black,
  dim: ANSI_DIM,

  // Status tones — bakudo's legacy palette: cyan=info, green=success,
  // yellow=warning, red=error. Byte-equivalent to pre-Phase-5 output.
  success: ANSI_FG.green,
  error: ANSI_FG.red,
  warning: ANSI_FG.yellow,
  info: ANSI_FG.cyan,

  // UI roles.
  prompt: ANSI_FG.cyan,
  autoAccept: ANSI_FG.magenta,
  userMessageBackground: rgbBg(55, 55, 55),
  selectionBg: rgbBg(38, 79, 120),

  red_FOR_SUBAGENTS_ONLY: rgbFg(220, 38, 38),

  claudeShimmer: rgbFg(235, 159, 127),

  diffAdded: rgbFg(34, 92, 43),
  diffAddedDimmed: rgbFg(71, 88, 74),
  diffAddedWord: rgbFg(56, 166, 96),
  diffRemoved: rgbFg(122, 41, 54),
  diffRemovedDimmed: rgbFg(105, 72, 77),
  diffRemovedWord: rgbFg(179, 89, 107),
};

/**
 * Light theme. Darker foregrounds pair with a white-ish terminal background
 * to preserve contrast.
 */
export const lightTheme: Theme = {
  foreground: rgbFg(0, 0, 0),
  background: rgbBg(255, 255, 255),
  dim: ANSI_DIM,

  success: rgbFg(44, 122, 57),
  error: rgbFg(171, 43, 63),
  warning: rgbFg(150, 108, 30),
  info: rgbFg(87, 105, 247),

  prompt: rgbFg(87, 105, 247),
  autoAccept: rgbFg(135, 0, 255),
  userMessageBackground: rgbBg(240, 240, 240),
  selectionBg: rgbBg(180, 213, 255),

  red_FOR_SUBAGENTS_ONLY: rgbFg(220, 38, 38),

  claudeShimmer: rgbFg(245, 149, 117),

  diffAdded: rgbFg(105, 219, 124),
  diffAddedDimmed: rgbFg(199, 225, 203),
  diffAddedWord: rgbFg(47, 157, 68),
  diffRemoved: rgbFg(255, 168, 180),
  diffRemovedDimmed: rgbFg(253, 210, 216),
  diffRemovedWord: rgbFg(209, 69, 75),
};

/**
 * Dark daltonized theme. Deuteranopia-friendly: `success` and `diffAdded`
 * lean blue rather than green so they stay distinct from `error`.
 */
export const darkDaltonizedTheme: Theme = {
  foreground: rgbFg(255, 255, 255),
  background: rgbBg(0, 0, 0),
  dim: ANSI_DIM,

  success: rgbFg(51, 153, 255), // blue instead of green
  error: rgbFg(255, 102, 102),
  warning: rgbFg(255, 204, 0),
  info: rgbFg(153, 204, 255),

  prompt: rgbFg(153, 204, 255),
  autoAccept: rgbFg(175, 135, 255),
  userMessageBackground: rgbBg(55, 55, 55),
  selectionBg: rgbBg(38, 79, 120),

  red_FOR_SUBAGENTS_ONLY: rgbFg(255, 102, 102),

  claudeShimmer: rgbFg(255, 183, 101),

  diffAdded: rgbFg(0, 68, 102), // dark blue instead of green
  diffAddedDimmed: rgbFg(62, 81, 91),
  diffAddedWord: rgbFg(0, 119, 179),
  diffRemoved: rgbFg(102, 0, 0),
  diffRemovedDimmed: rgbFg(62, 44, 44),
  diffRemovedWord: rgbFg(179, 0, 0),
};

/**
 * Light daltonized theme. Same blue-for-green substitution on light bg.
 */
export const lightDaltonizedTheme: Theme = {
  foreground: rgbFg(0, 0, 0),
  background: rgbBg(255, 255, 255),
  dim: ANSI_DIM,

  success: rgbFg(0, 102, 153), // blue instead of green
  error: rgbFg(204, 0, 0),
  warning: rgbFg(255, 153, 0),
  info: rgbFg(51, 102, 255),

  prompt: rgbFg(51, 102, 255),
  autoAccept: rgbFg(135, 0, 255),
  userMessageBackground: rgbBg(220, 220, 220),
  selectionBg: rgbBg(180, 213, 255),

  red_FOR_SUBAGENTS_ONLY: rgbFg(204, 0, 0),

  claudeShimmer: rgbFg(255, 183, 101),

  diffAdded: rgbFg(153, 204, 255), // light blue instead of green
  diffAddedDimmed: rgbFg(209, 231, 253),
  diffAddedWord: rgbFg(51, 102, 204),
  diffRemoved: rgbFg(255, 204, 204),
  diffRemovedDimmed: rgbFg(255, 233, 233),
  diffRemovedWord: rgbFg(153, 51, 51),
};

/**
 * Dark ANSI theme — 16-color SGR only, for terminals that don't speak
 * 24-bit color. Also the forced variant when `NO_COLOR` / `--no-color` is
 * set (see `detectTheme`). Bright tones on a dark background.
 */
export const darkAnsiTheme: Theme = {
  foreground: ANSI_FG.brightWhite,
  background: ANSI_BG.black,
  dim: ANSI_DIM,

  success: ANSI_FG.brightGreen,
  error: ANSI_FG.brightRed,
  warning: ANSI_FG.brightYellow,
  info: ANSI_FG.brightCyan,

  prompt: ANSI_FG.brightCyan,
  autoAccept: ANSI_FG.brightMagenta,
  userMessageBackground: ANSI_BG.gray,
  selectionBg: ANSI_BG.blue,

  red_FOR_SUBAGENTS_ONLY: ANSI_FG.brightRed,

  claudeShimmer: ANSI_FG.brightYellow,

  diffAdded: ANSI_FG.green,
  diffAddedDimmed: ANSI_FG.green,
  diffAddedWord: ANSI_FG.brightGreen,
  diffRemoved: ANSI_FG.red,
  diffRemovedDimmed: ANSI_FG.red,
  diffRemovedWord: ANSI_FG.brightRed,
};

/**
 * Light ANSI theme — same 16-color constraint, darker tones for light bg.
 */
export const lightAnsiTheme: Theme = {
  foreground: ANSI_FG.black,
  background: ANSI_BG.white,
  dim: ANSI_DIM,

  success: ANSI_FG.green,
  error: ANSI_FG.red,
  warning: ANSI_FG.yellow,
  info: ANSI_FG.blue,

  prompt: ANSI_FG.blue,
  autoAccept: ANSI_FG.magenta,
  userMessageBackground: ANSI_BG.white,
  selectionBg: ANSI_BG.cyan,

  red_FOR_SUBAGENTS_ONLY: ANSI_FG.red,

  claudeShimmer: ANSI_FG.brightYellow,

  diffAdded: ANSI_FG.green,
  diffAddedDimmed: ANSI_FG.green,
  diffAddedWord: ANSI_FG.brightGreen,
  diffRemoved: ANSI_FG.red,
  diffRemovedDimmed: ANSI_FG.red,
  diffRemovedWord: ANSI_FG.brightRed,
};

import type { ThemeVariant } from "./palette.js";

/** Resolve a {@link ThemeVariant} to a concrete {@link Theme} object. */
export const getThemeForVariant = (variant: ThemeVariant): Theme => {
  switch (variant) {
    case "dark":
      return darkTheme;
    case "light":
      return lightTheme;
    case "dark-daltonized":
      return darkDaltonizedTheme;
    case "light-daltonized":
      return lightDaltonizedTheme;
    case "dark-ansi":
      return darkAnsiTheme;
    case "light-ansi":
      return lightAnsiTheme;
  }
};
