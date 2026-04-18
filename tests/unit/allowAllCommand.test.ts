import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hydratePermissionRule, type PermissionRule } from "../../src/attemptProtocol.js";
import {
  durableAllowlistPath,
  loadDurableAllowlist,
  persistDurableRule,
} from "../../src/host/approvalStore.js";
import {
  ALLOW_ALL_DENY_PRECEDENCE_WARNING,
  buildAllowAllRule,
  runAllowAllCommand,
} from "../../src/host/commands/system.js";
import { evaluatePermission } from "../../src/host/permissionEvaluator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const withTempRepo = async (fn: (repoRoot: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-allowall-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Capture printer that collects lines for assertions. */
const makePrinter = (): { lines: string[]; print: (line: string) => void } => {
  const lines: string[] = [];
  return {
    lines,
    print: (line: string) => lines.push(line),
  };
};

// ---------------------------------------------------------------------------
// No subcommand
// ---------------------------------------------------------------------------

test("no subcommand prints usage", async () => {
  await withTempRepo(async (repoRoot) => {
    const { lines, print } = makePrinter();
    await runAllowAllCommand({ args: [], repoRoot, print });
    assert.ok(
      lines.some((l) => l.includes("Usage:")),
      "expected usage header",
    );
    assert.ok(
      lines.some((l) => l.includes("/allow-all on")),
      "expected usage to list `on`",
    );
  });
});

test("unknown subcommand prints usage + error", async () => {
  await withTempRepo(async (repoRoot) => {
    const { lines, print } = makePrinter();
    await runAllowAllCommand({ args: ["flip"], repoRoot, print });
    assert.ok(
      lines.some((l) => l.includes("Unknown /allow-all subcommand: flip")),
      "expected unknown-subcommand line",
    );
    assert.ok(lines.some((l) => l.includes("Usage:")));
  });
});

// ---------------------------------------------------------------------------
// on
// ---------------------------------------------------------------------------

test("on: appends broad-allow rule to the durable allowlist", async () => {
  await withTempRepo(async (repoRoot) => {
    const { lines, print } = makePrinter();
    await runAllowAllCommand({ args: ["on"], repoRoot, print });

    const rules = await loadDurableAllowlist(repoRoot);
    assert.equal(rules.length, 1);
    const only = rules[0];
    assert.ok(only);
    assert.equal(only.effect, "allow");
    assert.equal(only.tool, "*");
    assert.equal(only.pattern, "*");
    assert.equal(only.source, "user_interactive");
    assert.equal(only.scope, "session");

    // Mandatory warning must be emitted verbatim.
    assert.ok(
      lines.includes(ALLOW_ALL_DENY_PRECEDENCE_WARNING),
      `expected deny-precedence warning, got:\n${lines.join("\n")}`,
    );
  });
});

test("on: prints the deny-precedence warning even on the second invocation", async () => {
  await withTempRepo(async (repoRoot) => {
    const first = makePrinter();
    await runAllowAllCommand({ args: ["on"], repoRoot, print: first.print });
    const second = makePrinter();
    await runAllowAllCommand({ args: ["on"], repoRoot, print: second.print });

    // The warning must fire every call — it is load-bearing and must NOT be
    // gated on "rule already present".
    assert.ok(first.lines.includes(ALLOW_ALL_DENY_PRECEDENCE_WARNING));
    assert.ok(second.lines.includes(ALLOW_ALL_DENY_PRECEDENCE_WARNING));
    assert.ok(
      second.lines.some((l) => l.includes("already present")),
      "second call should note the rule already exists",
    );
  });
});

test("on: called twice does NOT duplicate the rule (dedup by ruleId)", async () => {
  await withTempRepo(async (repoRoot) => {
    await runAllowAllCommand({ args: ["on"], repoRoot, print: () => {} });
    await runAllowAllCommand({ args: ["on"], repoRoot, print: () => {} });
    await runAllowAllCommand({ args: ["on"], repoRoot, print: () => {} });

    const rules = await loadDurableAllowlist(repoRoot);
    assert.equal(rules.length, 1, "broad-allow rule must dedup");
  });
});

// ---------------------------------------------------------------------------
// off
// ---------------------------------------------------------------------------

test("off: removes the broad-allow rule while leaving other rules intact", async () => {
  await withTempRepo(async (repoRoot) => {
    // Seed allowlist with a specific rule PLUS the broad-allow rule.
    const specific: PermissionRule = hydratePermissionRule({
      effect: "allow",
      tool: "shell",
      pattern: "git push:*",
      source: "user_interactive",
      scope: "always",
    });
    await persistDurableRule(repoRoot, specific);
    await runAllowAllCommand({ args: ["on"], repoRoot, print: () => {} });

    const before = await loadDurableAllowlist(repoRoot);
    assert.equal(before.length, 2);

    const { lines, print } = makePrinter();
    await runAllowAllCommand({ args: ["off"], repoRoot, print });

    const after = await loadDurableAllowlist(repoRoot);
    assert.equal(after.length, 1);
    const kept = after[0];
    assert.ok(kept);
    assert.equal(kept.ruleId, specific.ruleId);
    assert.ok(lines.some((l) => l.includes("removed 1 broad-allow rule")));
  });
});

