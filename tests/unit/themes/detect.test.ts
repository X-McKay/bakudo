import assert from "node:assert/strict";
import test from "node:test";

import {
  colorFgBgToTone,
  computeLuminance,
  detectTheme,
  parseOscRgb,
  resolveVariant,
} from "../../../src/host/themes/detect.js";
import {
  applyDetectedTheme,
  getActiveThemeVariant,
  resetActiveTheme,
} from "../../../src/host/themes/index.js";

test("parseOscRgb: accepts rgb:RRRR/GGGG/BBBB (4-digit hex)", () => {
  const rgb = parseOscRgb("rgb:ffff/ffff/ffff");
  assert.ok(rgb);
  assert.equal(rgb.r, 1);
  assert.equal(rgb.g, 1);
  assert.equal(rgb.b, 1);
});

test("parseOscRgb: accepts rgb:R/G/B (1-digit hex)", () => {
  const rgb = parseOscRgb("rgb:0/0/0");
  assert.ok(rgb);
  assert.equal(rgb.r, 0);
  assert.equal(rgb.g, 0);
  assert.equal(rgb.b, 0);
});

test("parseOscRgb: accepts rgba: and ignores the alpha channel", () => {
  const rgb = parseOscRgb("rgba:ffff/0000/0000/8888");
  assert.ok(rgb);
  assert.equal(rgb.r, 1);
  assert.equal(rgb.g, 0);
  assert.equal(rgb.b, 0);
});

test("parseOscRgb: returns undefined on unrecognized payload", () => {
  assert.equal(parseOscRgb("not-an-rgb-response"), undefined);
  assert.equal(parseOscRgb(""), undefined);
});

test("computeLuminance: ITU-R BT.709 coefficients", () => {
  // Pure red = 0.2126
  assert.equal(computeLuminance({ r: 1, g: 0, b: 0 }), 0.2126);
  // Pure green = 0.7152
  assert.equal(computeLuminance({ r: 0, g: 1, b: 0 }), 0.7152);
  // Pure blue = 0.0722
  assert.equal(computeLuminance({ r: 0, g: 0, b: 1 }), 0.0722);
  // White = 1.0
  assert.ok(Math.abs(computeLuminance({ r: 1, g: 1, b: 1 }) - 1) < 1e-9);
  // Black = 0
  assert.equal(computeLuminance({ r: 0, g: 0, b: 0 }), 0);
});

test("computeLuminance: midpoint split at 0.5 separates light (white) from dark (black)", () => {
  assert.ok(computeLuminance({ r: 1, g: 1, b: 1 }) > 0.5, "white is light");
  assert.ok(computeLuminance({ r: 0, g: 0, b: 0 }) < 0.5, "black is dark");
});

test("colorFgBgToTone: bg ∈ {0..6, 8} is dark", () => {
  for (const bg of [0, 1, 2, 3, 4, 5, 6, 8]) {
    assert.equal(colorFgBgToTone(`15;${bg}`), "dark", `COLORFGBG=15;${bg}`);
  }
});

test("colorFgBgToTone: bg ∈ {7, 9..15} is light", () => {
  for (const bg of [7, 9, 10, 11, 12, 13, 14, 15]) {
    assert.equal(colorFgBgToTone(`0;${bg}`), "light", `COLORFGBG=0;${bg}`);
  }
});

test("colorFgBgToTone: returns undefined for malformed / out-of-range input", () => {
  assert.equal(colorFgBgToTone(undefined), undefined);
  assert.equal(colorFgBgToTone(""), undefined);
  assert.equal(colorFgBgToTone("15"), undefined); // no bg segment
  assert.equal(colorFgBgToTone("15;abc"), undefined);
  assert.equal(colorFgBgToTone("15;99"), undefined);
  assert.equal(colorFgBgToTone("15;-1"), undefined);
});

test("colorFgBgToTone: handles the three-segment rxvt form `<fg>;<bright>;<bg>`", () => {
  assert.equal(colorFgBgToTone("15;default;0"), "dark");
  assert.equal(colorFgBgToTone("0;default;7"), "light");
});

