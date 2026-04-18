/**
 * Phase 6 W5 — tests for the redaction primitives.
 *
 * Covers plan 06 §W5:
 *   - Hard rule 382 (redaction before persistence) — exercised via
 *     `redactRecord` round-trip.
 *   - Hard rule 383 (inspect safety) — exercised via `redactText`.
 *   - Recommended default rule 2 (redact secret-like env vars).
 *   - Recommended default rule 4 (never embed full secret-bearing stdout).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REDACTION_POLICY,
  REDACTION_MARKER,
  isDenyListedEnvName,
  redactRecord,
  redactText,
  summarizeRedactionPolicy,
  type RedactionPolicy,
} from "../../src/host/redaction.js";

// ---------------------------------------------------------------------------
// redactText — default-policy patterns
// ---------------------------------------------------------------------------

test("redactText replaces GitHub personal access tokens", () => {
  const raw = "token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rest";
  const out = redactText(raw, DEFAULT_REDACTION_POLICY);
  assert.ok(!out.includes("ghp_aaaa"));
  assert.ok(out.includes(REDACTION_MARKER));
  assert.ok(out.startsWith("token is "));
  assert.ok(out.endsWith(" rest"));
});

test("redactText replaces sk- API keys", () => {
  const raw = "key=sk-abcdefghijklmnopqrstuvwxyz012345 end";
  const out = redactText(raw, DEFAULT_REDACTION_POLICY);
  assert.ok(!out.includes("sk-abcdef"));
  assert.ok(out.includes(REDACTION_MARKER));
});

test("redactText replaces AWS access key IDs", () => {
  const raw = "aws: AKIAIOSFODNN7EXAMPLE end";
  const out = redactText(raw, DEFAULT_REDACTION_POLICY);
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(out.includes(REDACTION_MARKER));
});

test("redactText replaces Bearer / Basic auth headers", () => {
  const raw = "Authorization: Bearer abcdef1234567890ABCDEF12345678";
  const out = redactText(raw, DEFAULT_REDACTION_POLICY);
  assert.ok(!out.includes("abcdef1234567890"));
  assert.ok(out.includes(REDACTION_MARKER));
});

test("redactText leaves non-secret text untouched", () => {
  const raw = "/tmp/repo ran `git status --short` and reported 3 files changed";
  const out = redactText(raw, DEFAULT_REDACTION_POLICY);
  assert.equal(out, raw);
});

test("redactText is safe on empty / undefined-ish input", () => {
  assert.equal(redactText("", DEFAULT_REDACTION_POLICY), "");
});

// ---------------------------------------------------------------------------
// redactRecord — recursive object redaction (hard rule 382)
// ---------------------------------------------------------------------------

test("redactRecord scrubs secret-looking strings in nested objects", () => {
  const record = {
    artifactId: "a-1",
    name: "log.txt",
    metadata: {
      command: "curl -H 'Authorization: Bearer sk-1234567890abcdefghij1234567890'",
      tags: ["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ok"],
    },
  };
  const out = redactRecord(record, DEFAULT_REDACTION_POLICY);
  const json = JSON.stringify(out);
  assert.ok(!json.includes("sk-12345"));
  assert.ok(!json.includes("ghp_aaaa"));
  assert.ok(json.includes(REDACTION_MARKER));
  // The original is not mutated.
  assert.ok(record.metadata.command.includes("sk-12345"));
});

test("redactRecord blanks the VALUE side of deny-listed key names", () => {
  const record = {
    name: "ok",
    metadata: {
      GITHUB_TOKEN: "ghp_raw_secret_value_abcdef012345",
      AWS_SESSION_TOKEN: { anything: "even nested" },
      normal: "keep me",
    },
  };
  const out = redactRecord(record, DEFAULT_REDACTION_POLICY) as unknown as {
    metadata: Record<string, unknown>;
  };
  assert.equal(out.metadata.GITHUB_TOKEN, REDACTION_MARKER);
  assert.equal(out.metadata.AWS_SESSION_TOKEN, REDACTION_MARKER);
  assert.equal(out.metadata.normal, "keep me");
});

test("redactRecord returns null / undefined / primitives unchanged", () => {
  assert.equal(redactRecord(null, DEFAULT_REDACTION_POLICY), null);
  assert.equal(redactRecord(undefined, DEFAULT_REDACTION_POLICY), undefined);
  assert.equal(redactRecord(42, DEFAULT_REDACTION_POLICY), 42);
  assert.equal(redactRecord(true, DEFAULT_REDACTION_POLICY), true);
});

test("redactRecord preserves array ordering", () => {
  const record = ["a", "b", "c", "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "d"] as string[];
  const out = redactRecord(record, DEFAULT_REDACTION_POLICY) as string[];
  assert.equal(out.length, 5);
  assert.equal(out[0], "a");
  assert.equal(out[4], "d");
  assert.ok(!out.join(" ").includes("ghp_aaaa"));
});

// ---------------------------------------------------------------------------
// isDenyListedEnvName
// ---------------------------------------------------------------------------

test("isDenyListedEnvName matches common secret env names", () => {
  for (const name of [
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "SESSION_ID",
    "BASIC_AUTH",
    "DB_PASSWORD",
    "SOME_COOKIE",
    "MY_CREDENTIAL",
    "PRIVATE_KEY",
  ]) {
    assert.equal(
      isDenyListedEnvName(name, DEFAULT_REDACTION_POLICY),
      true,
      `expected ${name} to match deny patterns`,
    );
  }
});

test("isDenyListedEnvName skips ordinary env names", () => {
  for (const name of ["PATH", "HOME", "LANG", "USER", "CI", "NODE_ENV", "TERM"]) {
    assert.equal(isDenyListedEnvName(name, DEFAULT_REDACTION_POLICY), false, name);
  }
});

// ---------------------------------------------------------------------------
// summarizeRedactionPolicy (hard rule 384)
// ---------------------------------------------------------------------------

test("summarizeRedactionPolicy reports counts + active flag", () => {
  const s = summarizeRedactionPolicy(DEFAULT_REDACTION_POLICY);
  assert.equal(s.active, true);
  assert.equal(s.envAllowlistCount, DEFAULT_REDACTION_POLICY.envAllowlist.length);
  assert.equal(s.envDenyPatternCount, DEFAULT_REDACTION_POLICY.envDenyPatterns.length);
  assert.equal(s.textPatternCount, DEFAULT_REDACTION_POLICY.textSecretPatterns.length);
});

test("summarizeRedactionPolicy reports inactive when both pattern arrays are empty", () => {
  const empty: RedactionPolicy = {
    envAllowlist: [],
    envDenyPatterns: [],
    textSecretPatterns: [],
  };
  const s = summarizeRedactionPolicy(empty);
  assert.equal(s.active, false);
  assert.equal(s.envDenyPatternCount, 0);
  assert.equal(s.textPatternCount, 0);
});
