/**
 * Phase 5 PR9 — overlay keybinding wiring.
 *
 * Registers the `app:quickHelp` handler into the shared keybinding registry.
 * The handler flips `HostAppState.quickHelp` on/off (toggle semantics — a
 * second `?` press dismisses the overlay) and requests a redraw so the new
 * frame is painted immediately.
 *
 * Kept separate from `interactive.ts` so the shell boot file stays under the
 * 400-line cap and so other entry points (future alt-screen harness, tests)
 * can opt in to the same wiring without pulling in the full readline loop.
 */
import type { HostAppState, QuickHelpContext } from "./appState.js";
import { registerKeybinding, type KeybindingHandler } from "./keybindings/hooks.js";
import { reduceHost } from "./reducer.js";

export type OverlayBindingDeps = {
  getAppState: () => HostAppState;
  setAppState: (next: HostAppState) => void;
  requestRender: () => void;
};

/**
 * Project the current `HostAppState.screen` onto the quick-help context
 * vocabulary. The overlay contexts are the names from the phase 5 plan
 * (`composer`, `inspect`, `dialog`, `transcript`) — the screen is a less
 * ambitious view model (`transcript` / `sessions` / `inspect` / `help`). A
 * pending dialog always wins, because that's where the user's attention is.
 */
export const resolveQuickHelpContext = (state: HostAppState): QuickHelpContext => {
  if (state.promptQueue.length > 0) {
    return "dialog";
  }
  if (state.screen === "inspect") {
    return "inspect";
  }
  if (state.screen === "help" || state.screen === "sessions") {
    return "transcript";
  }
  // Transcript screen — user is at the composer prompt awaiting input.
  return "composer";
};

export const buildQuickHelpHandler = (deps: OverlayBindingDeps): KeybindingHandler => {
  return () => {
    const state = deps.getAppState();
    const context = resolveQuickHelpContext(state);
    const head = state.promptQueue[0];
    const next =
      head === undefined
        ? reduceHost(state, { type: "open_quick_help", context })
        : reduceHost(state, {
            type: "open_quick_help",
            context,
            dialogKind: head.kind,
          });
    deps.setAppState(next);
    deps.requestRender();
  };
};

export type OverlayBindingsHandle = {
  /**
   * Disposer — dissolves every registration done by {@link registerOverlayBindings}.
   * Idempotent.
   */
  dispose: () => void;
};

/**
 * Register every overlay-related keybinding and return a disposer. The
 * bindings registered today are:
 *
 *  - `Global` `app:quickHelp` — toggle the `?` overlay.
 *
 * Future PRs (command-palette open, session-picker open) should land their
 * wire-up alongside so the shell boot in `interactive.ts` keeps one call
 * site for overlay handlers.
 */
export const registerOverlayBindings = (deps: OverlayBindingDeps): OverlayBindingsHandle => {
  const quickHelp = buildQuickHelpHandler(deps);
  const disposers: Array<() => void> = [];
  disposers.push(registerKeybinding("Global", "app:quickHelp", quickHelp));
  return {
    dispose: () => {
      while (disposers.length > 0) {
        const d = disposers.pop();
        if (d !== undefined) {
          d();
        }
      }
    },
  };
};
