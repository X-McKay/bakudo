/**
 * Active-theme singleton. The rest of the host reads colors via
 * `getActiveTheme()` from this module (directly or via the `tone.*` helpers
 * in `host/ansi.ts`).
 *
 * The default is `dark`, matching legacy pre-Phase-5 bakudo output
 * byte-for-byte (see `variants.ts` — the `darkTheme` values are calibrated
 * to that invariant).
 *
 * Tests override via {@link setActiveTheme}; use the returned restore
 * function (or `resetActiveTheme`) to clean up afterwards. Don't leak theme
 * state between test cases.
 */
import { detectTheme, type DetectThemeOptions } from "./detect.js";
import type { Theme, ThemeVariant } from "./palette.js";
import { getThemeForVariant } from "./variants.js";

const DEFAULT_VARIANT: ThemeVariant = "dark";

let activeVariant: ThemeVariant = DEFAULT_VARIANT;
let activeTheme: Theme = getThemeForVariant(DEFAULT_VARIANT);

export const getActiveTheme = (): Theme => activeTheme;

export const getActiveThemeVariant = (): ThemeVariant => activeVariant;

/**
 * Replace the active theme variant. Returns a `restore` function that flips
 * back to whatever was active before the call — handy in tests.
 */
export const setActiveTheme = (variant: ThemeVariant): (() => void) => {
  const previousVariant = activeVariant;
  activeVariant = variant;
  activeTheme = getThemeForVariant(variant);
  return () => {
    activeVariant = previousVariant;
    activeTheme = getThemeForVariant(previousVariant);
  };
};

/** Reset the active theme to the default (`dark`). Intended for test teardown. */
export const resetActiveTheme = (): void => {
  activeVariant = DEFAULT_VARIANT;
  activeTheme = getThemeForVariant(DEFAULT_VARIANT);
};

/**
 * Convenience: detect the appropriate theme variant and install it in the
 * active-theme singleton. Returns the variant that was installed so callers
 * can log it. Use at CLI startup to honour `BAKUDO_THEME` / `COLORFGBG` /
 * `NO_COLOR` without threading options through every call site.
 */
export const applyDetectedTheme = async (options?: DetectThemeOptions): Promise<ThemeVariant> => {
  const variant = await detectTheme(options);
  setActiveTheme(variant);
  return variant;
};

export type { Theme, ThemeVariant } from "./palette.js";
export { THEME_VARIANTS, isThemeVariant } from "./palette.js";
export {
  darkAnsiTheme,
  darkDaltonizedTheme,
  darkTheme,
  getThemeForVariant,
  lightAnsiTheme,
  lightDaltonizedTheme,
  lightTheme,
} from "./variants.js";
export { detectTheme } from "./detect.js";
export type { DetectThemeOptions } from "./detect.js";
