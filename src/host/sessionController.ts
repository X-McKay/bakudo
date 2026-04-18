import { randomUUID } from "node:crypto";

import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner } from "../aboxTaskRunner.js";
import { ArtifactStore } from "../artifactStore.js";
import { buildRuntimeConfig, loadConfig } from "../config.js";
import { createSessionEvent } from "../protocol.js";
import type { ReviewClassification } from "../resultClassifier.js";
import { SessionStore } from "../sessionStore.js";
import type { SessionRecord, SessionTurnRecord } from "../sessionTypes.js";
import { createSessionTaskKey } from "../sessionTypes.js";
import type { WorkerTaskProgressEvent } from "../workerRuntime.js";
import type { ComposerMode } from "./appState.js";
import { BakudoConfigDefaults } from "./config.js";
import { emitSessionEvent } from "./eventLogWriter.js";
import { executeAttempt } from "./executeAttempt.js";
import {
  type EventLogWriterFactory,
  makeInitialTurn,
  repoRootFor,
  sessionStatusFromReview,
  storageRootFor,
} from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";
import { planAttempt } from "./planner.js";
import { parseTokenBudget } from "./tokenBudget.js";
import { emitTurnTransition } from "./transitionStore.js";

export type SessionDispatchResult = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  reviewed: ReviewClassification;
  session: SessionRecord;
};

const nowIso = (): string => new Date().toISOString();

const buildRunnerContext = (
  args: HostCliArgs,
): { sessionStore: SessionStore; artifactStore: ArtifactStore; runner: ABoxTaskRunner } => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  return {
    sessionStore: new SessionStore(rootDir),
    artifactStore: new ArtifactStore(rootDir),
    runner: new ABoxTaskRunner(new ABoxAdapter(args.aboxBin, args.repo)),
  };
};

const nextTurnId = (session: SessionRecord): string => `turn-${session.turns.length + 1}`;

const nextAttemptId = (session: SessionRecord, turnId: string): string => {
  const turn = session.turns.find((entry) => entry.turnId === turnId);
  const attemptCount = turn ? turn.attempts.length : 0;
  return createSessionTaskKey(
    session.sessionId,
    `turn${turnId.replace(/^turn-/, "")}-attempt-${attemptCount + 1}`,
  );
};

const resolveAssumeDangerous = async (args: HostCliArgs): Promise<boolean> => {
  if (args.mode !== "build") {
    return false;
  }
  const fileConfig = await loadConfig(args.config);
  const runtimeConfig = buildRuntimeConfig(fileConfig);
  return runtimeConfig.assumeDangerousSkipPermissions;
};

/** Map the worker-facing TaskMode back to a ComposerMode for the planner. */
const taskModeToComposerMode = (mode: string, autoApprove: boolean): ComposerMode => {
  if (mode === "plan") return "plan";
  return autoApprove ? "autopilot" : "standard";
};

export type SessionDispatchOptions = {
  onProgress?: (event: WorkerTaskProgressEvent) => void;
  eventLogWriterFactory?: EventLogWriterFactory;
};

export const createAndRunFirstTurn = async (
  prompt: string,
  args: HostCliArgs,
  options: SessionDispatchOptions = {},
): Promise<SessionDispatchResult> => {
  const { sessionStore, artifactStore, runner } = buildRunnerContext(args);
  const sessionId = args.sessionId ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const assumeDangerousSkipPermissions = await resolveAssumeDangerous(args);
  const turnId = "turn-1";

  // Parse inline token budget (e.g. "+500k fix the bug").
  const { budget, cleanedPrompt } = parseTokenBudget(prompt);
  const effectivePrompt = budget !== null ? cleanedPrompt : prompt;

  const initialTurn = makeInitialTurn(turnId, effectivePrompt, args.mode);
  if (budget !== null) {
    initialTurn.tokenBudget = budget.tokens;
  }
  // TODO(Phase 3): worker-side budget enforcement — stop at limit, prompt "continue?".

  const session = await sessionStore.createSession({
    sessionId,
    goal: effectivePrompt,
    repoRoot: repoRootFor(args.repo),
    assumeDangerousSkipPermissions,
    status: "running",
    turns: [initialTurn],
  });

  const storageRoot = storageRootFor(args.repo, args.storageRoot);
  await emitTurnTransition({
    storageRoot,
    sessionId: session.sessionId,
    turnId,
    fromStatus: "queued",
    toStatus: "queued",
    reason: "next_turn",
  });
  await emitSessionEvent(
    storageRoot,
    session.sessionId,
    createSessionEvent({
      kind: "host.turn_queued",
      sessionId: session.sessionId,
      turnId,
      actor: "host",
      payload: { turnId, prompt: effectivePrompt, mode: args.mode },
    }),
  );

  const attemptId = createSessionTaskKey(session.sessionId, "turn1-attempt-1");
  const composerMode = taskModeToComposerMode(args.mode, args.yes ?? false);
  const repoRoot = repoRootFor(args.repo);
  const plannerOpts = budget !== null ? { tokenBudget: budget.tokens } : {};
  const { spec } = planAttempt(
    effectivePrompt,
    composerMode,
    {
      sessionId: session.sessionId,
      turnId,
      attemptId,
      taskId: attemptId,
      repoRoot,
      config: BakudoConfigDefaults,
    },
    plannerOpts,
  );

  const { reviewed } = await executeAttempt({
    sessionStore,
    artifactStore,
    runner,
    sessionId: session.sessionId,
    turnId,
    spec,
    args,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.eventLogWriterFactory
      ? { eventLogWriterFactory: options.eventLogWriterFactory }
      : {}),
  });

  const updated = await sessionStore.saveSession({
    ...(await sessionStore.loadSession(session.sessionId))!,
    status: sessionStatusFromReview(reviewed),
  });

  return { sessionId: updated.sessionId, turnId, attemptId, reviewed, session: updated };
};

