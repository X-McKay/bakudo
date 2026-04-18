import { randomUUID } from "node:crypto";

import type { ABoxTaskRunner, TaskExecutionRecord } from "../aboxTaskRunner.js";
import type { ArtifactStore } from "../artifactStore.js";
import type { AttemptExecutionResult, AttemptSpec } from "../attemptProtocol.js";
import type { TaskMode } from "../protocol.js";
import { type ReviewedAttemptResult, reviewAttemptResult } from "../reviewer.js";
import type { SessionStore } from "../sessionStore.js";
import type { WorkerTaskProgressEvent } from "../workerRuntime.js";
import type { ComposerMode } from "./appState.js";
import { createSessionEventLogWriter } from "./eventLogWriter.js";
import { projectLegacyWorkerEvent } from "./eventProjector.js";
import { stdoutWrite } from "./io.js";
import type { EventLogWriterFactory } from "./orchestration.js";
import {
  buildDispatchStartedEnvelope,
  buildReviewCompletedEnvelope,
  buildReviewStartedEnvelope,
  formatProgressLine,
  upsertTurnLatestReview,
} from "./orchestrationSupport.js";
import type { HostCliArgs } from "./parsing.js";
import { recordProvenanceFinalize, recordProvenanceStart } from "./provenanceProducer.js";
import { writeExecutionArtifacts } from "./sessionArtifactWriter.js";

/**
 * Infer the host-level {@link ComposerMode} from the worker-level AttemptSpec.
 * `AttemptSpec.mode` is `"build" | "plan"`; `allowAllTools` means the host
 * was in Autopilot when the spec was compiled. Mirrors the inverse mapping
 * in `src/host/attemptCompiler.ts`.
 */
const inferComposerMode = (spec: AttemptSpec): ComposerMode => {
  if (spec.permissions.allowAllTools) {
    return "autopilot";
  }
  if (spec.mode === "plan") {
    return "plan";
  }
  return "standard";
};

