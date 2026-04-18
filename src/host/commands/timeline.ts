import { randomUUID } from "node:crypto";

import { ArtifactStore } from "../../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../../reviewer.js";
import { SessionStore } from "../../sessionStore.js";
import type { SessionTurnRecord } from "../../sessionTypes.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { readSessionEventLog } from "../eventLogWriter.js";
import { listTurnApprovals } from "../approvalStore.js";
import { formatInspectTab } from "../inspectTabs.js";
import { registerKeybinding } from "../keybindings/hooks.js";
import { storageRootFor } from "../orchestration.js";
import { awaitPrompt, newPromptId } from "../promptResolvers.js";
import { reduceHost } from "../reducer.js";
import { loadAttemptProvenance } from "../timeline.js";
import {
  emitTurnTransition,
  findLatestTurnTransition,
  type TurnTransition,
} from "../transitionStore.js";

/**
 * Phase 5 PR8 — Double-Esc chord in Composer opens the timeline picker.
 * This constant is the action ID the keybindings registry looks up; the
 * `/timeline` slash command dispatches into the same handler.
 */
export const TIMELINE_PICKER_ACTION_ID = "app:timelinePicker" as const;

/**
 * Phase 4 PR4 `/timeline` picker.
 *
 * Design origin: `plans/bakudo-ux/04-provenance-first-inspection-and-approval.md`
 * A4.2 "Timeline Picker". The picker lists the active session's turns newest
 * first and presents two actions per turn: inspect (read-only) or restart
 * (writes a `TurnTransition` with `reason: "user_rewind"` and branches a new
 * turn whose `parentTurnId` is the selected turn).
 *
 * Double-Esc binding is deferred to Phase 5 (reserved-shortcuts workstream);
 * for now the slash command is the sole entry point.
 */

const MAX_GOAL_DISPLAY = 48;

