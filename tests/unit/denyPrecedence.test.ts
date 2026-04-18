import assert from "node:assert/strict";
import test from "node:test";

import {
  hydratePermissionRule,
  type PermissionRule,
  type RawPermissionRule,
} from "../../src/attemptProtocol.js";
import { evaluatePermission, mergePermissionRules } from "../../src/host/permissionEvaluator.js";

/**
 * Phase 4 W2 load-bearing invariants:
 *
 *   I1. **Deny always wins.** Any rule matching with `effect: "deny"`
 *       overrides any `allow` rule and any Autopilot flag.
 *   I2. **Merge preserves deny.** When permission rules compose across
 *       layers (agent profile ← repo config ← user config ← session
 *       override), the merge MUST NOT let a layered `allow` shadow a
 *       lower-layer `deny`.
 *
 * See `plans/bakudo-ux/04-provenance-first-inspection-and-approval.md`
 * — "Hard Safety Invariants" in the 2026-04-14 Reference-Informed
 * Additions. These tests are the regression fence around that contract.
 */

// Short constructor — keeps the rule matrix compact and readable.
const r = (raw: RawPermissionRule): PermissionRule => hydratePermissionRule(raw);

// ---------------------------------------------------------------------------
// I1. Deny always wins — at least 8 cases, including Autopilot + deny.
// ---------------------------------------------------------------------------

test("I1.1 deny overrides allow (same tool, same pattern)", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "deny", tool: "shell", pattern: "*", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "rm -rf /"), "deny");
});

test("I1.2 deny overrides tool-wildcard allow from user_config", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "*", pattern: "*", source: "user_config" }),
    r({ effect: "deny", tool: "network", pattern: "*", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "network", "https://evil.example.com"), "deny");
});

test("I1.3 deny overrides narrow allow (git push denied despite shell-allow)", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "deny", tool: "shell", pattern: "git push:*", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "git push:origin main"), "deny");
  // Non-matching target on the deny rule still allows.
  assert.equal(evaluatePermission(rules, "shell", "git status"), "allow");
});

test("I1.4 Autopilot + deny: broad allow from user_interactive is still denied", () => {
  // In Autopilot mode the host is expected to synthesise an allow-all rule
  // (see Phase 3 attemptCompiler: `allowAllTools: true`). Even so, a deny
  // rule from repo_config wins.
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "*", pattern: "*", source: "user_interactive" }),
    r({ effect: "deny", tool: "write", pattern: ".env*", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "write", ".env.local"), "deny");
});

test("I1.5 Autopilot + deny with explicit /allow-all rule: deny still wins", () => {
  // Mirrors the `/allow-all on` escape hatch from A4.3 — a session-scoped
  // universal allow MUST NOT bypass a deny rule.
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "*", pattern: "*", source: "user_interactive" }),
    r({ effect: "deny", tool: "network", pattern: "**", source: "user_config" }),
  ];
  assert.equal(evaluatePermission(rules, "network", "https://internal/metrics"), "deny");
});

test("I1.6 deny order independence — rule order does not affect precedence", () => {
  // Test both orders produce the same deny outcome.
  const allowFirst: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "deny", tool: "shell", pattern: "rm **", source: "repo_config" }),
  ];
  const denyFirst: PermissionRule[] = [
    r({ effect: "deny", tool: "shell", pattern: "rm **", source: "repo_config" }),
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
  ];
  assert.equal(evaluatePermission(allowFirst, "shell", "rm -rf /tmp"), "deny");
  assert.equal(evaluatePermission(denyFirst, "shell", "rm -rf /tmp"), "deny");
});

test("I1.7 multiple competing allows cannot outvote a single deny", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "allow", tool: "*", pattern: "*", source: "user_config" }),
    r({ effect: "allow", tool: "shell", pattern: "npm:*", source: "user_interactive" }),
    r({ effect: "deny", tool: "shell", pattern: "npm:publish", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "npm:publish"), "deny");
});

test("I1.8 deny with tool=* works across all tools", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "allow", tool: "write", pattern: "*", source: "agent_profile" }),
    r({ effect: "allow", tool: "network", pattern: "*", source: "agent_profile" }),
    r({ effect: "deny", tool: "*", pattern: "**/secrets/**", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "cat src/secrets/prod.key"), "deny");
  assert.equal(evaluatePermission(rules, "write", "src/secrets/new.key"), "deny");
  assert.equal(evaluatePermission(rules, "network", "https://secrets/etc"), "deny");
});

