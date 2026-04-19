import { randomUUID } from "node:crypto";

import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner, attemptSpecToWorkerSpec } from "../aboxTaskRunner.js";
import { ArtifactStore } from "../artifactStore.js";
import { buildRuntimeConfig, loadConfig } from "../config.js";
import { reviewTaskResult } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import { createSessionTaskKey } from "../sessionTypes.js";
import type { WorkerTaskSpec } from "../workerRuntime.js";
import { loadConfigCascade } from "./config.js";
import { resolveEnvPolicyForHost } from "./envPolicy.js";
import { resolveRedactionPolicyForHost } from "./redaction.js";
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
 *
 * @deprecated Uses the legacy createTaskSpec → executeTask path. Phase 6
 * should migrate this to planAttempt → executeAttempt.
 */
export const runNewSession = async (args: HostCliArgs): Promise<number> => {
  const fileConfig = await loadConfig(args.config);
  const runtimeConfig = buildRuntimeConfig(fileConfig);
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionId = args.sessionId ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const assumeDangerousSkipPermissions =
    args.mode === "build" ? runtimeConfig.assumeDangerousSkipPermissions : false;
  const sessionStore = new SessionStore(rootDir);
  // Phase 6 W5: resolve env-passthrough policy from the host config cascade
  // + BAKUDO_ENV_ALLOWLIST override (plan Default Rule 362). Wave 6c PR7:
  // also resolve the effective redaction policy (carryover #7) and pass it
  // into the artifact store so user-configured patterns are honored.
  const { merged: hostConfig } = await loadConfigCascade(repoRootFor(args.repo), {});
  const envPolicy = resolveEnvPolicyForHost(
    hostConfig.envPolicy?.allowlist !== undefined
      ? { configAllowlist: hostConfig.envPolicy.allowlist }
      : {},
  );
  const redactionPolicy = resolveRedactionPolicyForHost({
    ...(hostConfig.redaction !== undefined ? { configExtra: hostConfig.redaction } : {}),
  });
  const artifactStore = new ArtifactStore(rootDir, redactionPolicy);
  const runner = new ABoxTaskRunner(new ABoxAdapter(args.aboxBin, args.repo), undefined, envPolicy);

  if (requiresSandboxApproval(args) && !args.yes) {
    const approved = await promptForApproval(
      `Dispatch a ${args.mode} attempt into an abox sandbox with dangerous-skip-permissions?`,
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

/**
 * @deprecated Uses the legacy executeTask path. Phase 6 should migrate this
 * to planAttempt → executeAttempt.
 */
export type ResumeSessionDeps = {
  executeTaskFn?: typeof executeTask;
};

export const resumeSession = async (
  args: HostCliArgs,
  deps: ResumeSessionDeps = {},
): Promise<number> => {
  const executeTaskFn = deps.executeTaskFn ?? executeTask;
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionStore = new SessionStore(rootDir);
  // Wave 6c PR7 carryover #7: effective redaction policy resolved up-front
  // so the artifact store scrubs per the user's configured patterns. The
  // env-passthrough resolution is kept co-located below to preserve the
  // existing call-ordering shape.
  const { merged: resumeHostConfigEarly } = await loadConfigCascade(repoRootFor(args.repo), {});
  const redactionPolicyResume = resolveRedactionPolicyForHost({
    ...(resumeHostConfigEarly.redaction !== undefined
      ? { configExtra: resumeHostConfigEarly.redaction }
      : {}),
  });
  const artifactStore = new ArtifactStore(rootDir, redactionPolicyResume);
  const session = await sessionStore.loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const turn = latestTurn(session);
  if (turn === undefined) {
    throw new Error(`no resumable turn found for session ${session.sessionId}`);
  }
  const attempt = latestAttempt(turn, args.taskId);
  if (attempt === undefined) {
    throw new Error(`no resumable attempt found for session ${session.sessionId}`);
  }
  const baseRequest =
    attempt.dispatchPlan?.spec !== undefined
      ? attemptSpecToWorkerSpec(attempt.dispatchPlan.spec)
      : attempt.attemptSpec !== undefined
        ? attemptSpecToWorkerSpec(attempt.attemptSpec)
      : attempt.request;
  if (baseRequest === undefined) {
    throw new Error(
      `no resumable attempt found for session ${session.sessionId} (neither attemptSpec nor request is set)`,
    );
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
      `Re-dispatch attempt ${attempt.attemptId} into an abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Resume cancelled.\n");
      return 2;
    }
  }

  // Phase 6 W5: same env-policy resolution as the new-session entry above.
  // Reuse the cascade loaded earlier for the redaction policy so the two
  // factories see the same merged config layer.
  const envPolicyResume = resolveEnvPolicyForHost(
    resumeHostConfigEarly.envPolicy?.allowlist !== undefined
      ? { configAllowlist: resumeHostConfigEarly.envPolicy.allowlist }
      : {},
  );
  const runner = new ABoxTaskRunner(
    new ABoxAdapter(args.aboxBin, args.repo),
    undefined,
    envPolicyResume,
  );
  const retryId = createSessionTaskKey(session.sessionId, `retry-${turn.attempts.length + 1}`);
  const request: WorkerTaskSpec = {
    ...baseRequest,
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
  const reviewed = await executeTaskFn({
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