const truncateGoal = (goal: string): string => {
  const trimmed = goal.trim();
  if (trimmed.length <= MAX_GOAL_DISPLAY) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_GOAL_DISPLAY - 1)}…`;
};

const agentProfileFromTurn = (turn: SessionTurnRecord): string => {
  const lastAttempt = turn.attempts.at(-1);
  return typeof lastAttempt?.metadata?.agentProfile === "string"
    ? (lastAttempt.metadata.agentProfile as string)
    : (lastAttempt?.request?.mode ?? turn.mode);
};

/**
 * One row in the rendered picker. Consumers of the headless entry point
 * (`buildTimelineRows`) re-use this shape for tests + future non-slash UIs.
 */
export type TimelinePickerRow = {
  turnId: string;
  status: string;
  agentProfile: string;
  displayGoal: string;
  timestamp: string;
  /** Pre-formatted `turn-N <status> <agent-profile> · <goal> · <timestamp>`. */
  label: string;
};

export const buildTimelineRows = (turns: readonly SessionTurnRecord[]): TimelinePickerRow[] =>
  turns
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((turn) => {
      const agentProfile = agentProfileFromTurn(turn);
      const displayGoal = truncateGoal(turn.prompt);
      const label = `${turn.turnId} ${turn.status} ${agentProfile} · ${displayGoal} · ${turn.updatedAt}`;
      return {
        turnId: turn.turnId,
        status: turn.status,
        agentProfile,
        displayGoal,
        timestamp: turn.updatedAt,
        label,
      };
    });

export type TimelineSelectionAction = "inspect" | "restart";

/**
 * Parse a picker response. Accepted shapes (case-insensitive):
 *   - `inspect <turnId>` — view the turn's summary tab
 *   - `restart <turnId>` — branch a new turn from the selected turn
 *   - `cancel` / empty string — no-op
 */
export const parseTimelineSelection = (
  raw: string,
): { action: TimelineSelectionAction; turnId: string } | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const [first, second] = trimmed.split(/\s+/);
  if (first === undefined || second === undefined) {
    return null;
  }
  const action = first.toLowerCase();
  if (action !== "inspect" && action !== "restart") {
    return null;
  }
  return { action, turnId: second };
};

/**
 * Headless entry point: assemble the lines for the inspect-this-turn action.
 * Shared between the slash handler and the unit tests so tests do not have
 * to stub a command context.
 */
export const inspectTimelineTurn = async (
  rootDir: string,
  sessionId: string,
  turnId: string,
): Promise<string[]> => {
  const store = new SessionStore(rootDir);
  const session = await store.loadSession(sessionId);
  if (session === null) {
    return [`inspect: session ${sessionId} not found on disk`];
  }
  const turn = session.turns.find((entry) => entry.turnId === turnId);
  if (turn === undefined) {
    return [`inspect: turn ${turnId} not found in session ${sessionId}`];
  }
  const attempt = turn.attempts.at(-1);
  const artifactStore = new ArtifactStore(rootDir);
  const artifacts =
    attempt === undefined
      ? []
      : await artifactStore.listTaskArtifacts(session.sessionId, attempt.attemptId);
  const reviewed: ReviewedTaskResult | undefined =
    attempt?.result === undefined ? undefined : reviewTaskResult(attempt.result);
  const approvals = await listTurnApprovals(rootDir, session.sessionId, turn.turnId);
  const provenance =
    attempt === undefined
      ? undefined
      : ((await loadAttemptProvenance(rootDir, session.sessionId, attempt.attemptId)) ?? undefined);
  const envelopes = await readSessionEventLog(rootDir, session.sessionId);
  const events = await store.readTaskEvents(session.sessionId);
  return formatInspectTab("summary", {
    session,
    turn,
    ...(attempt ? { attempt } : {}),
    artifacts,
    events,
    ...(reviewed ? { reviewed } : {}),
    ...(provenance ? { provenance } : {}),
    approvals,
    envelopes,
  });
};

const newTurnId = (): string => `turn-${Date.now()}-${randomUUID().slice(0, 8)}`;

export type TimelineRestartResult = {
  transition: TurnTransition;
  newTurn: SessionTurnRecord;
};

/**
 * Branch a new turn off `parentTurnId` and emit the accompanying
 * `user_rewind` transition. Pure-ish helper suitable for testing: reads +
 * writes via `SessionStore` and `emitTurnTransition` but does not touch the
 * transcript or appState.
 */
export const restartFromTurn = async (
  rootDir: string,
  sessionId: string,
  parentTurnId: string,
): Promise<TimelineRestartResult | null> => {
  const store = new SessionStore(rootDir);
  const session = await store.loadSession(sessionId);
  if (session === null) {
    return null;
  }
  const parent = session.turns.find((entry) => entry.turnId === parentTurnId);
  if (parent === undefined) {
    return null;
  }
  const now = new Date().toISOString();
  const newTurn: SessionTurnRecord = {
    turnId: newTurnId(),
    prompt: parent.prompt,
    mode: parent.mode,
    status: "queued",
    attempts: [],
    createdAt: now,
    updatedAt: now,
    parentTurnId,
  };
  await store.upsertTurn(session.sessionId, newTurn);
  const priorTransition = await findLatestTurnTransition(rootDir, sessionId, parentTurnId);
  const transition = await emitTurnTransition({
    storageRoot: rootDir,
    sessionId: session.sessionId,
    turnId: newTurn.turnId,
    fromStatus: "queued",
    toStatus: "queued",
    reason: "user_rewind",
    ...(priorTransition === null ? {} : { chainId: priorTransition.chainId }),
  });
  return { transition, newTurn };
};

export const timelineCommandSpec: HostCommandSpec = {
  name: "timeline",
  group: "session",
  description:
    "Open the timeline picker: browse turns, inspect read-only, or restart from a prior turn.",
  // Phase 5 PR8: Double-Esc (Composer context) is also bound to
  // `app:timelinePicker`, wired via `launchTimelinePicker`. The slash
  // command and the chord funnel into the same handler.
  handler: async ({ deps }) => {
    const sessionId = deps.appState.activeSessionId;
    if (sessionId === undefined) {
      deps.transcript.push({
        kind: "assistant",
        text: "No active session — start a turn first or `/resume` a saved session.",
        tone: "warning",
      });
      return;
    }
    const rootDir = storageRootFor(undefined, undefined);
    const store = new SessionStore(rootDir);
    const session = await store.loadSession(sessionId);
    if (session === null || session.turns.length === 0) {
      deps.transcript.push({
        kind: "assistant",
        text: `No turns to browse for session ${sessionId.slice(0, 8)}.`,
        tone: "warning",
      });
      return;
    }
    const rows = buildTimelineRows(session.turns);

    // Enqueue the modal picker. The resolver produces a free-form string
    // that `parseTimelineSelection` folds into an (action, turnId) pair.
    const id = newPromptId();
    deps.appState = reduceHost(deps.appState, {
      type: "enqueue_prompt",
      prompt: {
        id,
        kind: "timeline_picker",
        payload: {
          rows,
          sessionId: session.sessionId,
        },
      },
    });
    for (const row of rows) {
      deps.transcript.push({ kind: "event", label: "timeline", detail: row.label });
    }
    const resolution = await awaitPrompt(id);
    deps.appState = reduceHost(deps.appState, { type: "dequeue_prompt", id });
    if (resolution.kind !== "answered") {
      deps.transcript.push({
        kind: "assistant",
        text: "Timeline picker cancelled.",
        tone: "info",
      });
      return;
    }

    const selection = parseTimelineSelection(resolution.value);
    if (selection === null) {
      deps.transcript.push({
        kind: "assistant",
        text: "Timeline: expected `inspect <turnId>` or `restart <turnId>`.",
        tone: "warning",
      });
      return;
    }

    if (selection.action === "inspect") {
      const lines = await inspectTimelineTurn(rootDir, session.sessionId, selection.turnId);
      for (const line of lines) {
        deps.transcript.push({ kind: "event", label: "inspect:summary", detail: line });
      }
      return;
    }

    const result = await restartFromTurn(rootDir, session.sessionId, selection.turnId);
    if (result === null) {
      deps.transcript.push({
        kind: "assistant",
        text: `Timeline: could not restart from ${selection.turnId}.`,
        tone: "error",
      });
      return;
    }
    deps.appState = reduceHost(deps.appState, {
      type: "set_active_session",
      sessionId: session.sessionId,
      turnId: result.newTurn.turnId,
    });
    deps.transcript.push({
      kind: "event",
      label: "timeline",
      detail: `restarted ${result.newTurn.turnId} (parent ${selection.turnId}, chain ${result.transition.chainId})`,
    });
  },
};

/**
 * Register the default `app:timelinePicker` keybinding handler — reached
 * via Double-Esc in the Composer context. Mirrors the palette launcher:
 * the handler is a trampoline the interactive loop calls when the chord
 * fires. Raw-key plumbing lives in the render loop; this module owns the
 * registration surface so tests can assert on it without a real loop.
 *
 * Returns a disposer — callers use it in cleanup paths and tests.
 */
export const launchTimelinePicker = (handler: () => void): (() => void) =>
  registerKeybinding("Composer", TIMELINE_PICKER_ACTION_ID, handler);
