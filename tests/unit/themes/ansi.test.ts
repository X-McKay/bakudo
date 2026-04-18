import assert from "node:assert/strict";
import test from "node:test";

import { ANSI, cyan, green, paint, red, stripAnsi, tone, yellow } from "../../../src/host/ansi.js";
import {
  darkTheme,
  getActiveTheme,
  getActiveThemeVariant,
  getThemeForVariant,
  lightTheme,
  resetActiveTheme,
  setActiveTheme,
} from "../../../src/host/themes/index.js";

/**
 * The host runs tests under `node --test`, not a TTY — so `supportsAnsi()`
 * returns `false` by default and `paint()` emits the raw text with no SGR
 * envelope. These tests patch `process.stdout.isTTY = true` (with restore
 * in teardown) so they can assert on actual escape bytes.
 */
const withTty = <T>(fn: () => T): T => {
  const stdoutAny = process.stdout as unknown as { isTTY?: boolean };
  const originalIsTty = stdoutAny.isTTY;
  const originalNoColor = process.env["NO_COLOR"];
  stdoutAny.isTTY = true;
  delete process.env["NO_COLOR"];
  try {
    return fn();
  } finally {
    if (originalIsTty === undefined) {
      delete stdoutAny.isTTY;
    } else {
      stdoutAny.isTTY = originalIsTty;
    }
    if (originalNoColor !== undefined) {
      process.env["NO_COLOR"] = originalNoColor;
    }
  }
};

test("tone.info reads from the active theme", () => {
  withTty(() => {
    const restore = setActiveTheme("dark");
    try {
      const painted = tone.info("hello");
      assert.equal(painted, `${darkTheme.info}hello${ANSI.reset}`);
    } finally {
      restore();
    }
  });
});

test("tone.success reads from the active theme and reflects setActiveTheme swaps", () => {
  withTty(() => {
    const restore = setActiveTheme("dark");
    try {
      const darkOut = tone.success("x");
      assert.equal(darkOut, `${darkTheme.success}x${ANSI.reset}`);

      setActiveTheme("light");
      const lightOut = tone.success("x");
      assert.equal(lightOut, `${lightTheme.success}x${ANSI.reset}`);
      assert.notEqual(darkOut, lightOut, "light and dark success tones must differ");
    } finally {
      restore();
      // setActiveTheme above shifted us to light; restore only rewinds one
      // step. Explicitly reset so downstream tests see the default.
      resetActiveTheme();
    }
  });
});

test("tone.error + tone.warning produce distinct SGR sequences in dark theme", () => {
  withTty(() => {
    const restore = setActiveTheme("dark");
    try {
      assert.notEqual(tone.error("x"), tone.warning("x"));
      assert.equal(tone.error("x"), `${darkTheme.error}x${ANSI.reset}`);
      assert.equal(tone.warning("x"), `${darkTheme.warning}x${ANSI.reset}`);
    } finally {
      restore();
    }
  });
});

test("paint returns text unchanged when the terminal does not support ANSI", () => {
  // No withTty: isTTY is undefined / false under node --test.
  const stdoutAny = process.stdout as unknown as { isTTY?: boolean };
  const originalIsTty = stdoutAny.isTTY;
  stdoutAny.isTTY = false;
  try {
    assert.equal(paint("hello", ANSI.bold), "hello");
    assert.equal(tone.info("hello"), "hello");
  } finally {
    if (originalIsTty === undefined) {
      delete stdoutAny.isTTY;
    } else {
      stdoutAny.isTTY = originalIsTty;
    }
  }
});

test("setActiveTheme returns a restore function that rewinds to the previous variant", () => {
  const originalVariant = getActiveThemeVariant();
  const restoreOne = setActiveTheme("light");
  assert.equal(getActiveThemeVariant(), "light");
  const restoreTwo = setActiveTheme("dark-daltonized");
  assert.equal(getActiveThemeVariant(), "dark-daltonized");
  restoreTwo();
  assert.equal(getActiveThemeVariant(), "light");
  restoreOne();
  assert.equal(getActiveThemeVariant(), originalVariant);
});

test("resetActiveTheme returns the default (dark) variant", () => {
  setActiveTheme("light-ansi");
  assert.equal(getActiveThemeVariant(), "light-ansi");
  resetActiveTheme();
  assert.equal(getActiveThemeVariant(), "dark");
  assert.equal(getActiveTheme(), getThemeForVariant("dark"));
});

test("default active theme is dark (matches pre-Phase-5 bakudo byte-for-byte)", () => {
  // No setActiveTheme call — the singleton default must be dark so existing
  // snapshot tests keep passing without modification.
  resetActiveTheme();
  assert.equal(getActiveThemeVariant(), "dark");
  assert.equal(getActiveTheme(), darkTheme);
});

test("legacy green()/red()/yellow()/cyan() wrappers flow through the active theme", () => {
  withTty(() => {
    const restore = setActiveTheme("dark");
    try {
      assert.equal(green("x"), `${darkTheme.success}x${ANSI.reset}`);
      assert.equal(red("x"), `${darkTheme.error}x${ANSI.reset}`);
      assert.equal(yellow("x"), `${darkTheme.warning}x${ANSI.reset}`);
      assert.equal(cyan("x"), `${darkTheme.info}x${ANSI.reset}`);
    } finally {
      restore();
    }
  });
});

test("stripAnsi still removes SGR escapes after the rewrite", () => {
  withTty(() => {
    const text = tone.info("hello");
    assert.ok(text.includes("\u001B["), "expected SGR in painted output");
    assert.equal(stripAnsi(text), "hello");
  });
});
