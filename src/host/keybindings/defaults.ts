/**
 * Shipped default keybinding blocks. Mirror the spec in
 * `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md:544-558` and the
 * PR scope table at
 * `plans/bakudo-ux/phase-5-renderer-decision.md:367-388`.
 *
 * These are placeholder action IDs — no dispatch implementations live here.
 * The consuming PRs (W3 advanced interactions) wire handlers up via
 * `hooks.ts`'s `registerKeybinding`.
 */

export type KeybindingContext = "Global" | "Composer" | "Inspect" | "Dialog" | "Transcript";

export type ActionId = string;

export type KeybindingBlock = {
  context: KeybindingContext;
  bindings: Record<string, ActionId>;
};

/**
 * Platform-aware mode-cycle key.
 *
 * Windows Terminal without VT mode cannot distinguish `Shift+Tab` from plain
 * `Tab`; bakudo falls back to `Meta+M` on such terminals. `WT_SESSION` is set
 * by Windows Terminal when VT is active (documented in the reference-informed
 * additions at `05-…hardening.md:531-567`).
 *
 * Exported so tests can assert both branches deterministically.
 */
export const resolveModeCycleKey = (env: {
  platform: string;
  wtSession: string | undefined;
}): string => {
  if (env.platform === "win32" && (env.wtSession === undefined || env.wtSession.length === 0)) {
    return "meta+m";
  }
  return "shift+tab";
};

// Access platform + env via the node:process module directly — the project's
// narrowed `process` global type doesn't expose `.platform`.
const nodeProcess: { platform: string; env: Record<string, string | undefined> } = (
  globalThis as unknown as {
    process: { platform: string; env: Record<string, string | undefined> };
  }
).process;

const detectModeCycleKey = (): string =>
  resolveModeCycleKey({
    platform: nodeProcess.platform,
    wtSession: nodeProcess.env.WT_SESSION,
  });

/**
 * Build the defaults fresh each call so feature-gate / env changes are
 * respected in tests without a process restart. Cheap — six entries per
 * block at most.
 */
export const buildDefaultBindings = (
  env: { platform: string; wtSession: string | undefined } = {
    platform: nodeProcess.platform,
    wtSession: nodeProcess.env.WT_SESSION,
  },
): KeybindingBlock[] => {
  const modeCycleKey = resolveModeCycleKey(env);
  return [
    {
      context: "Global",
      bindings: {
        "?": "app:quickHelp",
        "ctrl+c": "app:interrupt",
        "ctrl+d": "app:exit",
        "ctrl+k": "app:commandPalette",
        "ctrl+l": "app:redraw",
        "ctrl+r": "history:search",
      },
    },
    {
      context: "Composer",
      bindings: {
        escape: "composer:cancel",
        [modeCycleKey]: "composer:cycleMode",
        enter: "composer:submit",
        "ctrl+x ctrl+k": "composer:killAgents",
        "escape escape": "app:timelinePicker",
      },
    },
    {
      context: "Inspect",
      bindings: {
        tab: "inspect:tabNext",
        "shift+tab": "inspect:tabPrev",
        pageup: "inspect:scrollUp",
        "ctrl+u": "inspect:scrollUp",
        pagedown: "inspect:scrollDown",
        "ctrl+d": "inspect:scrollDown",
        home: "inspect:scrollHome",
        end: "inspect:scrollEnd",
      },
    },
    {
      context: "Dialog",
      bindings: {
        "shift+tab": "dialog:back",
        enter: "dialog:confirm",
        escape: "dialog:cancel",
      },
    },
    {
      context: "Transcript",
      bindings: {
        "ctrl+s": "transcript:search",
      },
    },
  ];
};

/**
 * Eagerly-built default binding set — reflects the environment in which the
 * module is imported. Tests that exercise the platform branch should call
 * `buildDefaultBindings({...})` explicitly.
 */
export const DEFAULT_BINDINGS: KeybindingBlock[] = buildDefaultBindings();

/**
 * Convenience lookup: merge every block into a flat `{ action: keyString }`
 * map. The inverse (`keyString -> action`) lives on the blocks themselves.
 */
export const DEFAULT_MODE_CYCLE_KEY = detectModeCycleKey();
