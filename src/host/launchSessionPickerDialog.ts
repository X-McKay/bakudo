/**
 * Phase 5 PR7 — Session-picker launcher.
 *
 * Companion to {@link launchCommandPaletteDialog}. Same mutual-exclusion
 * contract, same promise shape. Differences:
 *
 *   - Items come from `listSessionSummaries()` (timeline/sessionIndex),
 *     sorted newest-first by `updatedAt`.
 *   - The displayed label packs sessionId + status + lastMode + title +
 *     timestamp into one line; the `sessionId` carried separately on the
 *     payload is what the launcher resolves with.
 *
 * Filtering uses the same fuzzy helper as the palette so the interaction
 * model is consistent.
 */
import type { PromptEntry, SessionPickerItem, SessionPickerPayload } from "./appState.js";
import type { DialogDispatcher } from "./dialogLauncher.js";
import type { SessionSummaryView } from "./sessionIndex.js";
import { answerPrompt, awaitPrompt, newPromptId } from "./promptResolvers.js";
import { reduceHost, type HostAction } from "./reducer.js";

export type SessionPickerDialogChoice = { sessionId: string } | "cancel";

/**
 * Minimal reader surface so tests and the live shell can both drive the
 * launcher. Production callers pass a thin wrapper around
 * `timeline.listSessionSummaries(rootDir)`.
 */
export type SessionIndexReader = {
  listSessionSummaries: () => Promise<ReadonlyArray<SessionSummaryView>>;
};

/**
 * Produce the single-line label shown for one session in the picker. Format:
 *   `session-<short> <status> <lastMode> · <title> · <updatedAt>`
 *
 * The short id is the first 8 hex chars of `sessionId` (matches the convention
 * used elsewhere in the shell — see `session.ts` and `renderModel.ts`).
 */
export const formatSessionPickerLabel = (summary: SessionSummaryView): string => {
  const shortId = summary.sessionId.slice(0, 8);
  const pieces = [
    `session-${shortId}`,
    summary.status,
    summary.lastMode,
    `· ${summary.title}`,
    `· ${summary.updatedAt}`,
  ];
  return pieces.join(" ");
};

/**
 * Build the items list. Sessions come in newest-first (enforced by the
 * index), which is the ordering the picker wants.
 */
export const buildSessionPickerItems = (
  summaries: ReadonlyArray<SessionSummaryView>,
): SessionPickerItem[] =>
  summaries.map((summary) => ({
    sessionId: summary.sessionId,
    label: formatSessionPickerLabel(summary),
  }));

/**
 * Enqueue a `session_picker` prompt entry and await the user's choice.
 *
 * If the session index is empty the launcher resolves immediately with
 * `"cancel"` without enqueueing — no dialog to draw.
 */
export const launchSessionPickerDialog = async (
  dispatcher: DialogDispatcher,
  reader: SessionIndexReader,
): Promise<SessionPickerDialogChoice> => {
  const summaries = await reader.listSessionSummaries();
  if (summaries.length === 0) {
    return "cancel";
  }
  const items = buildSessionPickerItems(summaries);
  const payload: SessionPickerPayload = {
    items,
    input: "",
    selectedIndex: 0,
  };
  const id = newPromptId();
  const entry: PromptEntry = { id, kind: "session_picker", payload };
  const enqueueAction: HostAction = { type: "enqueue_prompt", prompt: entry };
  dispatcher.setState(reduceHost(dispatcher.getState(), enqueueAction));
  try {
    const resolution = await awaitPrompt(id);
    if (resolution.kind !== "answered") {
      return "cancel";
    }
    if (resolution.value.length === 0) {
      return "cancel";
    }
    return { sessionId: resolution.value };
  } finally {
    const dequeueAction: HostAction = { type: "dequeue_prompt", id };
    dispatcher.setState(reduceHost(dispatcher.getState(), dequeueAction));
  }
};

/**
 * Test / interactive-loop entry point: resolve the active session-picker
 * prompt with the supplied session id. Returns the prompt id on success
 * or `null` if the head of the queue is not a session-picker entry.
 */
export const answerSessionPickerDialog = (
  dispatcher: DialogDispatcher,
  sessionId: string,
): string | null => {
  const head = dispatcher.getState().promptQueue[0];
  if (head === undefined || head.kind !== "session_picker") {
    return null;
  }
  return answerPrompt(head.id, sessionId) ? head.id : null;
};
