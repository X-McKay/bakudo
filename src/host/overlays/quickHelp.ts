/**
 * Phase 5 PR9 — `?` quick-help overlay content builder.
 *
 * Spec: `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md:469-481`
 * and `plans/bakudo-ux/phase-5-renderer-decision.md:341-354`.
 *
 * Context-aware help is projected from:
 *   1. The shipped keybinding defaults (`keybindings/defaults.ts`) for the
 *      relevant `KeybindingContext` plus the `Global` block.
 *   2. The action-handler registry (`keybindings/hooks.ts`) — optional. When
 *      supplied, only *registered* actions are listed; this lets the overlay
 *      hide bindings that exist in defaults but whose handlers haven't been
 *      wired up yet (avoids lying to the user about what `?` can do).
 *
 * Output is a plain `string[]`: a heading line, a blank line, one line per
 * binding (`"<key>  <action label>"`), then (for dialog context) a trailing
 * section naming the pending dialog kind. Renderers wrap the result in
 * `renderBox` so the overlay floats above the transcript.
 */
import type { ActionId, KeybindingBlock, KeybindingContext } from "../keybindings/defaults.js";
import type { KeybindingHandler } from "../keybindings/hooks.js";
import type { QuickHelpContext } from "../appState.js";

/**
 * Human-readable labels for every action ID bakudo ships. Listed ad-hoc here
 * (rather than hanging off the binding defaults) so help text can diverge from
 * the raw action identifier — e.g. `"app:commandPalette"` renders as
 * `"Open command palette"` rather than the machine ID. Unknown actions fall
 * back to the raw ID so the overlay never silently loses a binding.
 */
const ACTION_LABELS: Record<string, string> = {
  "app:interrupt": "Interrupt / cancel",
  "app:exit": "Exit",
  "app:redraw": "Redraw screen",
  "app:commandPalette": "Open command palette",
  "app:quickHelp": "Show this help",
  "history:search": "Search command history",
  "composer:cancel": "Cancel composer",
  "composer:submit": "Submit composer",
  "composer:cycleMode": "Cycle composer mode",
  "composer:killAgents": "Kill all agents",
  "inspect:tabNext": "Next inspect tab",
  "inspect:scrollUp": "Scroll up",
  "inspect:scrollDown": "Scroll down",
  "dialog:back": "Back",
  "dialog:confirm": "Confirm",
  "dialog:cancel": "Cancel",
  "transcript:search": "Search transcript",
};

const labelFor = (action: ActionId): string => {
  const label = ACTION_LABELS[action];
  return label === undefined ? action : label;
};

/**
 * Map a high-level quick-help context onto the keybinding-registry contexts
 * whose bindings are relevant. Dialog and composer both inherit Global; the
 * transcript context inherits Global + Transcript.
 */
const contextsFor = (context: QuickHelpContext): KeybindingContext[] => {
  if (context === "composer") {
    return ["Composer", "Global"];
  }
  if (context === "inspect") {
    return ["Inspect", "Global"];
  }
  if (context === "dialog") {
    return ["Dialog", "Global"];
  }
  return ["Transcript", "Global"];
};

const headingFor = (context: QuickHelpContext, overlayKind?: string): string => {
  if (context === "dialog" && overlayKind !== undefined && overlayKind.length > 0) {
    return `Quick help — dialog (${overlayKind})`;
  }
  if (context === "composer") {
    return "Quick help — composer";
  }
  if (context === "inspect") {
    return "Quick help — inspect";
  }
  if (context === "dialog") {
    return "Quick help — dialog";
  }
  return "Quick help — transcript";
};

/**
 * Build the help body lines. Pure: no ANSI, no box borders — the caller
 * wraps the list with `renderBox` and picks colors.
 *
 * `keybindings` is the full default-blocks list (import from
 * `keybindings/defaults.ts` and pass `DEFAULT_BINDINGS` or a custom set).
 *
 * When `registry` is supplied, any binding whose action is NOT registered
 * for the matching context is skipped. This keeps the overlay honest: if a
 * handler hasn't been wired up yet the help doesn't advertise it as live.
 * When `registry` is `undefined`, every shipped binding is shown (useful for
 * tests and for the initial render before the shell's handlers register).
 *
 * `overlayKind` is the string tag of the *dialog* the user is currently in
 * (e.g. `"approval_prompt"`). Used to disambiguate the dialog heading.
 */
export const buildQuickHelpContents = (
  context: QuickHelpContext,
  keybindings: readonly KeybindingBlock[],
  registry?: ReadonlyMap<ActionId, KeybindingHandler>,
  overlayKind?: string,
): string[] => {
  const wanted = contextsFor(context);
  const rows: string[] = [];
  const seenActions = new Set<ActionId>();
  for (const ctx of wanted) {
    const block = keybindings.find((b) => b.context === ctx);
    if (block === undefined) {
      continue;
    }
    const entries = Object.entries(block.bindings);
    for (const [key, action] of entries) {
      // Skip duplicates — a binding listed in both (e.g.) Dialog and Global
      // should appear once.
      if (seenActions.has(action)) {
        continue;
      }
      if (registry !== undefined && ctx !== "Global" && !registry.has(action)) {
        // Scope the "is registered" filter to the context-specific block.
        // Global actions are kept unconditionally so `?`, `Ctrl+C`, `Ctrl+L`
        // always appear as a user-discoverable footnote.
        continue;
      }
      seenActions.add(action);
      rows.push(`${key.padEnd(14)} ${labelFor(action)}`);
    }
  }
  const lines: string[] = [];
  lines.push(headingFor(context, overlayKind));
  lines.push("");
  if (rows.length === 0) {
    lines.push("(no bindings for this context)");
  } else {
    for (const row of rows) {
      lines.push(row);
    }
  }
  lines.push("");
  lines.push("Press ? or Esc to dismiss.");
  return lines;
};
