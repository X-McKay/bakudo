import { hydratePermissionRule, type PermissionRule } from "../../attemptProtocol.js";
import {
  loadDurableAllowlist,
  persistDurableRule,
  writeDurableAllowlist,
} from "../approvalStore.js";
import type { HostCommandRegistry, HostCommandSpec } from "../commandRegistry.js";
import { repoRootFor } from "../orchestration.js";

/**
 * The mandatory warning printed on every `/allow-all on` invocation. Kept
 * verbatim per the Phase 4 A4.3 spec — the deny-precedence invariant is
 * load-bearing and users need to see it every time they enable the broad
 * allowlist. Exported for test parity with the command handler.
 */
export const ALLOW_ALL_DENY_PRECEDENCE_WARNING =
  "Note: /allow-all on does NOT bypass deny rules. Deny-precedence always wins.";

/**
 * Build the session-scoped universal-allow rule persisted by `/allow-all on`.
 * Deterministic `ruleId` via the hydrator so repeated calls dedup cleanly.
 */
export const buildAllowAllRule = (): PermissionRule =>
  hydratePermissionRule({
    effect: "allow",
    tool: "*",
    pattern: "*",
    scope: "session",
    source: "user_interactive",
  });

/**
 * Identify the broad-allow rule regardless of `scope` / `source` / `ruleId`
 * drift. Use this predicate for removal (`/allow-all off`) so a rule written
 * by an earlier bakudo version still gets cleared.
 */
const isBroadAllowAllRule = (rule: PermissionRule): boolean =>
  rule.effect === "allow" && rule.tool === "*" && rule.pattern === "*";

const formatRuleLine = (rule: PermissionRule): string =>
  `${rule.effect} ${rule.tool}(${rule.pattern}) ${rule.scope} ${rule.source}`;

const allowAllUsage = [
  "/allow-all on — enable the session-scoped universal allow rule.",
  "/allow-all off — remove the universal allow rule from the allowlist.",
  "/allow-all show — print the current durable allowlist.",
];

/**
 * Handler for `/allow-all on|off|show`. Extracted so tests can drive it
 * without booting the full command registry.
 *
 * `repoRoot` overrides are accepted so tests can point at a temp directory
 * instead of `process.cwd()`.
 */
export const runAllowAllCommand = async (input: {
  args: string[];
  repoRoot: string;
  print: (line: string) => void;
}): Promise<void> => {
  const { args, repoRoot, print } = input;
  const subcommand = args[0];

  if (subcommand === undefined) {
    print("Usage:");
    for (const line of allowAllUsage) {
      print(`  ${line}`);
    }
    return;
  }

  if (subcommand === "on") {
    const rule = buildAllowAllRule();
    const existing = await loadDurableAllowlist(repoRoot);
    const alreadyPersisted = existing.some((entry) => entry.ruleId === rule.ruleId);
    if (!alreadyPersisted) {
      await persistDurableRule(repoRoot, rule);
    }
    print(
      alreadyPersisted
        ? "/allow-all on: rule already present; no change."
        : `/allow-all on: enabled universal allow rule ${rule.ruleId}.`,
    );
    // Mandatory warning, every time. Do NOT gate this behind `!alreadyPersisted`.
    print(ALLOW_ALL_DENY_PRECEDENCE_WARNING);
    return;
  }

  if (subcommand === "off") {
    const existing = await loadDurableAllowlist(repoRoot);
    const filtered = existing.filter((rule) => !isBroadAllowAllRule(rule));
    if (filtered.length === existing.length) {
      print("/allow-all off: no broad-allow rule present; no change.");
      return;
    }
    await writeDurableAllowlist(repoRoot, filtered);
    const removedCount = existing.length - filtered.length;
    print(`/allow-all off: removed ${removedCount} broad-allow rule(s).`);
    return;
  }

  if (subcommand === "show") {
    const rules = await loadDurableAllowlist(repoRoot);
    if (rules.length === 0) {
      print("/allow-all show: allowlist is empty.");
      return;
    }
    print(`/allow-all show: ${rules.length} rule(s) in durable allowlist.`);
    for (const rule of rules) {
      print(`  ${formatRuleLine(rule)}`);
    }
    return;
  }

  print(`Unknown /allow-all subcommand: ${subcommand}`);
  print("Usage:");
  for (const line of allowAllUsage) {
    print(`  ${line}`);
  }
};

/**
 * Build the system command specs. The `registry` parameter is injected at
 * construction time so that `/help` can enumerate commands dynamically without
 * creating a circular import between this module and `commandRegistryDefaults`.
 */
export const buildSystemCommands = (registry: HostCommandRegistry): readonly HostCommandSpec[] => [
  {
    name: "help",
    group: "system",
    description: "Show available commands.",
    handler: ({ deps }) => {
      // Dynamically generate the help list from the registry so it stays in
      // sync as commands are added, removed, or changed. Commands with
      // visible() predicates are filtered against the current app state so
      // only contextually relevant commands are shown. Hidden commands are
      // excluded. The prompt usage hint is prepended as a preamble.
      const visibleSpecs = registry.list(deps.appState).filter((spec) => spec.hidden !== true);
      deps.transcript.push({
        kind: "event",
        label: "help",
        detail: "Type a goal to dispatch a sandbox attempt in the current mode.",
      });
      for (const spec of visibleSpecs) {
        const aliases =
          spec.aliases && spec.aliases.length > 0 ? ` (/${spec.aliases.join(", /")})` : "";
        deps.transcript.push({
          kind: "event",
          label: "help",
          detail: `/${spec.name}${aliases} — ${spec.description}`,
        });
      }
    },
  },
  {
    name: "exit",
    aliases: ["quit"] as const,
    group: "system",
    description: "Exit the interactive shell.",
    handler: () => ({ kind: "exit" as const, code: 0 }),
  },
  {
    name: "init",
    group: "system",
    description: "Write a repo-local AGENTS.md template for bakudo.",
    handler: ({ deps }) => ({
      argv: ["init", ...(deps.appState.composer.autoApprove ? ["--yes"] : [])],
    }),
  },
  {
    name: "allow-all",
    group: "system",
    description:
      "Manage the durable allowlist (on|off|show). `/allow-all on` does NOT bypass deny rules.",
    handler: async ({ args, deps }) => {
      await runAllowAllCommand({
        args,
        repoRoot: repoRootFor(undefined),
        print: (line) => {
          deps.transcript.push({ kind: "event", label: "allow-all", detail: line });
        },
      });
    },
  },
];