const PROFILE_NAME: Record<ComposerMode, string> = {
  standard: "standard",
  plan: "plan",
  autopilot: "autopilot",
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type ExecuteAttemptContext = {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  runner: ABoxTaskRunner;
  sessionId: string;
  turnId: string;
  spec: AttemptSpec;
  args: HostCliArgs;
  eventLogWriterFactory?: EventLogWriterFactory;
  onProgress?: (event: WorkerTaskProgressEvent) => void;
};

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

/**
 * Build an {@link AttemptExecutionResult} from the worker pipeline output.
 * Maps legacy {@link WorkerTaskResult} fields into the Phase 3 shape.
 */
export const toAttemptExecutionResult = (
  spec: AttemptSpec,
  execution: TaskExecutionRecord,
): AttemptExecutionResult => {
  const result = execution.result;
  const startedAt = result.startedAt ?? result.finishedAt;
  return {
    schemaVersion: 3,
    attemptId: spec.attemptId,
    taskKind: spec.taskKind,
    status: result.status === "succeeded" ? "succeeded" : "failed",
    summary: result.summary,
    exitCode: result.exitCode,
    startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs ?? 0,
    artifacts: result.artifacts ?? [],
  };
};

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Execute an {@link AttemptSpec} through the abox worker pipeline. This is
 * the Phase 3 replacement for `executeTask` when dealing with
 * planner-produced specs. Legacy `executeTask` is preserved for backward
 * compatibility with specs that lack `taskKind`.
 */
export const executeAttempt = async (
  ctx: ExecuteAttemptContext,
): Promise<{ reviewed: ReviewedAttemptResult; executionResult: AttemptExecutionResult }> => {
  const { sessionStore, artifactStore, runner, sessionId, turnId, spec, args, onProgress } = ctx;
  const storageRoot = sessionStore.rootDir;
  const writerFactory = ctx.eventLogWriterFactory ?? createSessionEventLogWriter;
  const writer = writerFactory(storageRoot, sessionId);
  try {
    await sessionStore.upsertAttempt(sessionId, turnId, {
      attemptId: spec.attemptId,
      status: "queued",
      lastMessage: "queued for sandbox execution",
      attemptSpec: spec,
    });

    await writer.append(
      buildDispatchStartedEnvelope({
        sessionId,
        turnId,
        attemptId: spec.attemptId,
        goal: spec.prompt,
        mode: spec.mode as TaskMode,
        assumeDangerousSkipPermissions: spec.permissions.allowAllTools,
      }),
    );

    const composerMode = inferComposerMode(spec);
    const started = await recordProvenanceStart({
      storageRoot,
      sessionId,
      turnId,
      attemptId: spec.attemptId,
      repoRoot: spec.cwd,
      workerEngine: spec.execution.engine,
      composerMode,
      taskMode: spec.mode,
      agentProfile: {
        name: PROFILE_NAME[composerMode],
        autopilot: composerMode === "autopilot",
      },
      permissionRulesSnapshot: spec.permissions.rules,
      envAllowlist: [],
    });
    await writer.append(started.envelope);

    const execution = await runner.runAttempt(
      spec,
      {
        shell: args.shell,
        timeoutSeconds: spec.budget.timeoutSeconds,
        maxOutputBytes: spec.budget.maxOutputBytes,
        heartbeatIntervalMs: spec.budget.heartbeatIntervalMs,
        killGraceMs: args.killGraceMs,
      },
      {
        onEvent: (event) => {
          onProgress?.(event);
          void writer.append(projectLegacyWorkerEvent(sessionId, turnId, spec.attemptId, event));
          stdoutWrite(formatProgressLine(event));
        },
        onWorkerError: (error) => {
          const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
          stdoutWrite(`[worker-error] ${message}\n`);
        },
      },
    );

    const executionResult = toAttemptExecutionResult(spec, execution);
    const reviewed = reviewAttemptResult(spec, executionResult);

    const dispatchCommand = Array.isArray(execution.metadata?.cmd)
      ? execution.metadata.cmd.map((entry) => String(entry))
      : undefined;

    const finalized = await recordProvenanceFinalize({
      storageRoot,
      prior: started.record,
      ...(dispatchCommand !== undefined ? { dispatchCommand } : {}),
      ...(typeof execution.metadata?.taskId === "string"
        ? { sandboxTaskId: execution.metadata.taskId }
        : {}),
      exit: {
        exitCode: execution.result.exitCode ?? null,
        exitSignal: null,
        timedOut: false,
        elapsedMs: execution.result.durationMs ?? 0,
      },
    });
    await writer.append(finalized.envelope);

    await writer.append(
      buildReviewStartedEnvelope({ sessionId, turnId, attemptId: spec.attemptId }),
    );
    await sessionStore.upsertAttempt(sessionId, turnId, {
      attemptId: spec.attemptId,
      status: execution.result.status,
      result: execution.result,
      lastMessage: reviewed.reason,
      attemptSpec: spec,
      metadata: {
        sandboxTaskId: execution.metadata?.taskId,
        aboxCommand: execution.metadata?.cmd,
      },
      ...(dispatchCommand === undefined ? {} : { dispatchCommand }),
    });
    await upsertTurnLatestReview(sessionStore, sessionId, turnId, {
      reviewId: `review-${Date.now()}-${randomUUID().slice(0, 8)}`,
      attemptId: spec.attemptId,
      intentId: spec.intentId,
      outcome: reviewed.outcome,
      action: reviewed.action,
      reason: reviewed.reason,
      reviewedAt: new Date().toISOString(),
    });

    await writer.append(
      buildReviewCompletedEnvelope({ sessionId, turnId, attemptId: spec.attemptId, reviewed }),
    );

    await writer.flush();
    await writeExecutionArtifacts({
      artifactStore,
      storageRoot,
      sessionId,
      turnId,
      taskId: spec.taskId,
      result: execution.result,
      rawOutput: execution.rawOutput,
      ok: execution.ok,
      workerErrorCount: execution.workerErrors.length,
      sandboxTaskId: execution.metadata?.taskId,
      aboxCommand: execution.metadata?.cmd,
      reviewedOutcome: reviewed.outcome,
      reviewedAction: reviewed.action,
    });

    return { reviewed, executionResult };
  } finally {
    await writer.close();
  }
};
