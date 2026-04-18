import assert from "node:assert/strict";
import test from "node:test";

import {
  darkAnsiTheme,
  darkDaltonizedTheme,
  darkTheme,
  getThemeForVariant,
  lightAnsiTheme,
  lightDaltonizedTheme,
  lightTheme,
  THEME_VARIANTS,
  type Theme,
  type ThemeVariant,
} from "../../../src/host/themes/index.js";

/**
 * Structural test: every variant must populate the full {@link Theme} shape.
 * The type checker already enforces this at build time; the runtime test
 * guards against deletions / renames that re-declare the field as optional
 * or elide it in a future refactor.
 */
const REQUIRED_FIELDS: readonly (keyof Theme)[] = [
  "foreground",
  "background",
  "dim",
  "success",
  "error",
  "warning",
  "info",
  "prompt",
  "autoAccept",
  "userMessageBackground",
  "selectionBg",
  "red_FOR_SUBAGENTS_ONLY",
  "claudeShimmer",
  "diffAdded",
  "diffAddedDimmed",
  "diffAddedWord",
  "diffRemoved",
  "diffRemovedDimmed",
  "diffRemovedWord",
];

const ALL_VARIANTS: ReadonlyArray<readonly [ThemeVariant, Theme]> = [
  ["dark", darkTheme],
  ["light", lightTheme],
  ["dark-daltonized", darkDaltonizedTheme],
  ["light-daltonized", lightDaltonizedTheme],
  ["dark-ansi", darkAnsiTheme],
  ["light-ansi", lightAnsiTheme],
];

for (const [name, theme] of ALL_VARIANTS) {
  test(`palette: ${name} variant exposes every Theme field as a non-empty string`, () => {
    for (const field of REQUIRED_FIELDS) {
      const value = theme[field];
      assert.equal(typeof value, "string", `${name}.${field} must be a string`);
      assert.ok(value.length > 0, `${name}.${field} must be non-empty`);
    }
  });
}

test("palette: THEME_VARIANTS lists all six canonical variants", () => {
  const sorted = [...THEME_VARIANTS].sort();
  assert.deepEqual(sorted, [
    "dark",
    "dark-ansi",
    "dark-daltonized",
    "light",
    "light-ansi",
    "light-daltonized",
  ]);
});

test("palette: getThemeForVariant returns the variant-specific object (identity)", () => {
  assert.equal(getThemeForVariant("dark"), darkTheme);
  assert.equal(getThemeForVariant("light"), lightTheme);
  assert.equal(getThemeForVariant("dark-daltonized"), darkDaltonizedTheme);
  assert.equal(getThemeForVariant("light-daltonized"), lightDaltonizedTheme);
  assert.equal(getThemeForVariant("dark-ansi"), darkAnsiTheme);
  assert.equal(getThemeForVariant("light-ansi"), lightAnsiTheme);
});

test("palette: dark theme emits legacy SGR codes (byte-equality with pre-Phase-5)", () => {
  // Snapshot-stability contract. See `variants.ts` header for the rationale.
  assert.equal(darkTheme.info, "\u001B[36m");
  assert.equal(darkTheme.success, "\u001B[32m");
  assert.equal(darkTheme.warning, "\u001B[33m");
  assert.equal(darkTheme.error, "\u001B[31m");
  assert.equal(darkTheme.dim, "\u001B[2m");
});

test("palette: ANSI variants only use standard 16-color SGR codes (30-37, 40-47, 90-97, 100-107)", () => {
  // Regex: SGR parameter string with 2- or 3-digit values that matches
  // either a bare number or `N` preceded by the dim marker `2`. Truecolor
  // uses `38;2;…` / `48;2;…` which would fail this check — so ANSI variants
  // ducking into truecolor by mistake blows up here.
  const ansiOnly = /^\u001B\[(?:[0-9]|1|2|3[0-7]|4[0-7]|9[0-7]|10[0-7]);?\d*m$/;
  for (const [name, theme] of [
    ["dark-ansi", darkAnsiTheme],
    ["light-ansi", lightAnsiTheme],
  ] as const) {
    for (const field of REQUIRED_FIELDS) {
      const value = theme[field];
      assert.ok(
        ansiOnly.test(value),
        `${name}.${field} = ${JSON.stringify(value)} must be a 16-color SGR`,
      );
    }
  }
});

test("palette: subagent-namespaced field is distinct from success/error across all variants", () => {
  // Basic sanity: `red_FOR_SUBAGENTS_ONLY` cannot collide with `success`
  // (that would let callers trivially substitute one for the other).
  for (const [name, theme] of ALL_VARIANTS) {
    assert.notEqual(
      theme.red_FOR_SUBAGENTS_ONLY,
      theme.success,
      `${name}: red_FOR_SUBAGENTS_ONLY must not equal success`,
    );
  }
});
