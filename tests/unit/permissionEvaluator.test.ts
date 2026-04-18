import assert from "node:assert/strict";
import test from "node:test";

import {
  hydratePermissionRule,
  type PermissionRule,
  type RawPermissionRule,
} from "../../src/attemptProtocol.js";
import {
  compileProfilePermissions,
  evaluatePermission,
  matchGlob,
} from "../../src/host/permissionEvaluator.js";

/**
 * Small test helper — the evaluator cares about `tool`, `pattern`, `effect`,
 * `source`; `ruleId` and `scope` get synthesized by the hydrator. Keeping
 * these literals short keeps the test matrix readable.
 */
const r = (raw: RawPermissionRule): PermissionRule => hydratePermissionRule(raw);

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

test("matchGlob: literal match", () => {
  assert.equal(matchGlob("foo", "foo"), true);
  assert.equal(matchGlob("foo", "bar"), false);
});

test("matchGlob: single * matches any non-slash chars", () => {
  assert.equal(matchGlob("*.ts", "index.ts"), true);
  assert.equal(matchGlob("*.ts", "src/index.ts"), false);
});

test("matchGlob: ** matches nested paths", () => {
  assert.equal(matchGlob("src/**/*.ts", "src/foo/bar.ts"), true);
  assert.equal(matchGlob("src/**/*.ts", "src/baz.ts"), true);
  assert.equal(matchGlob("src/**/*.ts", "lib/foo.ts"), false);
});

test("matchGlob: universal wildcards", () => {
  assert.equal(matchGlob("*", "anything"), true);
  assert.equal(matchGlob("**", "any/nested/path"), true);
});

test("matchGlob: git:* pattern (shell tool grammar)", () => {
  assert.equal(matchGlob("git:*", "git:commit"), true);
  assert.equal(matchGlob("git:*", "git:push"), true);
  assert.equal(matchGlob("git:*", "npm:install"), false);
});

// ---------------------------------------------------------------------------
// evaluatePermission
// ---------------------------------------------------------------------------

test("deny rule overrides allow for same tool+target", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "deny", tool: "shell", pattern: "rm **", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "rm -rf /"), "deny");
});

test("deny wins even when an allow-all rule precedes it", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "*", pattern: "*", source: "user_config" }),
    r({ effect: "deny", tool: "network", pattern: "*", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "network", "https://evil.com"), "deny");
});

test("no matching rules returns ask (safe default)", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "write", pattern: "*.ts", source: "agent_profile" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "ls"), "ask");
});

test("wildcard * pattern matches everything for a tool", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "git commit"), "allow");
  assert.equal(evaluatePermission(rules, "shell", "npm install"), "allow");
});

test("** glob matches nested paths (src/foo/bar.ts matches src/**/*.ts)", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "write", pattern: "src/**/*.ts", source: "agent_profile" }),
  ];
  assert.equal(evaluatePermission(rules, "write", "src/foo/bar.ts"), "allow");
  assert.equal(evaluatePermission(rules, "write", "lib/foo.ts"), "ask");
});

test("shell(git:*) grammar: tool=shell, pattern=git:* matches git:commit but not npm:install", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "shell", pattern: "git:*", source: "agent_profile" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "git:commit"), "allow");
  assert.equal(evaluatePermission(rules, "shell", "npm:install"), "ask");
});

test("tool: * rule matches any tool", () => {
  const rules: PermissionRule[] = [
    r({ effect: "deny", tool: "*", pattern: "*.exe", source: "repo_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "malware.exe"), "deny");
  assert.equal(evaluatePermission(rules, "write", "binary.exe"), "deny");
  assert.equal(evaluatePermission(rules, "network", "safe.txt"), "ask");
});

test("empty rules array returns ask", () => {
  assert.equal(evaluatePermission([], "shell", "anything"), "ask");
});

test("allow takes priority over ask when both match", () => {
  const rules: PermissionRule[] = [
    r({ effect: "ask", tool: "shell", pattern: "*", source: "agent_profile" }),
    r({ effect: "allow", tool: "shell", pattern: "git:*", source: "user_config" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "git:status"), "allow");
});

test("ask returned when only ask rules match", () => {
  const rules: PermissionRule[] = [
    r({ effect: "ask", tool: "write", pattern: "*", source: "agent_profile" }),
  ];
  assert.equal(evaluatePermission(rules, "write", "README.md"), "ask");
});

test("non-matching tool rules are ignored", () => {
  const rules: PermissionRule[] = [
    r({ effect: "allow", tool: "network", pattern: "*", source: "agent_profile" }),
  ];
  assert.equal(evaluatePermission(rules, "shell", "curl http://example.com"), "ask");
});

// ---------------------------------------------------------------------------
// compileProfilePermissions
// ---------------------------------------------------------------------------

test("compileProfilePermissions produces rules with pattern=* and correct source", () => {
  const rules = compileProfilePermissions(
    { shell: "allow", write: "ask", network: "deny" },
    "agent_profile",
  );
  assert.equal(rules.length, 3);
  for (const rule of rules) {
    assert.equal(rule.pattern, "*");
    assert.equal(rule.source, "agent_profile");
  }
  const shellRule = rules.find((r) => r.tool === "shell");
  assert.equal(shellRule?.effect, "allow");
  const networkRule = rules.find((r) => r.tool === "network");
  assert.equal(networkRule?.effect, "deny");
});

test("compileProfilePermissions with empty profile returns empty array", () => {
  const rules = compileProfilePermissions({}, "user_config");
  assert.equal(rules.length, 0);
});

test("compileProfilePermissions rules integrate with evaluatePermission", () => {
  const rules = compileProfilePermissions({ shell: "allow", network: "deny" }, "agent_profile");
  assert.equal(evaluatePermission(rules, "shell", "git:commit"), "allow");
  assert.equal(evaluatePermission(rules, "network", "https://example.com"), "deny");
  assert.equal(evaluatePermission(rules, "write", "file.ts"), "ask");
});
