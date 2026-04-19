import { randomUUID } from "node:crypto";

import type { ABoxTaskRunner, TaskExecutionRecord } from "../aboxTaskRunner.js";
import type { ArtifactStore } from "../artifactStore.js";
import type { AttemptExecutionResult, AttemptSpec, DispatchPlan } from "../attemptProtocol.js";
import type { TaskMode } from "../protocol.js";
import { type ReviewedAttemptResult, reviewAttemptResult } from "../reviewer.js";
import type { SessionStore } from "../sessionStore.js";
import type { WorkerTaskProgressEvent } from "../workerRuntime.js";
import type { ComposerMode } from "./appState.js";
import {
  extractIntendedOperation,
  resolveApprovalBeforeDispatch,
  type ApprovalProducerOutcome,
  type ResolveApprovalInput,
} from "./approvalProducer.js";
import type { DialogDispatcher } from "./dialogLauncher.js";
import { createSessionEventLogWriter, type EventLogWriter } from "./eventLogWriter.js";
import { projectLegacyWorkerEvent } from "./eventProjector.js";
import type { HookRegistry } from "./hooks.js";
import { startDispatchProgress } from "./dispatchProgress.js";
import { stdoutWrite } from "./io.js";
import { discoverWorktree } from "./worktreeDiscovery.js";
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
import { WorkerProtocolMismatchError } from "./errors.js";
import { persistProtocolMismatchAttempt } from "./protocolMismatchPersist.js";

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
  spec?: AttemptSpec;
  args: HostCliArgs;
  eventLogWriterFactory?: EventLogWriterFactory;
  onProgress?: (event: WorkerTaskProgressEvent) => void;
  /**
   * Phase 4 PR7 — optional approval pipeline plumbing. When provided,
   * `executeAttempt` calls `resolveApprovalBeforeDispatch` before starting
   * the worker so deny rules short-circuit and ask-rules surface an
   * interactive dialog. Omitted in non-interactive contexts (CLI one-shots,
   * most unit tests) — approval is a no-op there.
   */
  approvalDispatcher?: DialogDispatcher;
  hookRegistry?: HookRegistry;
  /** Root used for the durable workspace allowlist; defaults to `spec.cwd`. */
  repoRoot?: string;
  /** Override for `resolveApprovalBeforeDispatch`; test hook. */
  approvalOverride?: (input: ResolveApprovalInput) => Promise<ApprovalProducerOutcome>;
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
  plan?: DispatchPlan,
): Promise<{ reviewed: ReviewedAttemptResult; executionResult: AttemptExecutionResult }> => {
  const spec = plan?.spec ?? ctx.spec;
  if (spec === undefined) {
    throw new Error("executeAttempt requires either plan.spec or ctx.spec");
  }
  const { sessionStore, artifactStore, runner, sessionId, turnId, args, onProgress } = ctx;
  const storageRoot = sessionStore.rootDir;
  const writerFactory = ctx.eventLogWriterFactory ?? createSessionEventLogWriter;
  const writer = writerFactory(storageRoot, sessionId);
  try {
    await sessionStore.upsertAttempt(sessionId, turnId, {
      attemptId: spec.attemptId,
      status: "queued",
      lastMessage: "queued for sandbox execution",
      attemptSpec: spec,
      ...(plan !== undefined ? { dispatchPlan: plan } : {}),
    });

    const composerMode = inferComposerMode(spec);

    // Phase 4 PR7 — run the approval producer before any dispatch envelopes
    // so deny/ask decisions short-circuit the worker entirely. The producer
    // emits its own `host.approval_requested` / `host.approval_resolved`
    // envelopes; `host.dispatch_started` follows only on proceed.
    const approvalOutcome = await runApprovalIfNeeded({ ctx, writer, composerMode, spec });
    if (approvalOutcome.status === "blocked") {
      return handleBlockedDispatch({ ctx, writer, rationale: approvalOutcome.rationale, spec });
    }

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

    let execution: TaskExecutionRecord;
    const dispatchProgress = startDispatchProgress({
      taskId: spec.taskId,
      useJson: args.copilot.outputFormat === "json",
      write: stdoutWrite,
    });
    let sawWorkerEvent = false;
    try {
      dispatchProgress.start();
      execution = await runner.runAttempt(
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
            if (!sawWorkerEvent) {
              sawWorkerEvent = true;
              dispatchProgress.stop();
            }
            onProgress?.(event);
            void writer.append(projectLegacyWorkerEvent(sessionId, turnId, spec.attemptId, event));
            stdoutWrite(formatProgressLine(event));
          },
          onWorkerError: (error) => {
            const message =
              typeof error.message === "string" ? error.message : JSON.stringify(error);
            stdoutWrite(`[worker-error] ${message}\n`);
          },
        },
        plan?.profile,
      );
    } catch (error) {
      dispatchProgress.stop();
      // W3 — persist the protocol-mismatch decoration before re-throw so
      // `inspect` renders cleanly. See `persistProtocolMismatchAttempt`.
      if (error instanceof WorkerProtocolMismatchError) {
        await persistProtocolMismatchAttempt({ sessionStore, sessionId, turnId, spec, error });
      }
      throw error;
    } finally {
      dispatchProgress.stop();
    }

    const executionResult = toAttemptExecutionResult(spec, execution);
    const reviewed = reviewAttemptResult(spec, executionResult);

    const dispatchCommand = Array.isArray(execution.metadata?.cmd)
      ? execution.metadata.cmd.map((entry) => String(entry))
      : undefined;
    const discoveredWorktree =
      plan?.profile.sandboxLifecycle === "preserved" &&
      typeof execution.metadata?.taskId === "string"
        ? await discoverWorktree(spec.cwd, execution.metadata.taskId)
        : null;

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
      ...(plan !== undefined ? { dispatchPlan: plan } : {}),
      metadata: {
        sandboxTaskId: execution.metadata?.taskId,
        ...(discoveredWorktree?.path !== undefined ? { worktreePath: discoveredWorktree.path } : {}),
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

// ---------------------------------------------------------------------------
// Approval producer integration helpers (Phase 4 PR7)
// ---------------------------------------------------------------------------

/**
 * Run the approval producer when (a) the spec has a concrete intended
 * operation and (b) a dispatcher was threaded through. Otherwise the
 * function no-ops and returns `"proceed"` so non-interactive callers are
 * unchanged.
 */
const runApprovalIfNeeded = async (args: {
  ctx: ExecuteAttemptContext;
  writer: EventLogWriter;
  composerMode: ComposerMode;
  spec: AttemptSpec;
}): Promise<ApprovalProducerOutcome> => {
  const { ctx, writer, composerMode, spec } = args;
  const operation = extractIntendedOperation(spec);
  if (operation === null) {
    return { status: "proceed" };
  }
  if (ctx.approvalDispatcher === undefined && ctx.approvalOverride === undefined) {
    // No interactive dispatcher and no test override — skip the dialog path
    // entirely. The durable-allowlist / deny-rule evaluation fires only
    // when the caller opts in by providing a dispatcher.
    return { status: "proceed" };
  }

  const input: ResolveApprovalInput = {
    storageRoot: ctx.sessionStore.rootDir,
    repoRoot: ctx.repoRoot ?? spec.cwd,
    spec,
    operation,
    composerMode,
    agentProfileName: PROFILE_NAME[composerMode],
    writer,
    // `dispatcher` is required by the producer surface; the test override
    // never touches it, so a stub object satisfies the contract.
    dispatcher: ctx.approvalDispatcher ?? {
      getState: () => {
        throw new Error("approvalDispatcher.getState called without a dispatcher");
      },
      setState: () => {
        throw new Error("approvalDispatcher.setState called without a dispatcher");
      },
    },
    ...(ctx.hookRegistry !== undefined ? { hookRegistry: ctx.hookRegistry } : {}),
  };

  if (ctx.approvalOverride !== undefined) {
    return ctx.approvalOverride(input);
  }
  return resolveApprovalBeforeDispatch(input);
};

/**
 * Produce the synthetic return value for a dispatch that was blocked by the
 * approval producer. The turn record reflects `"blocked"` so the follow-up
 * UI (`/retry`, `/halt`) can surface the reason; no envelope is emitted
 * beyond what the producer already wrote.
 */
const handleBlockedDispatch = async (args: {
  ctx: ExecuteAttemptContext;
  writer: EventLogWriter;
  rationale: string;
  spec: AttemptSpec;
}): Promise<{ reviewed: ReviewedAttemptResult; executionResult: AttemptExecutionResult }> => {
  const { ctx, rationale, spec } = args;
  // `args.writer` is accepted for symmetry with the proceed path and so
  // future consumers can emit an additional "blocked" envelope here without
  // changing the signature — the Phase 4 producer already wrote its own
  // `host.approval_resolved` envelope before returning blocked.
  void args.writer;
  const { sessionStore, sessionId, turnId } = ctx;
  const blockedAt = new Date().toISOString();

  await sessionStore.upsertAttempt(sessionId, turnId, {
    attemptId: spec.attemptId,
    status: "blocked",
    lastMessage: rationale,
    attemptSpec: spec,
  });

  const executionResult: AttemptExecutionResult = {
    schemaVersion: 3,
    attemptId: spec.attemptId,
    taskKind: spec.taskKind,
    status: "blocked",
    summary: rationale,
    exitCode: null,
    startedAt: blockedAt,
    finishedAt: blockedAt,
    durationMs: 0,
    artifacts: [],
  };
  const reviewed: ReviewedAttemptResult = {
    attemptId: spec.attemptId,
    intentId: spec.intentId,
    status: "blocked",
    // `policy_denied` matches the ReviewClassification surface for policy
    // short-circuits; the reviewer normally lands here via text heuristics
    // on worker output, but approval-denials are the same category.
    outcome: "policy_denied",
    action: "halt",
    reason: rationale,
    retryable: false,
    needsUser: true,
    confidence: "high",
  };
  return { reviewed, executionResult };
};
