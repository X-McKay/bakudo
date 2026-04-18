import assert from "node:assert/strict";
import test from "node:test";

import {
  BakudoConfigDefaults,
  BakudoConfigSchema,
  validateConfigLayer,
} from "../../src/host/config.js";

test("BakudoConfigSchema: valid config parses correctly", () => {
  const raw = {
    mode: "plan",
    autoApprove: true,
    logLevel: "debug",
    experimental: true,
    flushIntervalMs: 200,
    flushSizeThreshold: 8192,
    retryDelays: [100, 200],
  };
  const result = BakudoConfigSchema.safeParse(raw);
  assert.equal(result.success, true);
  assert.ok(result.success);
  assert.deepEqual(result.data, raw);
});

test("BakudoConfigSchema: unknown keys are silently stripped", () => {
  const raw = { mode: "standard", futureKey: "hello", nested: { a: 1 } };
  const result = BakudoConfigSchema.safeParse(raw);
  assert.equal(result.success, true);
  assert.ok(result.success);
  assert.deepEqual(result.data, { mode: "standard" });
  assert.equal((result.data as Record<string, unknown>).futureKey, undefined);
});

test("BakudoConfigSchema: empty object is valid (all fields optional)", () => {
  const result = BakudoConfigSchema.safeParse({});
  assert.equal(result.success, true);
  assert.ok(result.success);
  assert.deepEqual(result.data, {});
});

test("BakudoConfigSchema: mode must be a valid ComposerMode", () => {
  const result = BakudoConfigSchema.safeParse({ mode: "invalid_mode" });
  assert.equal(result.success, false);
});

test("BakudoConfigSchema: logLevel must be one of the allowed values", () => {
  const result = BakudoConfigSchema.safeParse({ logLevel: "trace" });
  assert.equal(result.success, false);
});

test("BakudoConfigSchema: retryDelays must be a number array", () => {
  const resultBad = BakudoConfigSchema.safeParse({ retryDelays: "not-an-array" });
  assert.equal(resultBad.success, false);
  const resultBadItems = BakudoConfigSchema.safeParse({ retryDelays: ["a", "b"] });
  assert.equal(resultBadItems.success, false);
  const resultGood = BakudoConfigSchema.safeParse({ retryDelays: [10, 20, 30] });
  assert.equal(resultGood.success, true);
});

test("BakudoConfigSchema: autoApprove must be boolean", () => {
  const result = BakudoConfigSchema.safeParse({ autoApprove: "yes" });
  assert.equal(result.success, false);
});

test("BakudoConfigDefaults: all fields are present and correct", () => {
  assert.equal(BakudoConfigDefaults.mode, "standard");
  assert.equal(BakudoConfigDefaults.autoApprove, false);
  assert.equal(BakudoConfigDefaults.logLevel, "default");
  assert.equal(BakudoConfigDefaults.experimental, false);
  assert.equal(BakudoConfigDefaults.flushIntervalMs, 100);
  assert.equal(BakudoConfigDefaults.flushSizeThreshold, 4096);
  assert.deepEqual(BakudoConfigDefaults.retryDelays, [50, 100, 200, 400, 800]);
});

test("validateConfigLayer: returns parsed config on valid input", () => {
  const raw = { mode: "autopilot", logLevel: "error" };
  const result = validateConfigLayer(raw, "test");
  assert.ok(result);
  assert.equal(result.mode, "autopilot");
  assert.equal(result.logLevel, "error");
});

test("validateConfigLayer: returns null and warns on invalid input", () => {
  const stderrLines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = validateConfigLayer({ mode: 42 }, "bad-layer");
    assert.equal(result, null);
    assert.ok(stderrLines.some((line) => line.includes("[bakudo.config]")));
    assert.ok(stderrLines.some((line) => line.includes("bad-layer")));
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("validateConfigLayer: strips unknown keys from valid input", () => {
  const raw = { mode: "plan", unknownField: true };
  const result = validateConfigLayer(raw, "test");
  assert.ok(result);
  assert.equal(result.mode, "plan");
  assert.equal((result as Record<string, unknown>).unknownField, undefined);
});

// ---------------------------------------------------------------------------
// Wave 6c PR7 review-fix B2 — `log_level` (snake_case) is the canonical
// user-facing key per plan 06 line 944; `logLevel` (camelCase) is tolerated
// as a backwards-compat alias. Precedence when both are present in the same
// layer: `log_level` wins (documented form > alias).
// ---------------------------------------------------------------------------

test("BakudoConfigSchema: accepts plan-documented `log_level` snake_case key", () => {
  const raw = { log_level: "debug" };
  const result = BakudoConfigSchema.safeParse(raw);
  assert.equal(result.success, true);
  assert.ok(result.success);
  assert.equal(result.data.logLevel, "debug");
  // Snake-case key is normalized away from the parsed view.
  assert.equal((result.data as Record<string, unknown>).log_level, undefined);
});

test("BakudoConfigSchema: accepts legacy `logLevel` camelCase alias for forward compat", () => {
  const raw = { logLevel: "debug" };
  const result = BakudoConfigSchema.safeParse(raw);
  assert.equal(result.success, true);
  assert.ok(result.success);
  assert.equal(result.data.logLevel, "debug");
});

test("BakudoConfigSchema: `log_level` takes precedence over `logLevel` when both set", () => {
  const raw = { log_level: "info", logLevel: "debug" };
  const result = BakudoConfigSchema.safeParse(raw);
  assert.equal(result.success, true);
  assert.ok(result.success);
  // Documented form wins — `logLevel` alias is overridden.
  assert.equal(result.data.logLevel, "info");
});

test("BakudoConfigSchema: invalid `log_level` value is rejected (same enum as `logLevel`)", () => {
  const result = BakudoConfigSchema.safeParse({ log_level: "trace" });
  assert.equal(result.success, false);
});

test('validateConfigLayer: plan-literal `{"log_level": "debug"}` resolves to logLevel=debug', () => {
  const resolved = validateConfigLayer({ log_level: "debug" }, "user-plan-literal");
  assert.ok(resolved);
  assert.equal(resolved.logLevel, "debug");
});