test("I1.9 ask-tier never promotes over deny: deny > ask", () => {
  const rules: PermissionRule[] = [
    r({ effect: "ask", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "deny", tool: "shell", pattern: "rm **", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "rm -rf /"), "deny");
});

// ---------------------------------------------------------------------------
// I2. Merge preserves deny — at least 3 cases from the design revision.
// ---------------------------------------------------------------------------

test("I2.1 merge-preserves-deny: allow-layer-above-deny retains both", () => {
  // Lowest-precedence layer denies; higher layer broadly allows.
  const agentProfile: PermissionRule[] = [
    r({ effect: "deny", tool: "network", pattern: "*", source: "agent_profile" }),
  ];
  const userConfig: PermissionRule[] = [
    r({ effect: "allow", tool: "*", pattern: "*", source: "user_config" }),
  ];
  const merged = mergePermissionRules([agentProfile, userConfig]);

  // Both rules survive.
  assert.equal(merged.length, 2);
  const denies = merged.filter((rule) => rule.effect === "deny");
  assert.equal(denies.length, 1, "the agent_profile deny must survive the merge");

  // The evaluator's deny-precedence then wins at eval time.
  assert.equal(evaluatePermission(merged, "network", "https://anywhere"), "deny");
});

test("I2.2 merge-preserves-deny: deny-layer-above-allow retains both", () => {
  // Lowest layer broadly allows; higher layer denies narrow. Deny still wins.
  const agentProfile: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
  ];
  const repoConfig: PermissionRule[] = [
    r({ effect: "deny", tool: "shell", pattern: "git push:*", source: "repo_config" }),
  ];
  const merged = mergePermissionRules([agentProfile, repoConfig]);

  assert.equal(merged.length, 2);
  assert.equal(evaluatePermission(merged, "shell", "git push:origin main"), "deny");
  assert.equal(evaluatePermission(merged, "shell", "git status"), "allow");
});

test("I2.3 merge-preserves-deny: multi-layer fallthrough — 4 layers, 1 deny wins all", () => {
  const agentProfile: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
  ];
  const repoConfig: PermissionRule[] = [
    r({ effect: "deny", tool: "shell", pattern: "curl:*", source: "repo_config" }),
  ];
  const userConfig: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "curl:internal.*", source: "user_config" }),
  ];
  const sessionOverride: PermissionRule[] = [
    r({ effect: "allow", tool: "*", pattern: "*", source: "user_interactive" }),
  ];
  // Lowest → highest precedence.
  const merged = mergePermissionRules([agentProfile, repoConfig, userConfig, sessionOverride]);

  assert.equal(merged.length, 4, "every layer's rule survives the merge");
  // Deny from repo_config still wins, even with session-scoped allow-all above.
  assert.equal(evaluatePermission(merged, "shell", "curl:internal.mycompany.com"), "deny");
  assert.equal(evaluatePermission(merged, "shell", "ls"), "allow");
});

test("I2.4 merge deduplicates identical ruleIds from lowest-precedence layer first", () => {
  // Design note: "first occurrence wins so the earliest layer's `source`
  // tag is preserved for provenance." This matters for audit replay.
  const sharedRule: PermissionRule = r({
    effect: "deny",
    tool: "shell",
    pattern: "rm **",
    source: "agent_profile",
  });
  const laterSameRule: PermissionRule = r({
    effect: "deny",
    tool: "shell",
    pattern: "rm **",
    source: "user_config",
  });
  // Both hydrate to the same ruleId (hash is over tool|pattern|effect|source).
  // Use the identical ruleId to simulate true duplication.
  const duplicated: PermissionRule = { ...sharedRule };

  const merged = mergePermissionRules([[sharedRule], [duplicated], [laterSameRule]]);
  // Shared rule dedup'd; laterSameRule has a different ruleId (different source).
  assert.equal(merged.length, 2);
  const denies = merged.filter((rule) => rule.effect === "deny");
  assert.equal(denies.length, 2);
  // The agent_profile rule retained its provenance tag.
  assert.equal(denies[0]?.source, "agent_profile");
});
