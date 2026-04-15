import { reduceHost } from "../reducer.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { SessionStore } from "../../sessionStore.js";
import { repoRootFor, storageRootFor } from "../orchestration.js";

export const sessionCommands: readonly HostCommandSpec[] = [
  {
    name: "new",
    group: "session",
    description: "Start a fresh session; clears the active session binding.",
    handler: ({ deps }) => {
      deps.appState = reduceHost(deps.appState, {
        type: "set_active_session",
        sessionId: undefined,
      });
      deps.shellState.lastSessionId = undefined as unknown as string;
      deps.shellState.lastTaskId = undefined as unknown as string;
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
      if (requestedId === undefined) {
        const sessions = await store.listSessions();
        const target = sessions[0];
        if (target === undefined) {
          deps.transcript.push({
            kind: "assistant",
            text: "No saved session to resume.",
            tone: "warning",
          });
          return;
        }
        deps.appState = reduceHost(deps.appState, {
          type: "set_active_session",
          sessionId: target.sessionId,
          ...(target.turns.at(-1)?.turnId ? { turnId: target.turns.at(-1)!.turnId } : {}),
        });
        deps.shellState.lastSessionId = target.sessionId;
        deps.transcript.push({
          kind: "assistant",
          text: `Resumed session ${target.sessionId.slice(0, 8)}.`,
          tone: "info",
        });
        return;
      }
      const loaded = await store.loadSession(requestedId);
      if (loaded === null) {
        deps.transcript.push({
          kind: "assistant",
          text: `No saved session matches "${requestedId}".`,
          tone: "warning",
        });
        return;
      }
      deps.appState = reduceHost(deps.appState, {
        type: "set_active_session",
        sessionId: loaded.sessionId,
        ...(loaded.turns.at(-1)?.turnId ? { turnId: loaded.turns.at(-1)!.turnId } : {}),
      });
      deps.shellState.lastSessionId = loaded.sessionId;
      deps.transcript.push({
        kind: "assistant",
        text: `Resumed session ${loaded.sessionId.slice(0, 8)}.`,
        tone: "info",
      });
    },
  },
  {
    name: "sessions",
    group: "session",
    description: "List saved sessions.",
    handler: () => ({ argv: ["sessions"] }),
  },
];

// Silence unused-import warning for repoRootFor (reserved for future /init wiring).
void repoRootFor;
