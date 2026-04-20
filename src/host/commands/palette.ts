/**
 * Phase 5 PR7 — `/palette` slash command + `app:commandPalette` keybinding
 * handler registration.
 *
 * Invoking `/palette` opens a command-palette overlay that lists every
 * visible registry entry. The user types to fuzzy-filter, navigates with
 * the usual dialog keys (handled by the reducer actions), and confirms
 * with Enter to execute the chosen command.
 *
 * TODO(phase5-pr8): raw-key dispatch for `Ctrl+K` is not wired yet — the
 * readline-based interactive loop does not surface key events to the
 * keybinding registry. The palette can be reached via the slash command
 * today or the keybinding once PR8 lands.
 */
import type { HostAppState } from "../appState.js";
import type { HostCommandRegistry, HostCommandSpec } from "../commandRegistry.js";
import type { DialogDispatcher } from "../dialogLauncher.js";
import { launchCommandPaletteDialog } from "../launchCommandPaletteDialog.js";
import { registerKeybinding } from "../keybindings/hooks.js";

/**
 * Shared entry point — factored out so both the slash command and the
 * keybinding handler call the same code path. Writes a transcript event so
 * the user sees the outcome on any sink.
 */
export const runCommandPalette = async (input: {
  registry: HostCommandRegistry;
  getState: () => HostAppState;
  setState: (next: HostAppState) => void;
  dispatch: (line: string) => Promise<void>;
  note: (message: string) => void;
}): Promise<void> => {
  const { registry, getState, setState, dispatch, note } = input;
  const dispatcher: DialogDispatcher = { getState, setState };
  const choice = await launchCommandPaletteDialog(dispatcher, registry);
  if (choice === "cancel") {
    note("palette: cancelled");
    return;
  }
  note(`palette: /${choice.commandName}`);
  await dispatch(`/${choice.commandName}`);
};

/**
 * Build the `/palette` slash command spec. Takes the registry so the
 * opener can enumerate commands; wiring happens in
 * `commandRegistryDefaults.ts`.
 */
export const buildPaletteCommands = (registry: HostCommandRegistry): readonly HostCommandSpec[] => [
  {
    name: "palette",
    group: "system",
    description: "Open the command palette (fuzzy search over all commands).",
    handler: async ({ deps }) => {
      await runCommandPalette({
        registry,
        getState: () => deps.appState,
        // TODO: remove once launch* dialogs dispatch actions directly instead of computing full next state.
        setState: (next) => {
          deps.dispatch({ type: "replace_state", state: next });
        },
        dispatch: async (line) => {
          const outcome = await registry.dispatch(line, deps);
          if (outcome.kind === "unknown") {
            deps.dispatch({
              type: "push_notice",
              notice: `palette: unknown command "${line}"`,
            });
          }
        },
        note: (message) => {
          deps.transcript.push({ kind: "event", label: "palette", detail: message });
        },
      });
    },
  },
];

/**
 * Register the default `app:commandPalette` keybinding handler. The
 * handler is a stub today — it only emits a notice via the dispatcher,
 * because raw-key dispatch from the interactive loop lands in PR8. Once
 * PR8 lands, the real dispatch path will look up this handler and call
 * `runCommandPalette` directly.
 *
 * Callers pass a fresh disposer handle; tests can invoke the handler
 * directly and verify the registration.
 */
export const registerPaletteKeybinding = (handler: () => void): (() => void) =>
  registerKeybinding("Global", "app:commandPalette", handler);
