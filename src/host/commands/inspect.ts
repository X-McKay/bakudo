import { ArtifactStore } from "../../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../../reviewer.js";
import { SessionStore } from "../../sessionStore.js";
import type { InspectTab } from "../appState.js";
import { listTurnApprovals } from "../approvalStore.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { readSessionEventLog } from "../eventLogWriter.js";
import { formatInspectSandbox } from "../inspectFormatter.js";
import { formatInspectTab, type InspectTabName } from "../inspectTabs.js";
import { storageRootFor } from "../sessionRunSupport.js";
import { loadAttemptProvenance } from "../timeline.js";
import { reduceHost } from "../reducer.js";

const KNOWN_TABS: readonly InspectTab[] = [
  "summary",
  "review",
  "provenance",
  "artifacts",
  "approvals",
  "sandbox",
  "logs",
];

const isInspectTab = (value: string): value is InspectTab =>
  (KNOWN_TABS as readonly string[]).includes(value);

export const inspectCommands: readonly HostCommandSpec[] = [
  {
    name: "inspect",
    group: "inspect",
    description:
      "Inspect the active session; pass a tab (summary|review|provenance|artifacts|approvals|logs). `sandbox` is a legacy alias.",
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

      // The legacy `sandbox` tab keeps its narrow formatter; all other tabs
      // route through the six-tab dispatcher so the renderers stay consistent
      // across surfaces.
      let lines: string[];
      if (tab === "sandbox") {
        lines = attempt
          ? formatInspectSandbox({ session, attempt, artifacts })
          : ["Sandbox", "  (no attempts yet)"];
      } else {
        const reviewed: ReviewedTaskResult | undefined =
          attempt?.result === undefined ? undefined : reviewTaskResult(attempt.result);
        const approvals =
          turn === undefined
            ? []
            : await listTurnApprovals(rootDir, session.sessionId, turn.turnId);
        const provenance =
          attempt === undefined
            ? undefined
            : ((await loadAttemptProvenance(rootDir, session.sessionId, attempt.attemptId)) ??
              undefined);
        const envelopes = await readSessionEventLog(rootDir, session.sessionId);
        const events = await store.readTaskEvents(session.sessionId);
        lines = formatInspectTab(tab as InspectTabName, {
          session,
          ...(turn ? { turn } : {}),
          ...(attempt ? { attempt } : {}),
          artifacts,
          events,
          ...(reviewed ? { reviewed } : {}),
          ...(provenance ? { provenance } : {}),
          approvals,
          envelopes,
        });
      }
      for (const line of lines) {
        deps.transcript.push({ kind: "event", label: `inspect:${tab}`, detail: line });
      }
    },
  },
];