test("off: when no broad-allow rule is present, is a no-op and prints nothing destructive", async () => {
  await withTempRepo(async (repoRoot) => {
    const specific: PermissionRule = hydratePermissionRule({
      effect: "allow",
      tool: "shell",
      pattern: "git push:*",
      source: "user_interactive",
      scope: "always",
    });
    await persistDurableRule(repoRoot, specific);

    const { lines, print } = makePrinter();
    await runAllowAllCommand({ args: ["off"], repoRoot, print });

    const after = await loadDurableAllowlist(repoRoot);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.ruleId, specific.ruleId);
    assert.ok(lines.some((l) => l.includes("no broad-allow rule present")));
  });
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

test("show: empty allowlist prints a friendly message", async () => {
  await withTempRepo(async (repoRoot) => {
    const { lines, print } = makePrinter();
    await runAllowAllCommand({ args: ["show"], repoRoot, print });
    assert.ok(lines.some((l) => l.includes("allowlist is empty")));
  });
});

test("show: renders each rule as `<effect> <tool>(<pattern>) <scope> <source>`", async () => {
  await withTempRepo(async (repoRoot) => {
    const rules: PermissionRule[] = [
      hydratePermissionRule({
        effect: "allow",
        tool: "shell",
        pattern: "git push:*",
        source: "user_interactive",
        scope: "always",
      }),
      hydratePermissionRule({
        effect: "deny",
        tool: "network",
        pattern: "https://internal.example.com/**",
        source: "repo_config",
        scope: "session",
      }),
    ];
    for (const rule of rules) {
      await persistDurableRule(repoRoot, rule);
    }

    const { lines, print } = makePrinter();
    await runAllowAllCommand({ args: ["show"], repoRoot, print });

    const body = lines.join("\n");
    assert.match(body, /2 rule\(s\)/u);
    assert.match(body, /allow shell\(git push:\*\) always user_interactive/u);
    assert.match(
      body,
      /deny network\(https:\/\/internal\.example\.com\/\*\*\) session repo_config/u,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration with evaluatePermission
// ---------------------------------------------------------------------------

test("evaluatePermission: after /allow-all on, shell(anything) evaluates to allow", async () => {
  await withTempRepo(async (repoRoot) => {
    await runAllowAllCommand({ args: ["on"], repoRoot, print: () => {} });
    const rules = await loadDurableAllowlist(repoRoot);
    const effect = evaluatePermission(rules, "shell", "rm -rf /tmp/anything");
    assert.equal(effect, "allow");
  });
});

test("evaluatePermission: deny rule still wins even with a universal allow rule present", async () => {
  await withTempRepo(async (repoRoot) => {
    await runAllowAllCommand({ args: ["on"], repoRoot, print: () => {} });
    // Add a narrow deny rule afterwards — deny-precedence invariant.
    // The glob `rm **` matches any invocation starting with `rm `; `**`
    // spans path separators so `rm -rf /tmp/anything` lands on it.
    const deny: PermissionRule = hydratePermissionRule({
      effect: "deny",
      tool: "shell",
      pattern: "rm **",
      source: "repo_config",
      scope: "always",
    });
    await persistDurableRule(repoRoot, deny);

    const rules = await loadDurableAllowlist(repoRoot);
    assert.equal(
      evaluatePermission(rules, "shell", "rm -rf /tmp/anything"),
      "deny",
      "deny-precedence invariant: a deny rule must override the broad-allow rule",
    );
    // Commands NOT matched by the deny still go through allow.
    assert.equal(evaluatePermission(rules, "shell", "ls -la"), "allow");
  });
});

// ---------------------------------------------------------------------------
// Durable file shape
// ---------------------------------------------------------------------------

test("on writes NDJSON at <repoRoot>/.bakudo/approvals.jsonl", async () => {
  await withTempRepo(async (repoRoot) => {
    await runAllowAllCommand({ args: ["on"], repoRoot, print: () => {} });
    const raw = await readFile(durableAllowlistPath(repoRoot), "utf8");
    assert.ok(raw.endsWith("\n"), "expected trailing newline");
    const parsed = JSON.parse(raw.trim()) as PermissionRule;
    const expectedRule = buildAllowAllRule();
    assert.equal(parsed.ruleId, expectedRule.ruleId);
    assert.equal(parsed.tool, "*");
    assert.equal(parsed.pattern, "*");
  });
});