test("resolveVariant: tone + flags compose into the six canonical variants", () => {
  assert.equal(resolveVariant({ tone: "dark", forceAnsi: false, daltonized: false }), "dark");
  assert.equal(resolveVariant({ tone: "light", forceAnsi: false, daltonized: false }), "light");
  assert.equal(
    resolveVariant({ tone: "dark", forceAnsi: false, daltonized: true }),
    "dark-daltonized",
  );
  assert.equal(
    resolveVariant({ tone: "light", forceAnsi: false, daltonized: true }),
    "light-daltonized",
  );
  assert.equal(resolveVariant({ tone: "dark", forceAnsi: true, daltonized: false }), "dark-ansi");
  assert.equal(resolveVariant({ tone: "light", forceAnsi: true, daltonized: false }), "light-ansi");
  // forceAnsi beats daltonized.
  assert.equal(resolveVariant({ tone: "dark", forceAnsi: true, daltonized: true }), "dark-ansi");
});

test("detectTheme: BAKUDO_THEME override wins over COLORFGBG", async () => {
  const variant = await detectTheme({
    env: { BAKUDO_THEME: "light-daltonized", COLORFGBG: "15;0" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(variant, "light-daltonized");
});

test("detectTheme: BAKUDO_THEME=foo (unknown) falls through to the cascade", async () => {
  const variant = await detectTheme({
    env: { BAKUDO_THEME: "not-a-variant", COLORFGBG: "15;7" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(variant, "light");
});

test("detectTheme: NO_COLOR forces the ANSI suffix even under an explicit BAKUDO_THEME", async () => {
  const variant = await detectTheme({
    env: { BAKUDO_THEME: "light", NO_COLOR: "1" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(variant, "light-ansi");
});

test("detectTheme: NO_COLOR alone (no COLORFGBG, no TTY) resolves to dark-ansi", async () => {
  const variant = await detectTheme({
    env: { NO_COLOR: "1" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(variant, "dark-ansi");
});

test("detectTheme: COLORFGBG=15;7 → light when no override", async () => {
  const variant = await detectTheme({
    env: { COLORFGBG: "15;7" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(variant, "light");
});

test("detectTheme: COLORFGBG=15;0 → dark when no override", async () => {
  const variant = await detectTheme({
    env: { COLORFGBG: "15;0" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(variant, "dark");
});

test("detectTheme: BAKUDO_DALTONIZED flag composes with COLORFGBG", async () => {
  const dark = await detectTheme({
    env: { COLORFGBG: "15;0", BAKUDO_DALTONIZED: "1" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(dark, "dark-daltonized");
  const light = await detectTheme({
    env: { COLORFGBG: "15;7", BAKUDO_DALTONIZED: "1" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(light, "light-daltonized");
});

test("detectTheme: no env signals + no TTY → falls through to dark (default)", async () => {
  const variant = await detectTheme({
    env: {},
    stdout: undefined,
    stdin: undefined,
    timeoutMs: 10,
  });
  assert.equal(variant, "dark");
});

test("detectTheme: short timeout does not hang when OSC 11 is unavailable", async () => {
  const start = Date.now();
  const variant = await detectTheme({
    env: {},
    stdout: undefined,
    stdin: undefined,
    timeoutMs: 5,
  });
  const elapsed = Date.now() - start;
  assert.equal(variant, "dark");
  // Sanity guard: we should be well under 500ms. The async branch is skipped
  // when stdout/stdin aren't TTYs, so this should return ~immediately.
  assert.ok(elapsed < 500, `detectTheme took ${elapsed}ms — async fallback should be immediate`);
});

test("applyDetectedTheme: installs the detected variant and returns it", async () => {
  resetActiveTheme();
  const variant = await applyDetectedTheme({
    env: { BAKUDO_THEME: "light-daltonized" },
    stdout: undefined,
    stdin: undefined,
  });
  assert.equal(variant, "light-daltonized");
  assert.equal(getActiveThemeVariant(), "light-daltonized");
  resetActiveTheme();
});
