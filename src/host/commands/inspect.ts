import { ArtifactStore } from "../../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../../reviewer.js";
import { SessionStore } from "../../sessionStore.js";
import type { InspectTab } from "../appState.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import {
  formatInspectArtifacts,
  formatInspectLogs,
  formatInspectReview,
  formatInspectSandbox,
  formatInspectSummary,
} from "../inspectFormatter.js";
import { storageRootFor } from "../orchestration.js";
import { reduceHost } from "../reducer.js";

const KNOWN_TABS: readonly InspectTab[] = ["summary", "review", "artifacts", "sandbox", "logs"];

const isInspectTab = (value: string): value is InspectTab =>
  (KNOWN_TABS as readonly string[]).includes(value);

export const inspectCommands: readonly HostCommandSpec[] = [
  {
    name: "inspect",
    group: "inspect",
    description: "Inspect the active session; pass a tab (summary|review|artifacts|sandbox|logs).",
    handler: async ({ args, deps }) => {
      const requestedTab = args[0];
      const tab: InspectTab =
        requestedTab !== undefined && isInspectTab(requestedTab) ? requestedTab : "summary";
      const sessionId = deps.appState.activeSessionId;
      if (sessionId === undefined) {
        deps.transcript.push({
          kind: "assistant",
          text: "No active session to inspect.",
          tone: "warning",
        });
        return;
      }
      deps.appState = reduceHost(deps.appState, { type: "set_inspect_target", tab });

      const rootDir = storageRootFor(undefined, undefined);
      const store = new SessionStore(rootDir);
      const session = await store.loadSession(sessionId);
      if (session === null) {
        deps.transcript.push({
          kind: "assistant",
          text: `active session ${sessionId.slice(0, 8)} not found on disk`,
          tone: "error",
        });
        return;
      }
      const turn = session.turns.at(-1);
      const attempt = turn?.attempts.at(-1);
      const artifactStore = new ArtifactStore(rootDir);
      const artifacts =
        attempt === undefined
          ? []
          : await artifactStore.listTaskArtifacts(session.sessionId, attempt.attemptId);

      let lines: string[];
      if (tab === "summary") {
        lines = formatInspectSummary({
          session,
          ...(turn ? { turn } : {}),
          ...(attempt ? { attempt } : {}),
        });
      } else if (tab === "review") {
        if (attempt?.result === undefined) {
          lines = ["Review", "  (no reviewed result yet)"];
        } else {
          const reviewed: ReviewedTaskResult = reviewTaskResult(attempt.result);
          lines = formatInspectReview({ session, attempt, reviewed, artifacts });
        }
      } else if (tab === "sandbox") {
        lines = attempt
          ? formatInspectSandbox({ session, attempt, artifacts })
          : ["Sandbox", "  (no attempts yet)"];
      } else if (tab === "artifacts") {
        lines = formatInspectArtifacts({
          session,
          ...(attempt ? { attempt } : {}),
          artifacts,
        });
      } else {
        const events = await store.readTaskEvents(session.sessionId);
        lines = formatInspectLogs({
          session,
          ...(attempt ? { attempt } : {}),
          events,
        });
      }
      for (const line of lines) {
        deps.transcript.push({ kind: "event", label: `inspect:${tab}`, detail: line });
      }
    },
  },
];
