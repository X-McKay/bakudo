/**
 * Wave 6c PR7 carryover #7 — `redaction.extra*Patterns` → effective policy.
 *
 * The Zod schema already accepts `redaction.extraTextPatterns` and
 * `redaction.extraEnvDenyPatterns`; before this wave the strings were
 * silently discarded because callers hard-coded `DEFAULT_REDACTION_POLICY`.
 * This suite pins the compile-and-merge behaviour and the
 * `resolveRedactionPolicyForHost` factory.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REDACTION_POLICY,
  REDACTION_MARKER,
  isDenyListedEnvName,
  redactRecord,
  redactText,
  resolveEffectiveRedactionPolicy,
  resolveRedactionPolicyForHost,
  summarizeRedactionPolicy,
} from "../../src/host/redaction.js";

test("resolveEffectiveRedactionPolicy: undefined input returns DEFAULT_REDACTION_POLICY reference", () => {
  const policy = resolveEffectiveRedactionPolicy();
  assert.strictEqual(policy, DEFAULT_REDACTION_POLICY);
});

test("resolveEffectiveRedactionPolicy: empty-extras returns the default", () => {
  const policy = resolveEffectiveRedactionPolicy({});
  assert.strictEqual(policy, DEFAULT_REDACTION_POLICY);
});

test("resolveEffectiveRedactionPolicy: compiles extra text patterns into the policy", () => {
  const policy = resolveEffectiveRedactionPolicy({
    extraTextPatterns: ["custom-secret-\\d+"],
  });
  assert.equal(
    policy.textSecretPatterns.length,
    DEFAULT_REDACTION_POLICY.textSecretPatterns.length + 1,
  );
  const out = redactText("the value is custom-secret-42 yo", policy);
  assert.ok(out.includes(REDACTION_MARKER));
});

test("resolveEffectiveRedactionPolicy: compiles extra env-deny patterns", () => {
  const policy = resolveEffectiveRedactionPolicy({
    extraEnvDenyPatterns: ["^COMPANY_INTERNAL_"],
  });
  assert.equal(isDenyListedEnvName("COMPANY_INTERNAL_DATA", policy), true);
  // Default patterns still apply:
  assert.equal(isDenyListedEnvName("GITHUB_TOKEN", policy), true);
  // Non-matching names still pass through:
  assert.equal(isDenyListedEnvName("PATH", policy), false);
});

test("resolveEffectiveRedactionPolicy: merged policy is used by redactRecord end-to-end", () => {
  const policy = resolveEffectiveRedactionPolicy({
    extraTextPatterns: [".*mysecret.*"],
  });
  const record = { name: "I have a mysecret here" };
  const out = redactRecord(record, policy);
  const json = JSON.stringify(out);
  assert.ok(!json.includes("mysecret"));
  assert.ok(json.includes(REDACTION_MARKER));
});

test("resolveEffectiveRedactionPolicy: invalid regex strings are dropped silently", () => {
  const policy = resolveEffectiveRedactionPolicy({
    extraTextPatterns: ["valid-\\d+", "(unterminated"],
  });
  // Only the valid pattern was compiled.
  assert.equal(
    policy.textSecretPatterns.length,
    DEFAULT_REDACTION_POLICY.textSecretPatterns.length + 1,
  );
});

test("resolveRedactionPolicyForHost: mirrors resolveEnvPolicyForHost (lock-in 26) shape", () => {
  const policy = resolveRedactionPolicyForHost({
    configExtra: { extraTextPatterns: ["my-secret-[a-z]+"] },
  });
  const out = redactText("exposed my-secret-abc here", policy);
  assert.ok(out.includes(REDACTION_MARKER));
});

test("resolveRedactionPolicyForHost: missing configExtra is safe", () => {
  const policy = resolveRedactionPolicyForHost({});
  assert.strictEqual(policy, DEFAULT_REDACTION_POLICY);
});

test("summarizeRedactionPolicy: text pattern count rises when extras merge in", () => {
  const extraCount = 2;
  const policy = resolveEffectiveRedactionPolicy({
    extraTextPatterns: ["p1", "p2"],
  });
  const summary = summarizeRedactionPolicy(policy);
  assert.equal(
    summary.textPatternCount,
    DEFAULT_REDACTION_POLICY.textSecretPatterns.length + extraCount,
  );
});
