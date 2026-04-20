import { ArtifactStore } from "../../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../../reviewer.js";
import { SessionStore } from "../../sessionStore.js";
import type { SessionRecord } from "../../sessionTypes.js";
import type { InspectTab } from "../appState.js";
import { listTurnApprovals } from "../approvalStore.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { readSessionEventLog } from "../eventLogWriter.js";
import { formatInspectSandbox } from "../inspectFormatter.js";
import { formatInspectTab, type InspectTabName } from "../inspectTabs.js";
import { stdoutWrite } from "../io.js";
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

const resolveInspectTab = (
  requestedTab: string | undefined,
  invalidMode: "default_summary" | "error",
): InspectTab => {
  if (requestedTab === undefined) {
    return "summary";
  }
  if (isInspectTab(requestedTab)) {
    return requestedTab;
  }
  if (invalidMode === "default_summary") {
    return "summary";
  }
  throw new Error(
    `unknown inspect tab: ${requestedTab} (expected ${KNOWN_TABS.join("|")})`,
  );
};

type InspectView = {
  tab: InspectTab;
  lines: string[];
};

type BuildInspectViewInput = {
  rootDir: string;
  session: SessionRecord;
  requestedTab?: string;
  invalidTabMode: "default_summary" | "error";
};

export const buildInspectView = async (input: BuildInspectViewInput): Promise<InspectView> => {
  const { rootDir, session, requestedTab, invalidTabMode } = input;
  const tab = resolveInspectTab(requestedTab, invalidTabMode);
  const turn = session.turns.at(-1);
  const attempt = turn?.attempts.at(-1);
  const artifactStore = new ArtifactStore(rootDir);
  const artifacts =
    attempt === undefined
      ? []
      : await artifactStore.listTaskArtifacts(session.sessionId, attempt.attemptId);

  if (tab === "sandbox") {
    return {
      tab,
      lines: attempt
        ? formatInspectSandbox({ session, attempt, artifacts })
        : ["Sandbox", "  (no attempts yet)"],
    };
  }

  const reviewed: ReviewedTaskResult | undefined =
    attempt?.result === undefined ? undefined : reviewTaskResult(attempt.result);
  const approvals =
    turn === undefined ? [] : await listTurnApprovals(rootDir, session.sessionId, turn.turnId);
  const provenance =
    attempt === undefined
      ? undefined
      : ((await loadAttemptProvenance(rootDir, session.sessionId, attempt.attemptId)) ?? undefined);
  const store = new SessionStore(rootDir);
  const envelopes = await readSessionEventLog(rootDir, session.sessionId);
  const events = await store.readTaskEvents(session.sessionId);
  return {
    tab,
    lines: formatInspectTab(tab as InspectTabName, {
      session,
      ...(turn ? { turn } : {}),
      ...(attempt ? { attempt } : {}),
      artifacts,
      events,
      ...(reviewed ? { reviewed } : {}),
      ...(provenance ? { provenance } : {}),
      approvals,
      envelopes,
    }),
  };
};

export type InspectCommandInput = {
  sessionId: string;
  requestedTab?: string;
  repoRoot: string;
  storageRoot?: string;
  outputFormat?: "json" | "text";
};

export const runInspectCommand = async (
  input: InspectCommandInput,
): Promise<{ exitCode: number }> => {
  const rootDir = storageRootFor(input.repoRoot, input.storageRoot);
  const store = new SessionStore(rootDir);
  const session = await store.loadSession(input.sessionId);
  if (session === null) {
    throw new Error(`unknown session: ${input.sessionId}`);
  }
  const { tab, lines } = await buildInspectView({
    rootDir,
    session,
    invalidTabMode: "error",
    ...(input.requestedTab !== undefined ? { requestedTab: input.requestedTab } : {}),
  });
  if (input.outputFormat === "json") {
    stdoutWrite(`${JSON.stringify({ sessionId: session.sessionId, tab, lines })}\n`);
  } else {
    stdoutWrite(`${lines.join("\n")}\n`);
  }
  return { exitCode: 0 };
};

export const inspectCommands: readonly HostCommandSpec[] = [
  {
    name: "inspect",
    group: "inspect",
    description:
      "Inspect the active session; pass a tab (summary|review|provenance|artifacts|approvals|logs). `sandbox` is a legacy alias.",
    handler: async ({ args, deps }) => {
      const requestedTab = args[0];
      const sessionId = deps.appState.activeSessionId;
      if (sessionId === undefined) {
        deps.transcript.push({
          kind: "assistant",
          text: "No active session to inspect.",
          tone: "warning",
        });
        return;
      }

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
      const { tab, lines } = await buildInspectView({
        rootDir,
        session,
        invalidTabMode: "default_summary",
        ...(requestedTab !== undefined ? { requestedTab } : {}),
      });
      const turn = session.turns.at(-1);
      const attempt = turn?.attempts.at(-1);
      deps.appState = reduceHost(deps.appState, {
        type: "set_inspect_target",
        sessionId: session.sessionId,
        ...(turn ? { turnId: turn.turnId } : {}),
        ...(attempt ? { attemptId: attempt.attemptId } : {}),
        tab,
      });
      for (const line of lines) {
        deps.transcript.push({ kind: "event", label: `inspect:${tab}`, detail: line });
      }
    },
  },
];
