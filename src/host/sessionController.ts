import { randomUUID } from "node:crypto";

import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner } from "../aboxTaskRunner.js";
import { ArtifactStore } from "../artifactStore.js";
import { buildRuntimeConfig, loadConfig } from "../config.js";
import { type ReviewedTaskResult } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import type { SessionRecord, SessionTurnRecord } from "../sessionTypes.js";
import { createSessionTaskKey } from "../sessionTypes.js";
import {
  createTaskSpec,
  executeTask,
  makeInitialTurn,
  repoRootFor,
  sessionStatusFromReview,
  storageRootFor,
} from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";

export type SessionDispatchResult = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  reviewed: ReviewedTaskResult;
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

export const createAndRunFirstTurn = async (
  prompt: string,
  args: HostCliArgs,
): Promise<SessionDispatchResult> => {
  const { sessionStore, artifactStore, runner } = buildRunnerContext(args);
  const sessionId = args.sessionId ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const assumeDangerousSkipPermissions = await resolveAssumeDangerous(args);
  const turnId = "turn-1";

  const session = await sessionStore.createSession({
    sessionId,
    goal: prompt,
    repoRoot: repoRootFor(args.repo),
    assumeDangerousSkipPermissions,
    status: "running",
    turns: [makeInitialTurn(turnId, prompt, args.mode)],
  });

  const attemptId = createSessionTaskKey(session.sessionId, "turn1-attempt-1");
  const request = createTaskSpec(
    session.sessionId,
    attemptId,
    prompt,
    assumeDangerousSkipPermissions,
    args,
  );
  const reviewed = await executeTask({
    sessionStore,
    artifactStore,
    runner,
    sessionId: session.sessionId,
    turnId,
    request,
    args,
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
): Promise<SessionDispatchResult> => {
  const { sessionStore, artifactStore, runner } = buildRunnerContext(args);
  const existing = await sessionStore.loadSession(sessionId);
  if (existing === null) {
    throw new Error(`cannot append turn: unknown session ${sessionId}`);
  }

  const assumeDangerousSkipPermissions = await resolveAssumeDangerous(args);
  const turnId = nextTurnId(existing);
  const turn: SessionTurnRecord = {
    turnId,
    prompt,
    mode: args.mode,
    status: "queued",
    attempts: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await sessionStore.upsertTurn(sessionId, turn);

  const withTurn = await sessionStore.loadSession(sessionId);
  if (withTurn === null) {
    throw new Error(`session disappeared during turn append: ${sessionId}`);
  }
  const attemptId = nextAttemptId(withTurn, turnId);
  const request = createTaskSpec(
    sessionId,
    attemptId,
    prompt,
    assumeDangerousSkipPermissions,
    args,
  );
  await sessionStore.saveSession({ ...withTurn, status: "running" });
  const reviewed = await executeTask({
    sessionStore,
    artifactStore,
    runner,
    sessionId,
    turnId,
    request,
    args,
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
