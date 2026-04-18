import { randomUUID } from "node:crypto";

import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner } from "../aboxTaskRunner.js";
import { ArtifactStore } from "../artifactStore.js";
import { buildRuntimeConfig, loadConfig } from "../config.js";
import { reviewTaskResult } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import { createSessionTaskKey } from "../sessionTypes.js";
import type { WorkerTaskSpec } from "../workerRuntime.js";
import { stdoutWrite } from "./io.js";
import {
  createTaskSpec,
  executeTask,
  makeInitialTurn,
  promptForApproval,
  repoRootFor,
  requiresSandboxApproval,
  sessionStatusFromReview,
  storageRootFor,
} from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";
import { latestAttempt, latestTurn, printRunSummary, reviewedOutcomeExitCode } from "./printers.js";
import { emitTurnTransition, findLatestTurnTransition } from "./transitionStore.js";

/**
 * CLI entry for non-interactive `bakudo plan/build/run` — creates a new
 * session with a single turn and runs one attempt through `executeTask`.
 * Split out of `orchestration.ts` so the file can stay within the 400-line
 * cap while growing the PR4 DI + artifact writer surface.
 */
export const runNewSession = async (args: HostCliArgs): Promise<number> => {
  const fileConfig = await loadConfig(args.config);
  const runtimeConfig = buildRuntimeConfig(fileConfig);
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionId = args.sessionId ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const assumeDangerousSkipPermissions =
    args.mode === "build" ? runtimeConfig.assumeDangerousSkipPermissions : false;
  const sessionStore = new SessionStore(rootDir);
  const artifactStore = new ArtifactStore(rootDir);
  const runner = new ABoxTaskRunner(new ABoxAdapter(args.aboxBin, args.repo));

  if (requiresSandboxApproval(args) && !args.yes) {
    const approved = await promptForApproval(
      `Dispatch a ${args.mode} task into an ephemeral abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Dispatch cancelled.\n");
      return 2;
    }
  }

  const turnId = "turn-1";
  const session = await sessionStore.createSession({
    sessionId,
    goal: args.goal ?? "",
    repoRoot: repoRootFor(args.repo),
    assumeDangerousSkipPermissions,
    status: "planned",
    turns: [makeInitialTurn(turnId, args.goal ?? "", args.mode)],
  });
  await emitTurnTransition({
    storageRoot: rootDir,
    sessionId: session.sessionId,
    turnId,
    fromStatus: "queued",
    toStatus: "queued",
    reason: "next_turn",
  });

  const taskId = createSessionTaskKey(session.sessionId, "task-1");
  const request = createTaskSpec(
    session.sessionId,
    taskId,
    args.goal ?? "",
    assumeDangerousSkipPermissions,
    args,
  );
  await sessionStore.saveSession({ ...session, status: "running" });
  const reviewed = await executeTask({
    sessionStore,
    artifactStore,
    runner,
    sessionId: session.sessionId,
    turnId,
    request,
    args,
  });

  const finalSession = await sessionStore.saveSession({
    ...(await sessionStore.loadSession(session.sessionId))!,
    status: sessionStatusFromReview(reviewed),
  });
  printRunSummary(finalSession, reviewed);
  return reviewedOutcomeExitCode(reviewed);
};

export const resumeSession = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionStore = new SessionStore(rootDir);
  const artifactStore = new ArtifactStore(rootDir);
  const session = await sessionStore.loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const turn = latestTurn(session);
  if (turn === undefined) {
    throw new Error(`no resumable turn found for session ${session.sessionId}`);
  }
  const attempt = latestAttempt(turn, args.taskId);
  if (attempt === undefined || attempt.request === undefined) {
    throw new Error(`no resumable attempt found for session ${session.sessionId}`);
  }

  const priorReview = attempt.result === undefined ? null : reviewTaskResult(attempt.result);
  if (priorReview?.outcome === "success") {
    printRunSummary(session, priorReview);
    return 0;
  }
  if (priorReview?.outcome === "blocked_needs_user" || priorReview?.outcome === "policy_denied") {
    printRunSummary(session, priorReview);
    return reviewedOutcomeExitCode(priorReview);
  }

  if (requiresSandboxApproval(args) && !args.yes) {
    const approved = await promptForApproval(
      `Re-dispatch task ${attempt.attemptId} into an ephemeral abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Resume cancelled.\n");
      return 2;
    }
  }

  const runner = new ABoxTaskRunner(new ABoxAdapter(args.aboxBin, args.repo));
  const retryId = createSessionTaskKey(session.sessionId, `retry-${turn.attempts.length + 1}`);
  const request: WorkerTaskSpec = {
    ...attempt.request,
    taskId: retryId,
    timeoutSeconds: args.timeoutSeconds,
    maxOutputBytes: args.maxOutputBytes,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
  };

  const previousTransition = await findLatestTurnTransition(
    rootDir,
    session.sessionId,
    turn.turnId,
  );
  await emitTurnTransition({
    storageRoot: rootDir,
    sessionId: session.sessionId,
    turnId: turn.turnId,
    fromStatus: "reviewing",
    toStatus: "running",
    reason: "user_retry",
    ...(previousTransition?.chainId ? { chainId: previousTransition.chainId } : {}),
    depth: (previousTransition?.depth ?? 0) + 1,
  });

  await sessionStore.saveSession({ ...session, status: "running" });
  const reviewed = await executeTask({
    sessionStore,
    artifactStore,
    runner,
    sessionId: session.sessionId,
    turnId: turn.turnId,
    request,
    args,
  });
  const updated = await sessionStore.saveSession({
    ...(await sessionStore.loadSession(session.sessionId))!,
    status: sessionStatusFromReview(reviewed),
  });
  printRunSummary(updated, reviewed);
  return reviewedOutcomeExitCode(reviewed);
};
