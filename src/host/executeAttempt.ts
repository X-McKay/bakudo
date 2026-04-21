import type { ABoxTaskRunner, TaskExecutionRecord } from "../aboxTaskRunner.js";
import type { ArtifactStore } from "../artifactStore.js";
import type { AttemptExecutionResult, AttemptSpec, DispatchPlan } from "../attemptProtocol.js";
import { providerRegistry } from "./providerRegistry.js";
import type { TaskMode } from "../protocol.js";
import { createAttemptReviewRecord, type ReviewedAttemptResult, reviewAttemptResult } from "../reviewer.js";
import type { SessionStore } from "../sessionStore.js";
import type { CandidateState } from "../sessionTypes.js";
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
import { discardSandbox } from "./sandboxCleanup.js";
import { stdoutWrite } from "./io.js";
import { applyPreservedCandidate } from "./candidateApplier.js";
import {
  CANDIDATE_MANIFEST_ARTIFACT_NAME,
  describeCandidateManifest,
} from "./candidateManifest.js";
import { harvestGuestArtifacts, writeHostArtifacts } from "./hostArtifactGenerator.js";
import { inspectWorktree, type WorktreeInspection } from "./worktreeInspector.js";
import { discoverWorktree } from "./worktreeDiscovery.js";
import {
  buildDispatchStartedEnvelope,
  buildReviewCompletedEnvelope,
  buildReviewStartedEnvelope,
  formatProgressLine,
  upsertTurnLatestReview,
} from "./orchestrationSupport.js";
import type { HostCliArgs } from "./parsing.js";
import { recordProvenanceFinalize, recordProvenanceStart } from "./provenanceProducer.js";
import { captureSourceBaseline } from "./sourceBaseline.js";
import { writeExecutionArtifacts } from "./sessionArtifactWriter.js";
import { WorkerProtocolMismatchError } from "./errors.js";
import { persistProtocolMismatchAttempt } from "./protocolMismatchPersist.js";
import { turnStatusFromReview } from "./sessionRunSupport.js";

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

type EventLogWriterFactory = (storageRoot: string, sessionId: string) => EventLogWriter;