export const appendTurnToActiveSession = async (
  sessionId: string,
  prompt: string,
  args: HostCliArgs,
  options: SessionDispatchOptions = {},
): Promise<SessionDispatchResult> => {
  const { sessionStore, artifactStore, runner } = buildRunnerContext(args);
  const existing = await sessionStore.loadSession(sessionId);
  if (existing === null) {
    throw new Error(`cannot append turn: unknown session ${sessionId}`);
  }

  const turnId = nextTurnId(existing);
  const previousTurn = existing.turns.at(-1);

  // Parse inline token budget.
  const { budget, cleanedPrompt } = parseTokenBudget(prompt);
  const effectivePrompt = budget !== null ? cleanedPrompt : prompt;
  // TODO(Phase 3): worker-side budget enforcement — stop at limit, prompt "continue?".

  const turn: SessionTurnRecord = {
    turnId,
    prompt: effectivePrompt,
    mode: args.mode,
    status: "queued",
    attempts: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...(budget !== null ? { tokenBudget: budget.tokens } : {}),
  };
  await sessionStore.upsertTurn(sessionId, turn);
  const storageRoot = storageRootFor(args.repo, args.storageRoot);
  await emitTurnTransition({
    storageRoot,
    sessionId,
    turnId,
    fromStatus: previousTurn?.status ?? "queued",
    toStatus: "queued",
    reason: "next_turn",
  });
  await emitSessionEvent(
    storageRoot,
    sessionId,
    createSessionEvent({
      kind: "host.turn_queued",
      sessionId,
      turnId,
      actor: "host",
      payload: { turnId, prompt: effectivePrompt, mode: args.mode },
    }),
  );

  const withTurn = await sessionStore.loadSession(sessionId);
  if (withTurn === null) {
    throw new Error(`session disappeared during turn append: ${sessionId}`);
  }
  const attemptId = nextAttemptId(withTurn, turnId);
  const composerMode = taskModeToComposerMode(args.mode, args.yes ?? false);
  const repoRoot = repoRootFor(args.repo);
  const appendPlannerOpts = budget !== null ? { tokenBudget: budget.tokens } : {};
  const { spec } = planAttempt(
    effectivePrompt,
    composerMode,
    {
      sessionId,
      turnId,
      attemptId,
      taskId: attemptId,
      repoRoot,
      config: BakudoConfigDefaults,
    },
    appendPlannerOpts,
  );

  await sessionStore.saveSession({ ...withTurn, status: "running" });
  const { reviewed } = await executeAttempt({
    sessionStore,
    artifactStore,
    runner,
    sessionId,
    turnId,
    spec,
    args,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.eventLogWriterFactory
      ? { eventLogWriterFactory: options.eventLogWriterFactory }
      : {}),
  });

  const updated = await sessionStore.saveSession({
    ...(await sessionStore.loadSession(sessionId))!,
    status: sessionStatusFromReview(reviewed),
  });

  return { sessionId, turnId, attemptId, reviewed, session: updated };
};

export const resumeNamedSession = async (
  sessionId: string,
  args: HostCliArgs,
): Promise<SessionRecord | null> => {
  const { sessionStore } = buildRunnerContext(args);
  return sessionStore.loadSession(sessionId);
};
