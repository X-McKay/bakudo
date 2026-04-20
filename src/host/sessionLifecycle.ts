import type { AttemptSpec, DispatchPlan } from "../attemptProtocol.js";
import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner } from "../aboxTaskRunner.js";
import { ArtifactStore } from "../artifactStore.js";
import type { TaskRequest } from "../protocol.js";
import { SessionStore } from "../sessionStore.js";
import { createSessionTaskKey } from "../sessionTypes.js";
import { BakudoConfigDefaults, loadConfigCascade } from "./config.js";
import { resolveEnvPolicyForHost } from "./envPolicy.js";
import { executeAttempt } from "./executeAttempt.js";
import { stdoutWrite } from "./io.js";
import type { HostCliArgs } from "./parsing.js";
import { planAttempt } from "./planner.js";
import {
  latestAttempt,
  latestTurn,
  printRunSummary,
  reviewViewFor,
  reviewedOutcomeExitCode,
} from "./printers.js";
import { resolveRedactionPolicyForHost } from "./redaction.js";
import {
  promptForApproval,
  repoRootFor,
  requiresSandboxApproval,
  sessionStatusFromReview,
  storageRootFor,
} from "./sessionRunSupport.js";
import { createAndRunFirstTurn } from "./sessionController.js";
import { emitTurnTransition, findLatestTurnTransition } from "./transitionStore.js";
import { recoverInterruptedApplyIfNeeded } from "./applyRecovery.js";

export const runNewSession = async (args: HostCliArgs): Promise<number> => {
  if (requiresSandboxApproval(args) && !args.yes) {
    const approved = await promptForApproval(
      `Dispatch a ${args.mode} attempt into an abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Dispatch cancelled.\n");
      return 2;
    }
  }

  const result = await createAndRunFirstTurn(args.goal ?? "", args);
  printRunSummary(result.session, result.reviewed);
  return reviewedOutcomeExitCode(result.reviewed);
};

export type ResumeSessionDeps = {
  executeAttemptFn?: typeof executeAttempt;
};

const buildRetrySpec = (spec: AttemptSpec, retryId: string, args: HostCliArgs): AttemptSpec => ({
  ...spec,
  attemptId: retryId,
  taskId: retryId,
  budget: {
    ...spec.budget,
    timeoutSeconds: args.timeoutSeconds,
    maxOutputBytes: args.maxOutputBytes,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
  },
});

const composerModeFromLegacyRequest = (request: TaskRequest): "standard" | "plan" | "autopilot" => {
  if (request.mode === "plan") {
    return "plan";
  }
  return request.assumeDangerousSkipPermissions ? "autopilot" : "standard";
};

const buildRetryPlanFromLegacyRequest = (
  request: TaskRequest,
  retryId: string,
  turnId: string,
  args: HostCliArgs,
): DispatchPlan => {
  const repoRoot = repoRootFor(args.repo);
  const { plan } = planAttempt(
    request.goal,
    composerModeFromLegacyRequest(request),
    {
      sessionId: request.sessionId,
      turnId,
      attemptId: retryId,
      taskId: retryId,
      repoRoot,
      config: BakudoConfigDefaults,
    },
    {
      isExplicitCommand: /^\/run-command\s+/u.test(request.goal),
    },
  );
  return {
    ...plan,
    spec: {
      ...plan.spec,
      turnId,
      cwd: request.cwd ?? repoRoot,
      budget: {
        ...plan.spec.budget,
        timeoutSeconds: args.timeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        heartbeatIntervalMs: args.heartbeatIntervalMs,
      },
    },
  };
};

const resolveRetryDispatch = (
  args: HostCliArgs,
  retryId: string,
  turnId: string,
  attempt: NonNullable<ReturnType<typeof latestAttempt>>,
): { spec: AttemptSpec; plan?: DispatchPlan } => {
  if (attempt.dispatchPlan?.spec !== undefined) {
    const spec = buildRetrySpec(attempt.dispatchPlan.spec, retryId, args);
    return { spec, plan: { ...attempt.dispatchPlan, spec } };
  }
  if (attempt.attemptSpec !== undefined) {
    return { spec: buildRetrySpec(attempt.attemptSpec, retryId, args) };
  }
  if (attempt.request !== undefined) {
    const plan = buildRetryPlanFromLegacyRequest(attempt.request, retryId, turnId, args);
    return { spec: plan.spec, plan };
  }
  throw new Error(
    `no resumable attempt found for session ${args.sessionId} (neither attemptSpec nor request is set)`,
  );
};

export const resumeSession = async (
  args: HostCliArgs,
  deps: ResumeSessionDeps = {},
): Promise<number> => {
  const executeAttemptFn = deps.executeAttemptFn ?? executeAttempt;
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionStore = new SessionStore(rootDir);
  const { merged: resumeHostConfig } = await loadConfigCascade(repoRootFor(args.repo), {});
  const redactionPolicy = resolveRedactionPolicyForHost({
    ...(resumeHostConfig.redaction !== undefined
      ? { configExtra: resumeHostConfig.redaction }
      : {}),
  });
  const artifactStore = new ArtifactStore(rootDir, redactionPolicy);
  await recoverInterruptedApplyIfNeeded({
    sessionStore,
    artifactStore,
    storageRoot: rootDir,
    sessionId: args.sessionId ?? "",
  });
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

  const priorReview = reviewViewFor(turn, attempt);
  if (attempt.candidateState === "candidate_ready" || attempt.candidateState === "needs_confirmation") {
    if (priorReview !== null) {
      printRunSummary(session, priorReview);
    }
    return 2;
  }
  if (attempt.candidateState === "apply_failed") {
    if (priorReview !== null) {
      printRunSummary(session, priorReview);
    }
    return 1;
  }
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

  const envPolicy = resolveEnvPolicyForHost(
    resumeHostConfig.envPolicy?.allowlist !== undefined
      ? { configAllowlist: resumeHostConfig.envPolicy.allowlist }
      : {},
  );
  const runner = new ABoxTaskRunner(new ABoxAdapter(args.aboxBin), undefined, envPolicy);
  const retryId = createSessionTaskKey(session.sessionId, `retry-${turn.attempts.length + 1}`);
  const { spec, plan } = resolveRetryDispatch(args, retryId, turn.turnId, attempt);

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
  const { reviewed, candidateState } = await executeAttemptFn(
    {
      sessionStore,
      artifactStore,
      runner,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      spec,
      args,
    },
    plan,
  );
  const updated = await sessionStore.saveSession({
    ...(await sessionStore.loadSession(session.sessionId))!,
    status: sessionStatusFromReview(reviewed, candidateState),
  });
  printRunSummary(updated, reviewed);
  return reviewedOutcomeExitCode(reviewed);
};