const attemptStatusFromReview = (
  reviewed: ReviewedAttemptResult,
  candidateState?: CandidateState,
): "succeeded" | "failed" | "blocked" | "cancelled" | "needs_review" => {
  if (candidateState === "candidate_ready") {
    return reviewed.action === "ask_user" ? "blocked" : "needs_review";
  }
  if (
    candidateState === "apply_staging" ||
    candidateState === "apply_verifying" ||
    candidateState === "apply_writeback"
  ) {
    return "needs_review";
  }
  if (candidateState === "needs_confirmation") {
    return "blocked";
  }
  if (candidateState === "applied") {
    return "succeeded";
  }
  if (candidateState === "apply_failed") {
    return "failed";
  }
  if (candidateState === "discarded") {
    return "cancelled";
  }
  if (reviewed.outcome === "success") {
    return "succeeded";
  }
  if (reviewed.outcome === "blocked_needs_user" || reviewed.outcome === "policy_denied") {
    return "blocked";
  }
  if (reviewed.outcome === "incomplete_needs_follow_up") {
    return "needs_review";
  }
  return "failed";
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
 * Execute an {@link AttemptSpec} through the abox worker pipeline.
 */
export const executeAttempt = async (
  ctx: ExecuteAttemptContext,
  plan?: DispatchPlan,
): Promise<{
  reviewed: ReviewedAttemptResult;
  executionResult: AttemptExecutionResult;
  candidateState?: CandidateState;
}> => {
  const spec = plan?.spec ?? ctx.spec;
  if (spec === undefined) {
    throw new Error("executeAttempt requires either plan.spec or ctx.spec");
  }

  // Wave 1: Pre-flight provider policy check.
  // Verify that the chosen provider is registered and that its required
  // abox policies are declared. This is a best-effort check — abox itself
  // enforces the actual sandbox policy; this gives the user a clear error
  // message before any sandbox is spawned.
  if (plan?.profile.providerId !== undefined) {
    const providerId = plan.profile.providerId;
    if (!providerRegistry.has(providerId)) {
      throw new Error(
        `[Wave 1] Unknown provider "${providerId}". ` +
          `Register it with providerRegistry.register() before dispatching.`,
      );
    }
    // Policy check is advisory: we log the required policies so the user
    // can verify their abox config, but we do not block execution since
    // abox config parsing is handled by the Rust core.
    const provider = providerRegistry.get(providerId);
    if (provider.requiredPolicies.length > 0) {
      // Surface the required policies in debug output so the user can
      // confirm their abox config includes them.
      const policies = provider.requiredPolicies.join(", ");
      void policies; // consumed by future abox config probe (Wave 3+)
    }
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
    const sourceBaseline =
      plan?.profile.sandboxLifecycle === "preserved"
        ? await captureSourceBaseline(spec.cwd)
        : undefined;

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
    const dispatchCommand = Array.isArray(execution.metadata?.cmd)
      ? execution.metadata.cmd.map((entry) => String(entry))
      : undefined;
    const sandboxTaskId =
      typeof execution.metadata?.taskId === "string" ? execution.metadata.taskId : undefined;
    const discoveredWorktree =
      plan?.profile.sandboxLifecycle === "preserved" && sandboxTaskId !== undefined
        ? await discoverWorktree(spec.cwd, sandboxTaskId)
        : null;
    let inspection: WorktreeInspection | null = null;
    if (discoveredWorktree !== null && sandboxTaskId !== undefined) {
      try {
        inspection = await inspectWorktree({
          snapshot: discoveredWorktree,
          taskId: sandboxTaskId,
          attemptId: spec.attemptId,
          ...(sourceBaseline?.headSha === undefined
            ? {}
            : { baselineHeadSha: sourceBaseline.headSha }),
        });
      } catch {
        inspection = null;
      }
    }
    const harvestedGuestArtifacts =
      inspection === null
        ? []
        : await harvestGuestArtifacts({
            artifactStore,
            storageRoot,
            sessionId,
            turnId,
            attemptId: spec.attemptId,
            inspection,
          });
    const hostArtifacts =
      inspection === null
        ? []
        : await writeHostArtifacts({
            artifactStore,
            storageRoot,
            sessionId,
            turnId,
            attemptId: spec.attemptId,
            inspection,
          });
    executionResult.artifacts.push(...harvestedGuestArtifacts, ...hostArtifacts);

    const finalized = await recordProvenanceFinalize({
      storageRoot,
      prior: started.record,
      ...(dispatchCommand !== undefined ? { dispatchCommand } : {}),
      ...(sandboxTaskId !== undefined ? { sandboxTaskId } : {}),
      exit: {
        exitCode: execution.result.exitCode ?? null,
        exitSignal: null,
        timedOut: false,
        elapsedMs: execution.result.durationMs ?? 0,
      },
    });
    await writer.append(finalized.envelope);

    let reviewed = reviewAttemptResult(spec, executionResult, {
      ...(plan?.profile !== undefined ? { profile: plan.profile } : {}),
      inspection,
    });
    let applyResult:
      | {
          applied?: boolean;
          discarded?: boolean;
          error?: string;
          needsConfirmation?: boolean;
          confirmationReason?: string;
        }
      | null = null;
    let candidateState: CandidateState =
      plan?.profile.sandboxLifecycle === "preserved" &&
      (inspection?.repoChangedFiles.length ?? 0) > 0
        ? "candidate_ready"
        : "ephemeral";
    const reviewedAt = new Date().toISOString();
    const candidateFingerprint =
      inspection === null ? undefined : describeCandidateManifest(inspection).fingerprint;
    let appliedCandidateUpdates: Record<string, unknown> = {};

    if (plan?.profile.sandboxLifecycle === "preserved") {
      if (sandboxTaskId === undefined) {
        applyResult = {
          error: "preserved candidate execution finished without a sandbox task id",
        };
        candidateState = "apply_failed";
      } else if (plan.profile.candidatePolicy === "discard") {
        try {
          await discardSandbox(args.aboxBin, spec.cwd, sandboxTaskId);
          applyResult = { discarded: true };
          candidateState = "discarded";
        } catch (error) {
          applyResult = {
            error: `sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          };
          candidateState = "apply_failed";
        }
      } else if (
        plan.profile.candidatePolicy === "auto_apply" &&
        inspection !== null &&
        sourceBaseline !== undefined &&
        candidateState === "candidate_ready"
      ) {
        const applied = await applyPreservedCandidate({
          sessionStore,
          artifactStore,
          runner,
          storageRoot,
          session: (await sessionStore.loadSession(sessionId)) ?? {
            sessionId,
            repoRoot: spec.cwd,
            title: sessionId,
            status: "running",
            schemaVersion: 2,
            turns: [],
            createdAt: reviewedAt,
            updatedAt: reviewedAt,
          },
          turnId,
          attempt: {
            attemptId: spec.attemptId,
            status: "needs_review",
            candidateState,
            candidate: {
              state: candidateState,
              ...(plan.candidateId === undefined ? {} : { candidateId: plan.candidateId }),
              sandboxTaskId,
              ...(discoveredWorktree?.branch === undefined
                ? {}
                : { branchName: discoveredWorktree.branch }),
              ...(discoveredWorktree?.path === undefined
                ? {}
                : { worktreePath: discoveredWorktree.path }),
              ...(inspection.reservedOutputDir === undefined
                ? {}
                : { reservedOutputDir: inspection.reservedOutputDir }),
              updatedAt: reviewedAt,
              ...(candidateFingerprint === undefined ? {} : { fingerprint: candidateFingerprint }),
            },
          },
          attemptSpec: spec,
          aboxBin: args.aboxBin,
          explicitConfirmation: false,
          sourceBaseline,
          inspection,
          ...(candidateFingerprint === undefined
            ? {}
            : { expectedFingerprint: candidateFingerprint }),
        });
        candidateState = applied.candidateState;
        applyResult = applied.applyResult;
        appliedCandidateUpdates = applied.candidateUpdates;
      }
      reviewed = reviewAttemptResult(spec, executionResult, {
        profile: plan.profile,
        inspection,
        ...(applyResult === null ? {} : { applyResult }),
      });
    }
    const reviewRecord = createAttemptReviewRecord({
      spec,
      reviewed,
      reviewedAt,
    });

    await writer.append(
      buildReviewStartedEnvelope({ sessionId, turnId, attemptId: spec.attemptId }),
    );
    await sessionStore.upsertAttempt(sessionId, turnId, {
      attemptId: spec.attemptId,
      status: attemptStatusFromReview(reviewed, candidateState),
      result: execution.result,
      lastMessage: reviewed.reason,
      attemptSpec: spec,
      ...(plan !== undefined ? { dispatchPlan: plan } : {}),
      reviewRecord,
      candidateState,
      ...(plan?.profile.sandboxLifecycle === "preserved"
        ? {
            candidate: {
              state: candidateState,
              ...(plan?.candidateId !== undefined ? { candidateId: plan.candidateId } : {}),
              ...(sandboxTaskId !== undefined ? { sandboxTaskId } : {}),
              ...(discoveredWorktree?.branch !== undefined
                ? { branchName: discoveredWorktree.branch }
                : {}),
              ...(discoveredWorktree?.path !== undefined
                ? { worktreePath: discoveredWorktree.path }
                : {}),
              ...(inspection?.reservedOutputDir !== undefined
                ? { reservedOutputDir: inspection.reservedOutputDir }
                : {}),
              ...(inspection?.changeKind !== undefined ? { changeKind: inspection.changeKind } : {}),
              ...(inspection?.repoChangedFiles !== undefined
                ? { changedFiles: inspection.repoChangedFiles }
                : {}),
              ...(inspection?.dirtyFiles !== undefined ? { dirtyFiles: inspection.dirtyFiles } : {}),
              ...(inspection?.committedFiles !== undefined
                ? { committedFiles: inspection.committedFiles }
                : {}),
              ...(inspection?.outputArtifacts !== undefined
                ? { outputArtifacts: inspection.outputArtifacts }
                : {}),
              ...(candidateFingerprint === undefined ? {} : { fingerprint: candidateFingerprint }),
              ...(candidateFingerprint === undefined
                ? {}
                : { manifestArtifact: CANDIDATE_MANIFEST_ARTIFACT_NAME }),
              ...(sourceBaseline !== undefined
                ? { sourceBaseline, driftDecision: "not_checked" }
                : {}),
              ...appliedCandidateUpdates,
              ...(applyResult?.error !== undefined || applyResult?.confirmationReason !== undefined
                ? {
                    ...(applyResult.error === undefined ? {} : { applyError: applyResult.error }),
                    ...(applyResult.confirmationReason === undefined
                      ? {}
                      : { confirmationReason: applyResult.confirmationReason }),
                  }
                : {}),
              ...(candidateState === "applied" ? { appliedAt: reviewedAt } : {}),
              updatedAt: reviewedAt,
              reviewedAt,
              ...(candidateState === "discarded" ? { discardedAt: reviewedAt } : {}),
              ...(applyResult?.error !== undefined
                ? { failureAt: reviewedAt, applyError: applyResult.error }
                : {}),
            },
          }
        : {}),
      metadata: {
        sandboxTaskId,
        ...(discoveredWorktree?.path !== undefined
          ? { worktreePath: discoveredWorktree.path }
          : {}),
        ...(discoveredWorktree?.branch !== undefined
          ? { branchName: discoveredWorktree.branch }
          : {}),
        ...(inspection?.repoChangedFiles !== undefined
          ? { changedFiles: inspection.repoChangedFiles }
          : {}),
        ...(inspection?.outputArtifacts !== undefined
          ? { outputArtifacts: inspection.outputArtifacts }
          : {}),
        aboxCommand: execution.metadata?.cmd,
      },
      ...(dispatchCommand === undefined ? {} : { dispatchCommand }),
    });
    const sessionAfterAttempt = await sessionStore.loadSession(sessionId);
    const turnAfterAttempt = sessionAfterAttempt?.turns.find((entry) => entry.turnId === turnId);
    if (turnAfterAttempt !== undefined) {
      await sessionStore.upsertTurn(sessionId, {
        ...turnAfterAttempt,
        status: turnStatusFromReview(reviewed, candidateState),
        updatedAt: reviewedAt,
      });
    }
    await upsertTurnLatestReview(sessionStore, sessionId, turnId, reviewRecord);

    await writer.append(
      buildReviewCompletedEnvelope({
        sessionId,
        turnId,
        attemptId: spec.attemptId,
        reviewed,
        candidateState,
      }),
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

    return { reviewed, executionResult, candidateState };
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
}): Promise<{
  reviewed: ReviewedAttemptResult;
  executionResult: AttemptExecutionResult;
  candidateState?: CandidateState;
}> => {
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
