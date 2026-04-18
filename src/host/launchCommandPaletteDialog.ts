/**
 * Phase 5 PR7 — Command-palette launcher.
 *
 * Mirrors `launchApprovalDialog` in `dialogLauncher.ts`:
 *   - enqueues a `command_palette` prompt entry onto `promptQueue`
 *   - awaits the shared `promptResolvers` promise
 *   - dequeues in `finally` so follow-up launches run cleanly
 *
 * Interaction model (driven externally via the reducer):
 *   - user typing dispatches `palette_input_change` to narrow the filtered list
 *   - arrow / ctrl-n-p dispatches `palette_select_next` / `palette_select_prev`
 *   - `Enter` → caller calls {@link answerCommandPaletteDialog} with the
 *     selected command name; launcher resolves with `{ commandName }`
 *   - `Esc`   → caller calls `cancelPrompt(id)`; launcher resolves with
 *     `"cancel"`
 *
 * The launcher does NOT couple to a render loop; it only produces queue
 * state and consumes resolver promises. This matches the Phase 4 contract
 * (see `dialogLauncher.ts` header comment).
 */
import type {
  CommandPaletteItem,
  CommandPaletteRequest,
  HostAppState,
  PromptEntry,
} from "./appState.js";
import type { HostCommandRegistry } from "./commandRegistry.js";
import type { DialogDispatcher } from "./dialogLauncher.js";
import { answerPrompt, awaitPrompt, newPromptId } from "./promptResolvers.js";
import { reduceHost, type HostAction } from "./reducer.js";

export type CommandPaletteDialogChoice = { commandName: string } | "cancel";

/**
 * Build the list of commands shown in the palette. Visible commands only
 * (filtered via `spec.visible`), `hidden` entries excluded, sorted
 * alphabetically by name so the user sees a stable order. The description
 * field is pulled verbatim from the registry spec.
 *
 * Exported so tests can assert on the exact item set without booting a
 * dialog.
 */
export const buildCommandPaletteItems = (
  registry: HostCommandRegistry,
  state: HostAppState,
): CommandPaletteItem[] => {
  const items = registry
    .list(state)
    .filter((spec) => spec.hidden !== true)
    .map((spec) => ({ name: spec.name, description: spec.description }));
  items.sort((left, right) => left.name.localeCompare(right.name));
  return items;
};

/**
 * Enqueue a `command_palette` prompt entry and await the user's choice.
 *
 * The returned promise resolves with:
 *   - `{ commandName }` when the interactive loop calls
 *     {@link answerCommandPaletteDialog} (Enter)
 *   - `"cancel"` when the loop calls `cancelPrompt(id)` (Esc) or the
 *     resolver is cancelled for any other reason.
 */
export const launchCommandPaletteDialog = async (
  dispatcher: DialogDispatcher,
  registry: HostCommandRegistry,
): Promise<CommandPaletteDialogChoice> => {
  const items = buildCommandPaletteItems(registry, dispatcher.getState());
  const request: CommandPaletteRequest = {
    items,
    input: "",
    selectedIndex: 0,
  };
  const id = newPromptId();
  const entry: PromptEntry = { id, kind: "command_palette", payload: request };
  const enqueueAction: HostAction = { type: "enqueue_prompt", prompt: entry };
  dispatcher.setState(reduceHost(dispatcher.getState(), enqueueAction));
  try {
    const resolution = await awaitPrompt(id);
    if (resolution.kind !== "answered") {
      return "cancel";
    }
    // Empty-string answer (no match selected) is also a cancel — safer than
    // running a blank command.
    if (resolution.value.length === 0) {
      return "cancel";
    }
    return { commandName: resolution.value };
  } finally {
    const dequeueAction: HostAction = { type: "dequeue_prompt", id };
    dispatcher.setState(reduceHost(dispatcher.getState(), dequeueAction));
  }
};

/**
 * Test / interactive-loop entry point: resolve the active command-palette
 * prompt with the supplied command name. Returns the prompt id on success
 * or `null` if the head of the queue is not a palette entry.
 */
export const answerCommandPaletteDialog = (
  dispatcher: DialogDispatcher,
  commandName: string,
): string | null => {
  const head = dispatcher.getState().promptQueue[0];
  if (head === undefined || head.kind !== "command_palette") {
    return null;
  }
  return answerPrompt(head.id, commandName) ? head.id : null;
};
