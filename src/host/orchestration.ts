import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner } from "../aboxTaskRunner.js";
import { ArtifactStore } from "../artifactStore.js";
import { buildRuntimeConfig, loadConfig } from "../config.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type TaskMode, type TaskRequest } from "../protocol.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import type {
  SessionAttemptRecord,
  SessionReviewRecord,
  SessionStatus,
  SessionTurnRecord,
} from "../sessionTypes.js";
import { createSessionTaskKey } from "../sessionTypes.js";
import type { WorkerTaskSpec } from "../workerRuntime.js";
import { bold, dim, renderKeyValue, renderModeChip, renderSection } from "./ansi.js";
import { runtimeIo, stdoutWrite } from "./io.js";
import type { HostCliArgs } from "./parsing.js";
import {
  latestAttempt,
  latestTurn,
  printRunSummary,
  reviewedOutcomeExitCode,
  statusBadge,
} from "./printers.js";
import { writeExecutionArtifacts } from "./sessionArtifactWriter.js";

export const storageRootFor = (
  repo: string | undefined,
  explicitRoot: string | undefined,
): string =>
  explicitRoot !== undefined ? resolve(explicitRoot) : resolve(repo ?? ".", ".bakudo", "sessions");

export const repoRootFor = (repo: string | undefined): string => resolve(repo ?? ".");

export const sessionStatusFromReview = (reviewed: ReviewedTaskResult): SessionStatus => {
  if (reviewed.outcome === "success") {
    return "completed";
  }
  if (reviewed.outcome === "blocked_needs_user") {
    return "awaiting_user";
  }
  if (reviewed.outcome === "policy_denied") {
    return "blocked";
  }
  if (reviewed.outcome === "incomplete_needs_follow_up") {
    return "reviewing";
  }
  return "failed";
};

export const requiresSandboxApproval = (args: HostCliArgs): boolean => args.mode === "build";

export const promptForApproval = async (message: string): Promise<boolean> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const prompt = `${renderSection("Approval")} ${message} ${dim("[y/N]")} `;
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

export const composerModeToTaskMode = (mode: TaskMode | string): TaskMode => {
  if (mode === "plan") {
    return "plan";
  }
  // "standard" and "autopilot" (composer-level) and legacy "build" all map to build.
  return "build";
};

export const createTaskSpec = (
  sessionId: string,
  taskId: string,
  goal: string,
  assumeDangerousSkipPermissions: boolean,
  args: HostCliArgs,
): WorkerTaskSpec => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
  taskId,
  sessionId,
  goal,
  mode: composerModeToTaskMode(args.mode),
  cwd: ".",
  timeoutSeconds: args.timeoutSeconds,
  maxOutputBytes: args.maxOutputBytes,
  heartbeatIntervalMs: args.heartbeatIntervalMs,
  assumeDangerousSkipPermissions,
});

export const recordAttempt = (
  request: TaskRequest,
  status: SessionAttemptRecord["status"],
  lastMessage?: string,
): SessionAttemptRecord => ({
  attemptId: request.taskId,
  request,
  status,
  ...(lastMessage === undefined ? {} : { lastMessage }),
});

const upsertTurnLatestReview = async (
  sessionStore: SessionStore,
  sessionId: string,
  turnId: string,
  latestReview: SessionReviewRecord,
): Promise<void> => {
  const session = await sessionStore.loadSession(sessionId);
  if (session === null) {
    return;
  }
  const turn = session.turns.find((entry) => entry.turnId === turnId);
  if (turn === undefined) {
    return;
  }
  await sessionStore.upsertTurn(sessionId, { ...turn, latestReview });
};

type ProgressEvent = import("../workerRuntime.js").WorkerTaskProgressEvent;

