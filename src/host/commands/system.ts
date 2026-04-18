import { hydratePermissionRule, type PermissionRule } from "../../attemptProtocol.js";
import {
  loadDurableAllowlist,
  persistDurableRule,
  writeDurableAllowlist,
} from "../approvalStore.js";
import type { HostCommandRegistry, HostCommandSpec } from "../commandRegistry.js";
import { isKnownHelpTopic, loadHelpTopic, unknownTopicMessage } from "../helpTopicLoader.js";
import { repoRootFor } from "../orchestration.js";
import {
  getActiveThemeVariant,
  isThemeVariant,
  setActiveTheme,
  THEME_VARIANTS,
  type ThemeVariant,
} from "../themes/index.js";

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

const themeUsage = [
  "/theme show — print the currently active theme variant.",
  `/theme set <variant> — set the active theme. Variants: ${THEME_VARIANTS.join(", ")}.`,
];

/**
 * Handler for `/theme show|set <variant>`. Extracted for test parity with
 * `runAllowAllCommand`. The reducer doesn't persist theme state — setting
 * the theme mutates the module-level singleton in `themes/index.ts` which
 * the next render reads.
 */
export const runThemeCommand = (input: { args: string[]; print: (line: string) => void }): void => {
  const { args, print } = input;
  const subcommand = args[0];

  if (subcommand === undefined || subcommand === "show") {
    print(`/theme show: active variant is "${getActiveThemeVariant()}".`);
    return;
  }

  if (subcommand === "set") {
    const requested = args[1];
    if (requested === undefined) {
      print("/theme set: missing variant argument.");
      for (const line of themeUsage) {
        print(`  ${line}`);
      }
      return;
    }
    if (!isThemeVariant(requested)) {
      print(`/theme set: unknown variant "${requested}".`);
      print(`  Valid variants: ${THEME_VARIANTS.join(", ")}.`);
      return;
    }
    const variant: ThemeVariant = requested;
    setActiveTheme(variant);
    print(`/theme set: active variant is now "${variant}".`);
    return;
  }

  print(`Unknown /theme subcommand: ${subcommand}`);
  print("Usage:");
  for (const line of themeUsage) {
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
    description: "Show available commands. /help <topic> reads a bundled topic.",
    handler: async ({ args, deps }) => {
      // `/help <topic>` routes to the Phase 5 PR12 help-topic surface when
      // the first argument matches a known topic (config, hooks, permissions,
      // monitoring, sandbox). Anything else falls through to the default
      // command listing.
      const maybeTopic = args[0];
      if (maybeTopic !== undefined && isKnownHelpTopic(maybeTopic)) {
        const loaded = await loadHelpTopic(maybeTopic);
        if (loaded === null) {
          deps.transcript.push({
            kind: "assistant",
            text: `${unknownTopicMessage(maybeTopic)} (file missing — reinstall bakudo)`,
            tone: "error",
          });
          return;
        }
        for (const line of loaded.content.split("\n")) {
          deps.transcript.push({ kind: "event", label: "help", detail: line });
        }
        return;
      }
      // Default: list registered commands.
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
  {
    name: "theme",
    group: "system",
    description:
      "Show or set the active color theme (show|set <variant>). Overrides BAKUDO_THEME for this session.",
    handler: ({ args, deps }) => {
      runThemeCommand({
        args,
        print: (line) => {
          deps.transcript.push({ kind: "event", label: "theme", detail: line });
        },
      });
    },
  },
];
