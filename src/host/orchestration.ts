import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type { ABoxTaskRunner } from "../aboxTaskRunner.js";
import type { ArtifactStore } from "../artifactStore.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type TaskMode, type TaskRequest } from "../protocol.js";
import type { ReviewClassification } from "../resultClassifier.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../reviewer.js";
import type { SessionStore } from "../sessionStore.js";
import type { SessionAttemptRecord, SessionStatus, SessionTurnRecord } from "../sessionTypes.js";
import type { WorkerTaskSpec } from "../workerRuntime.js";
import { dim, renderSection } from "./ansi.js";
import { createSessionEventLogWriter, type EventLogWriter } from "./eventLogWriter.js";
import { projectLegacyWorkerEvent } from "./eventProjector.js";
import { runtimeIo, stdoutWrite } from "./io.js";
import type { HostCliArgs } from "./parsing.js";
import {
  buildDispatchStartedEnvelope,
  buildReviewCompletedEnvelope,
  buildReviewStartedEnvelope,
  formatProgressLine,
  renderDispatchBanner,
  upsertTurnLatestReview,
} from "./orchestrationSupport.js";
import { writeExecutionArtifacts } from "./sessionArtifactWriter.js";

export const storageRootFor = (
  repo: string | undefined,
  explicitRoot: string | undefined,
): string =>
  explicitRoot !== undefined ? resolve(explicitRoot) : resolve(repo ?? ".", ".bakudo", "sessions");

export const repoRootFor = (repo: string | undefined): string => resolve(repo ?? ".");

export const sessionStatusFromReview = (reviewed: ReviewClassification): SessionStatus => {
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

export type EventLogWriterFactory = (storageRoot: string, sessionId: string) => EventLogWriter;

export type ExecuteTaskContext = {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  runner: ABoxTaskRunner;
  sessionId: string;
  turnId: string;
  request: WorkerTaskSpec;
  args: HostCliArgs;
  /** Optional factory for the event log writer. Default: `createSessionEventLogWriter`. */
  eventLogWriterFactory?: EventLogWriterFactory;
  /**
   * Optional hook invoked for every worker progress event. The interactive
   * shell forwards these through the semantic progress coalescer so the
   * main transcript only sees narrations (not raw byte counters).
   */
  onProgress?: (event: import("../workerRuntime.js").WorkerTaskProgressEvent) => void;
};

export const executeTask = async (ctx: ExecuteTaskContext): Promise<ReviewedTaskResult> => {
  const { sessionStore, artifactStore, runner, sessionId, turnId, request, args, onProgress } = ctx;
  const storageRoot = sessionStore.rootDir;
  const writerFactory = ctx.eventLogWriterFactory ?? createSessionEventLogWriter;
  const writer = writerFactory(storageRoot, sessionId);
  try {
    await sessionStore.upsertAttempt(
      sessionId,
      turnId,
      recordAttempt(request, "queued", "queued for sandbox execution"),
    );
    stdoutWrite(renderDispatchBanner(sessionId, request, args.mode));

    await writer.append(
      buildDispatchStartedEnvelope({
        sessionId,
        turnId,
        attemptId: request.taskId,
        goal: request.goal,
        mode: request.mode ?? composerModeToTaskMode(args.mode),
        assumeDangerousSkipPermissions: args.yes ?? false,
      }),
    );

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
          // Parallel sinks: coalescer consumes raw events via onProgress, the
          // projector feeds the persistent event log in lock-step.
          void writer.append(projectLegacyWorkerEvent(sessionId, turnId, request.taskId, event));
          stdoutWrite(formatProgressLine(event));
        },
        onWorkerError: (error) => {
          const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
          stdoutWrite(`[worker-error] ${message}\n`);
        },
      },
    );

    const reviewed = reviewTaskResult(execution.result);

    await writer.append(
      buildReviewStartedEnvelope({ sessionId, turnId, attemptId: request.taskId }),
    );

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

    await writer.append(
      buildReviewCompletedEnvelope({
        sessionId,
        turnId,
        attemptId: request.taskId,
        reviewed,
      }),
    );

    // Drain the buffered writer before short-lived artifact emitters run.
    await writer.flush();
    await writeExecutionArtifacts({
      artifactStore,
      storageRoot,
      sessionId,
      turnId,
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
  } finally {
    await writer.close();
  }
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

/**
 * Re-exported from `./sessionLifecycle.js` so existing callers
 * (`interactive.ts`) don't need to migrate their imports during PR4. The
 * lifecycle helpers live in the new module to keep this file under the
 * 400-line cap.
 */
export { runNewSession, resumeSession } from "./sessionLifecycle.js";