const formatProgressLine = (event: ProgressEvent): string => {
  const stamp = event.timestamp.slice(11, 19);
  const metrics = [
    event.elapsedMs !== undefined ? `elapsed=${event.elapsedMs}ms` : "",
    event.stdoutBytes !== undefined ? `stdout=${event.stdoutBytes}B` : "",
    event.stderrBytes !== undefined ? `stderr=${event.stderrBytes}B` : "",
    event.exitCode !== undefined && event.exitCode !== null ? `exit=${event.exitCode}` : "",
    event.timedOut ? "timed_out=true" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const detail = event.message ? ` ${event.message}` : "";
  const suffix = metrics ? ` ${dim(`(${metrics})`)}` : "";
  return `${dim(`[${stamp}]`)} ${statusBadge(event.status)} ${bold(event.kind)}${detail}${suffix}\n`;
};

const renderDispatchBanner = (
  sessionId: string,
  request: WorkerTaskSpec,
  mode: HostCliArgs["mode"],
): string =>
  [
    "",
    renderSection("Dispatch"),
    `${statusBadge("queued")} ${renderModeChip(request.mode ?? mode)} ${dim("sending task to abox worker")}`,
    renderKeyValue("Session", sessionId),
    renderKeyValue("Task", request.taskId),
    renderKeyValue("Goal", request.goal),
    renderKeyValue("Sandbox", "ephemeral abox worker"),
    "",
  ].join("\n");

export type ExecuteTaskContext = {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  runner: ABoxTaskRunner;
  sessionId: string;
  turnId: string;
  request: WorkerTaskSpec;
  args: HostCliArgs;
  /**
   * Optional hook invoked for every worker progress event. The interactive
   * shell forwards these through the {@link createProgressCoalescer semantic
   * progress coalescer} so the main transcript only sees narrations (not raw
   * byte counters). The legacy log surface continues to use the in-module
   * stdout writer below.
   */
  onProgress?: (event: import("../workerRuntime.js").WorkerTaskProgressEvent) => void;
};

export const executeTask = async (ctx: ExecuteTaskContext): Promise<ReviewedTaskResult> => {
  const { sessionStore, artifactStore, runner, sessionId, turnId, request, args, onProgress } = ctx;
  await sessionStore.upsertAttempt(
    sessionId,
    turnId,
    recordAttempt(request, "queued", "queued for sandbox execution"),
  );
  stdoutWrite(renderDispatchBanner(sessionId, request, args.mode));
  const execution = await runner.runTask(
    request,
    {
      shell: args.shell,
      timeoutSeconds: args.timeoutSeconds,
      maxOutputBytes: args.maxOutputBytes,
      heartbeatIntervalMs: args.heartbeatIntervalMs,
      killGraceMs: args.killGraceMs,
    },
    {
      onEvent: (event) => {
        onProgress?.(event);
        stdoutWrite(formatProgressLine(event));
      },
      onWorkerError: (error) => {
        const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
        stdoutWrite(`[worker-error] ${message}\n`);
      },
    },
  );

  for (const event of execution.events) {
    await sessionStore.appendTaskEvent(sessionId, event);
  }

  const reviewed = reviewTaskResult(execution.result);
  const dispatchCommand = Array.isArray(execution.metadata?.cmd)
    ? execution.metadata.cmd.map((entry) => String(entry))
    : undefined;
  await sessionStore.upsertAttempt(sessionId, turnId, {
    attemptId: request.taskId,
    request,
    status: execution.result.status,
    result: execution.result,
    lastMessage: reviewed.reason,
    metadata: {
      sandboxTaskId: execution.metadata?.taskId,
      aboxCommand: execution.metadata?.cmd,
      reviewedOutcome: reviewed.outcome,
      reviewedAction: reviewed.action,
    },
    ...(dispatchCommand === undefined ? {} : { dispatchCommand }),
  });
  await upsertTurnLatestReview(sessionStore, sessionId, turnId, {
    reviewId: `review-${Date.now()}-${randomUUID().slice(0, 8)}`,
    attemptId: request.taskId,
    outcome: reviewed.outcome,
    action: reviewed.action,
    reason: reviewed.reason,
    reviewedAt: new Date().toISOString(),
  });

  await writeExecutionArtifacts({
    artifactStore,
    sessionId,
    taskId: request.taskId,
    result: execution.result,
    rawOutput: execution.rawOutput,
    ok: execution.ok,
    workerErrorCount: execution.workerErrors.length,
    sandboxTaskId: execution.metadata?.taskId,
    aboxCommand: execution.metadata?.cmd,
    reviewedOutcome: reviewed.outcome,
    reviewedAction: reviewed.action,
  });

  return reviewed;
};

const nowIso = (): string => new Date().toISOString();

export const makeInitialTurn = (
  turnId: string,
  prompt: string,
  mode: string,
): SessionTurnRecord => ({
  turnId,
  prompt,
  mode,
  status: "queued",
  attempts: [],
  createdAt: nowIso(),
  updatedAt: nowIso(),
});

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
