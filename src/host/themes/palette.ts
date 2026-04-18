/**
 * Theme palette with semantic naming.
 *
 * Adapted from Claude Code's canonical `Theme` object (reference:
 * `refs/claude-code-sample/src/utils/theme.ts:1-100`) and the Phase 5 plan
 * `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md`
 * §"Theme Palette With Semantic Naming" (lines 504-515).
 *
 * Design principles:
 *
 * 1. **Semantic keys** (`success`, `error`, `warning`, `autoAccept`, …) so
 *    callers reason in roles, not in color names. Swapping themes does not
 *    require a renderer diff.
 * 2. **Namespaced colors** (`red_FOR_SUBAGENTS_ONLY`) enforce usage via lint,
 *    not convention.
 * 3. **Animation-ready variants** (`claudeShimmer`) encode the lighter pair of
 *    the primary color used for shimmer animations on the active prompt. Name
 *    borrowed verbatim from the reference Claude Code theme.
 * 4. **Diff-specific variants** — distinct `diffAdded` / `diffAddedDimmed` /
 *    `diffAddedWord` for cell-level vs word-level highlighting, mirrored on
 *    the remove side.
 *
 * ## Value encoding
 *
 * Each field is a raw ANSI escape sequence (SGR parameter) — for example
 * `"\u001B[36m"` (cyan) or `"\u001B[38;2;78;186;101m"` (24-bit bright green).
 * The renderer wraps text as `${theme.value}<text>\u001B[0m` via
 * {@link paint}. Keeping the raw escape in the palette (as opposed to an
 * abstract color name) means the ANSI-only variants can emit 16-color SGR
 * codes while the truecolor variants emit 24-bit RGB, all through the same
 * application pipeline.
 */
export type Theme = {
  // General
  foreground: string;
  background: string;
  dim: string;

  // Status tones
  success: string;
  error: string;
  warning: string;
  info: string;

  // UI roles
  prompt: string;
  autoAccept: string;
  userMessageBackground: string;
  selectionBg: string;

  // Namespaced (lint-visible usage restrictions)
  red_FOR_SUBAGENTS_ONLY: string;

  // Animation variants
  claudeShimmer: string;

  // Diff-specific
  diffAdded: string;
  diffAddedDimmed: string;
  diffAddedWord: string;
  diffRemoved: string;
  diffRemovedDimmed: string;
  diffRemovedWord: string;
};

/**
 * The six canonical theme variants per plan §"Theme Palette With Semantic
 * Naming" point 5 (light/dark × {default, daltonized, ANSI-16-only}).
 *
 * - `dark` / `light` — truecolor, curated palette.
 * - `*-daltonized` — deuteranopia-friendly palette (swaps red/green-sensitive
 *   distinctions for blue/orange).
 * - `*-ansi` — 16-color SGR only, for legacy terminals without 256-color
 *   support. Also used as the forced variant when `NO_COLOR` / `--no-color`
 *   is present (see `detectTheme`).
 */
export type ThemeVariant =
  | "dark"
  | "light"
  | "dark-daltonized"
  | "light-daltonized"
  | "dark-ansi"
  | "light-ansi";

export const THEME_VARIANTS: readonly ThemeVariant[] = [
  "dark",
  "light",
  "dark-daltonized",
  "light-daltonized",
  "dark-ansi",
  "light-ansi",
] as const;

export const isThemeVariant = (value: unknown): value is ThemeVariant =>
  typeof value === "string" && (THEME_VARIANTS as readonly string[]).includes(value);
