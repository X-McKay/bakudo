import { SessionStore } from "../../sessionStore.js";
import type { SessionRecord } from "../../sessionTypes.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { storageRootFor } from "../orchestration.js";
import { awaitPrompt, newPromptId } from "../promptResolvers.js";
import { reduceHost } from "../reducer.js";

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
    description: "Resume a saved session by id (or the most recently active one).",
    handler: async ({ args, deps }) => {
      const requestedId = args[0];
      const rootDir = storageRootFor(undefined, undefined);
      const store = new SessionStore(rootDir);
      let target: SessionRecord | null = null;
      if (requestedId === undefined) {
        // No-argument resume picks the newest summary from the index
        // (entries are sorted newest `updatedAt` first) and reopens the
        // full session file only for the winner. Avoids touching every
        // session directory on startup.
        const summaries = await store.listSessions();
        const latestId = summaries[0]?.sessionId;
        target = latestId === undefined ? null : await store.loadSession(latestId);
        if (target === null) {
          deps.transcript.push({
            kind: "assistant",
            text: "No saved session to resume.",
            tone: "warning",
          });
          return;
        }
      } else {
        target = await store.loadSession(requestedId);
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
