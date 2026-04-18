/**
 * Phase 6 W5 — tests for the env-passthrough policy.
 *
 * Covers plan 06 §W5 recommended default rule 3 ("require explicit opt-in
 * for passing nonstandard env vars to workers") and the acceptance criterion
 * 388 ("obvious secret leaks are prevented by default").
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENV_POLICY,
  filterEnv,
  parseEnvAllowlistOverride,
  resolveEnvPolicy,
  validateEnvAllowlist,
} from "../../src/host/envPolicy.js";

// ---------------------------------------------------------------------------
// filterEnv — default policy
// ---------------------------------------------------------------------------

test("filterEnv returns an empty map under the default policy", () => {
  const out = filterEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/user",
      GITHUB_TOKEN: "ghp_xxx",
      SESSION_ID: "sess-42",
    },
    DEFAULT_ENV_POLICY,
  );
  assert.deepEqual(out, {});
});

test("filterEnv passes through allowlisted vars", () => {
  const out = filterEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/user",
      MY_VAR: "ok",
      OTHER: "ignored",
    },
    { allowlist: ["PATH", "MY_VAR"], redactionPolicy: DEFAULT_ENV_POLICY.redactionPolicy },
  );
  assert.deepEqual(out, { PATH: "/usr/bin", MY_VAR: "ok" });
});

test("filterEnv drops allowlisted vars whose NAME still matches a deny pattern", () => {
  // Even if a user allowlists GITHUB_TOKEN, the deny-pattern guard wins so
  // secrets cannot leak by accident (plan hard rule: defense in depth).
  const out = filterEnv(
    { GITHUB_TOKEN: "ghp_x", PATH: "/usr/bin" },
    {
      allowlist: ["GITHUB_TOKEN", "PATH"],
      redactionPolicy: DEFAULT_ENV_POLICY.redactionPolicy,
    },
  );
  assert.deepEqual(out, { PATH: "/usr/bin" });
});

test("filterEnv drops undefined values", () => {
  const out = filterEnv(
    { MY_VAR: undefined, OTHER: "v" },
    { allowlist: ["MY_VAR", "OTHER"], redactionPolicy: DEFAULT_ENV_POLICY.redactionPolicy },
  );
  assert.deepEqual(out, { OTHER: "v" });
});

// ---------------------------------------------------------------------------
// validateEnvAllowlist
// ---------------------------------------------------------------------------

test("validateEnvAllowlist accepts POSIX-shaped names", () => {
  const r = validateEnvAllowlist(["FOO", "BAR_BAZ", "_QUX", "A1"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.names, ["FOO", "BAR_BAZ", "_QUX", "A1"]);
  assert.deepEqual(r.rejected, []);
});

test("validateEnvAllowlist rejects malformed names", () => {
  const r = validateEnvAllowlist(["FOO BAR", "1BAD", "X=Y", "", "OK"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.names, ["OK"]);
  assert.equal(r.rejected.length, 4);
});

// ---------------------------------------------------------------------------
// parseEnvAllowlistOverride
// ---------------------------------------------------------------------------

test("parseEnvAllowlistOverride splits on commas and validates", () => {
  assert.deepEqual(parseEnvAllowlistOverride("FOO,BAR ,  BAZ"), ["FOO", "BAR", "BAZ"]);
});

test("parseEnvAllowlistOverride returns [] on undefined / empty", () => {
  assert.deepEqual(parseEnvAllowlistOverride(undefined), []);
  assert.deepEqual(parseEnvAllowlistOverride(""), []);
  assert.deepEqual(parseEnvAllowlistOverride("   "), []);
});

test("parseEnvAllowlistOverride drops malformed entries silently", () => {
  assert.deepEqual(parseEnvAllowlistOverride("FOO,1BAD,BAR"), ["FOO", "BAR"]);
});

// ---------------------------------------------------------------------------
// resolveEnvPolicy — merges config + override
// ---------------------------------------------------------------------------

test("resolveEnvPolicy merges config allowlist with BAKUDO_ENV_ALLOWLIST override", () => {
  const policy = resolveEnvPolicy({
    configAllowlist: ["FOO"],
    overrideRaw: "BAR,BAZ",
  });
  assert.deepEqual([...policy.allowlist].sort(), ["BAR", "BAZ", "FOO"]);
});

test("resolveEnvPolicy falls back to default redaction policy", () => {
  const policy = resolveEnvPolicy({ configAllowlist: ["FOO"] });
  // same reference as default -> same deny patterns
  assert.equal(policy.redactionPolicy, DEFAULT_ENV_POLICY.redactionPolicy);
});

test("resolveEnvPolicy with nothing set yields an empty allowlist", () => {
  const policy = resolveEnvPolicy({});
  assert.deepEqual(policy.allowlist, []);
});

// ---------------------------------------------------------------------------
// Opt-in allowlist integration — the plan scenario
// ---------------------------------------------------------------------------

test("opt-in: user config envPolicy.allowlist = ['MY_VAR'] passes MY_VAR through, filters others", () => {
  const policy = resolveEnvPolicy({ configAllowlist: ["MY_VAR"] });
  const out = filterEnv(
    {
      MY_VAR: "hello",
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_x",
      SESSION: "s",
    },
    policy,
  );
  assert.deepEqual(out, { MY_VAR: "hello" });
});
