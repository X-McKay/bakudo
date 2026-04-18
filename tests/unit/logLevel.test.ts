/**
 * Wave 6c PR7 / A6.7 — persistent log-level resolver.
 *
 * Covers plan lines 938-949:
 *
 *   - Config key `log_level` / schema field `logLevel` with seven values.
 *   - Precedence: CLI > env > config > TTY-aware default.
 *   - `default` collapses to `warning` in TTY, `info` otherwise.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractLogLevelCliFlag,
  LOG_LEVELS,
  parseLogLevel,
  resolveLogLevel,
  shouldLog,
} from "../../src/host/telemetry/logLevel.js";

test("LOG_LEVELS lists the plan-stated seven values", () => {
  assert.deepEqual(
    [...LOG_LEVELS],
    ["none", "error", "warning", "info", "debug", "all", "default"],
  );
});

test("parseLogLevel accepts valid values case-insensitively", () => {
  for (const v of ["none", "error", "WARNING", "Info", "debug", "all", "default"]) {
    assert.notEqual(parseLogLevel(v), undefined);
  }
});

test("parseLogLevel rejects unknown strings", () => {
  assert.equal(parseLogLevel("trace"), undefined);
  assert.equal(parseLogLevel(""), undefined);
  assert.equal(parseLogLevel(undefined), undefined);
});

test("resolveLogLevel: CLI flag wins over env and config", () => {
  const level = resolveLogLevel({
    cliFlag: "debug",
    env: "error",
    config: "info",
    isTty: true,
  });
  assert.equal(level, "debug");
});

test("resolveLogLevel: env wins over config when no CLI flag", () => {
  const level = resolveLogLevel({ env: "error", config: "info" });
  assert.equal(level, "error");
});

test("resolveLogLevel: config used when env/CLI absent", () => {
  const level = resolveLogLevel({ config: "warning" });
  assert.equal(level, "warning");
});

test("resolveLogLevel: default→warning in TTY, default→info otherwise", () => {
  assert.equal(resolveLogLevel({ isTty: true }), "warning");
  assert.equal(resolveLogLevel({ isTty: false }), "info");
  assert.equal(resolveLogLevel({}), "info");
});

test("resolveLogLevel: explicit 'default' from config also collapses via TTY heuristic", () => {
  assert.equal(resolveLogLevel({ config: "default", isTty: true }), "warning");
  assert.equal(resolveLogLevel({ config: "default", isTty: false }), "info");
});

test("resolveLogLevel: explicit 'default' from env also collapses via TTY heuristic", () => {
  assert.equal(resolveLogLevel({ env: "default", isTty: true }), "warning");
  assert.equal(resolveLogLevel({ env: "default" }), "info");
});

test("extractLogLevelCliFlag: --log-level=debug form", () => {
  assert.equal(extractLogLevelCliFlag(["bakudo", "--log-level=debug", "doctor"]), "debug");
});

test("extractLogLevelCliFlag: two-arg form", () => {
  assert.equal(extractLogLevelCliFlag(["--log-level", "warning", "doctor"]), "warning");
});

test("extractLogLevelCliFlag: absent flag", () => {
  assert.equal(extractLogLevelCliFlag(["doctor"]), undefined);
});

test("shouldLog: `info` threshold passes info and below", () => {
  assert.equal(shouldLog("info", "error"), true);
  assert.equal(shouldLog("info", "warning"), true);
  assert.equal(shouldLog("info", "info"), true);
  assert.equal(shouldLog("info", "debug"), false);
  assert.equal(shouldLog("info", "all"), false);
});

test("shouldLog: `none` threshold suppresses everything", () => {
  assert.equal(shouldLog("none", "error"), false);
  assert.equal(shouldLog("none", "info"), false);
  assert.equal(shouldLog("none", "all"), false);
});

test("shouldLog: `all` threshold passes everything", () => {
  for (const candidate of ["none", "error", "warning", "info", "debug", "all"] as const) {
    assert.equal(shouldLog("all", candidate), true, candidate);
  }
});
