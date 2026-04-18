import type { SessionRecord } from "../../sessionTypes.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import type { DialogDispatcher } from "../dialogLauncher.js";
import {
  launchSessionPickerDialog,
  type SessionIndexReader,
} from "../launchSessionPickerDialog.js";
import { registerKeybinding } from "../keybindings/hooks.js";
import { storageRootFor } from "../orchestration.js";
import { awaitPrompt, newPromptId } from "../promptResolvers.js";
import { reduceHost } from "../reducer.js";
import * as timeline from "../timeline.js";

const setSessionAsActive = (
  deps: Parameters<HostCommandSpec["handler"]>[0]["deps"],
  session: SessionRecord,
): void => {
  const latestTurn = session.turns.at(-1);
  deps.appState = reduceHost(deps.appState, {
    type: "set_active_session",
    sessionId: session.sessionId,
    ...(latestTurn?.turnId ? { turnId: latestTurn.turnId } : {}),
  });
  deps.transcript.push({
    kind: "assistant",
    text: `Resumed session ${session.sessionId.slice(0, 8)}.`,
    tone: "info",
  });
};

const clearActiveFields = (deps: Parameters<HostCommandSpec["handler"]>[0]["deps"]): void => {
  deps.appState = reduceHost(deps.appState, { type: "set_active_session", sessionId: undefined });
};

export const sessionCommands: readonly HostCommandSpec[] = [
  {
    name: "new",
    group: "session",
    description: "Start a fresh session; clears the active session binding.",
    handler: ({ deps }) => {
      clearActiveFields(deps);
      deps.transcript.push({
        kind: "event",
        label: "session",
        detail: "cleared active session; next prompt starts a new one",
      });
    },
  },
  {
    name: "resume",
    aliases: ["continue"] as const,
    group: "session",
    description: "Resume a session. No arg opens a picker; with an id, resumes that session.",
    handler: async ({ args, deps }) => {
      const requestedId = args[0];
      const rootDir = storageRootFor(undefined, undefined);
      let target: SessionRecord | null = null;
      if (requestedId === undefined) {
        // Phase 5 PR7 — no-arg resume opens the session picker so the user
        // can pick from all saved sessions (newest-first with fuzzy-match).
        const dispatcher: DialogDispatcher = {
          getState: () => deps.appState,
          setState: (next) => {
            deps.appState = next;
          },
        };
        const reader: SessionIndexReader = {
          listSessionSummaries: async () => timeline.listSessionSummaries(rootDir),
        };
        const choice = await launchSessionPickerDialog(dispatcher, reader);
        if (choice === "cancel") {
          deps.transcript.push({
            kind: "assistant",
            text: "No saved session to resume.",
            tone: "warning",
          });
          return;
        }
        target = await timeline.loadSession(rootDir, choice.sessionId);
        if (target === null) {
          deps.transcript.push({
            kind: "assistant",
            text: `No saved session matches "${choice.sessionId}".`,
            tone: "warning",
          });
          return;
        }
      } else {
        target = await timeline.loadSession(rootDir, requestedId);
        if (target === null) {
          deps.transcript.push({
            kind: "assistant",
            text: `No saved session matches "${requestedId}".`,
            tone: "warning",
          });
          return;
        }
      }

      // If an active session already exists and it differs from the requested
      // one, queue a resume_confirm prompt and wait for the answer.
      if (
        deps.appState.activeSessionId !== undefined &&
        deps.appState.activeSessionId !== target.sessionId
      ) {
        const id = newPromptId();
        deps.appState = reduceHost(deps.appState, {
          type: "enqueue_prompt",
          prompt: {
            id,
            kind: "resume_confirm",
            payload: {
              message: `Resume ${target.sessionId.slice(0, 8)} and leave the current session behind?`,
              requestedSessionId: target.sessionId,
            },
          },
        });
        const resolution = await awaitPrompt(id);
        deps.appState = reduceHost(deps.appState, { type: "dequeue_prompt", id });
        if (resolution.kind !== "answered" || !/^(y|yes)$/i.test(resolution.value.trim())) {
          deps.transcript.push({
            kind: "assistant",
            text: "Resume cancelled.",
            tone: "info",
          });
          return;
        }
      }

      setSessionAsActive(deps, target);
    },
  },
  {
    name: "sessions",
    group: "session",
    description: "List saved sessions.",
    handler: () => ({ argv: ["sessions"] }),
  },
];

/**
 * Register the default `history:search` keybinding handler (bound to
 * `Ctrl+R` via `keybindings/defaults.ts`). The handler opens the session
 * picker. Called opportunistically by the interactive shell bootstrap —
 * passing the actual dispatcher is the shell's responsibility.
 *
 * TODO(phase5-pr8): raw-key dispatch is not wired through the
 * readline-based interactive loop yet. Today, `/resume` is the
 * user-reachable surface; the keybinding registration here is a stub so
 * PR8 can switch over without changing call sites.
 */
export const registerSessionPickerKeybinding = (handler: () => void): (() => void) =>
  registerKeybinding("Global", "history:search", handler);
