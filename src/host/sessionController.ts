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
import { BakudoConfigDefaults, loadConfigCascade } from "./config.js";
import { resolveEnvPolicyForHost } from "./envPolicy.js";
import { resolveRedactionPolicyForHost } from "./redaction.js";
import { emitSessionEvent, readSessionEventLog, type JsonEventSink } from "./eventLogWriter.js";
import { executeAttempt } from "./executeAttempt.js";
import { createSessionProbeFailureEmitter } from "./workerCapabilities.js";
import { acquireSessionLock, type SessionLockHandle } from "./lockFile.js";
import { recoverInterruptedApplyIfNeeded } from "./applyRecovery.js";
import {
  buildEventKindLoader,
  logRecoveryNotice,
  recoverState,
  type RecoveryReport,
} from "./recovery.js";
import { registerCleanupHandler } from "./signalHandlers.js";
import {
  type EventLogWriterFactory,
  makeInitialTurn,
  repoRootFor,
  sessionStatusFromReview,
  storageRootFor,
} from "./sessionRunSupport.js";
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

const buildRunnerContext = async (
  args: HostCliArgs,
): Promise<{
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  runner: ABoxTaskRunner;
}> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  // Phase 6 W5: resolve the env-passthrough policy from the config cascade
  // + BAKUDO_ENV_ALLOWLIST override so plan Default Rule 362 (explicit
  // opt-in for env passthrough) works end-to-end. A missing config file
  // yields an empty allowlist — the safe default.
  const { merged: hostConfig } = await loadConfigCascade(repoRootFor(args.repo), {});
  const envPolicy = resolveEnvPolicyForHost(
    hostConfig.envPolicy?.allowlist !== undefined
      ? { configAllowlist: hostConfig.envPolicy.allowlist }
      : {},
  );
  // Wave 6c PR7 carryover #7: build the effective redaction policy (default
  // patterns + user-configured extras) and pass it to artifact writers so
  // `redaction.extraTextPatterns` / `extraEnvDenyPatterns` take effect
  // end-to-end. Mirrors the resolveEnvPolicyForHost lock-in 26 pattern —
  // do NOT hard-code DEFAULT_REDACTION_POLICY at this site.
  const redactionPolicy = resolveRedactionPolicyForHost({
    ...(hostConfig.redaction !== undefined ? { configExtra: hostConfig.redaction } : {}),
  });
  // Wave 6c PR9 carryover #6 — wire the deferred `worker.capability_probe_failed`
  // diagnostic to the session event log. Runner-instance scope = session scope
  // (the runner is constructed once per session), so runner-level dedupe
  // satisfies the one-shot-per-session rule. See `workerCapabilities.ts` for
  // the factory that builds the fire-and-forget emitter.
  const probeFailureEmitter = createSessionProbeFailureEmitter({
    storageRoot: rootDir,
    emitSessionEvent,
  });

  return {
    // Production entry points enforce the per-session lock; tests that
    // instantiate `SessionStore` directly continue to see the legacy
    // default (`enforceLock: false`). See plan Hard Rule 1.
    sessionStore: new SessionStore(rootDir, { enforceLock: true }),
    artifactStore: new ArtifactStore(rootDir, redactionPolicy),
    runner: new ABoxTaskRunner(
      new ABoxAdapter(args.aboxBin),
      undefined,
      envPolicy,
      undefined,
      probeFailureEmitter,
    ),
  };
};

/**
 * Acquire the per-session lock + wire crash release + register the handle
 * with `sessionStore` so writes on this turn pass the `assertLockHeld`
 * guard. Returns a disposer that releases the lock and unregisters cleanup.
 *
 * The disposer is idempotent. Callers MUST invoke it from a `finally` block
 * so graceful-shutdown writes still run. On a fatal signal, the
 * `signalHandlers` LIFO chain invokes the lock-release handler that this
 * function registers, so the on-disk `.lock` is removed even if the caller
 * never runs its `finally`.
 */
const withAcquiredLock = async (
  sessionStore: SessionStore,
  sessionId: string,
): Promise<{ handle: SessionLockHandle; release: () => Promise<void> }> => {
  const sessionDir = sessionStore.paths(sessionId).sessionDir;
  // Wave 6d carryover #3: the prior try/catch here only re-threw
  // `SessionLockBusyError` (and every other error) verbatim, so it added no
  // behavior. Let `acquireSessionLock` throw naturally — callers classify
  // via `errors.ts` at the dispatch boundary (W9 taxonomy) anyway.
  const handle: SessionLockHandle = await acquireSessionLock(sessionId, sessionDir);
  const unregister = sessionStore.registerLock(handle);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    unregister();
    await handle.release();
  };
  // Crash release: `signalHandlers.ts` runs this LIFO on SIGINT/SIGTERM/
  // uncaught so a hard crash still removes the `.lock`. The returned
  // uninstaller is called from `release` so a graceful dispose does not
  // leave the cleanup list growing.
  const uninstall = registerCleanupHandler(async () => {
    await release();
  });
  const wrappedRelease = async (): Promise<void> => {
    uninstall();
    await release();
  };
  return { handle, release: wrappedRelease };
};

/**
 * Run `recoverState()` and decide whether to proceed, clear a stale lock, or
 * block resume. Logs a single recovery notice via stderr (interim surface
 * until new envelope kinds are authorized — see `recovery.ts` module docstring).
 *
 * Returns `null` when it is safe to proceed. Throws when resume must be
 * blocked (`running_incomplete`). Currently, `finished_no_review` and
 * `queued_no_attempt` are informational — the caller continues after the
 * log line is emitted, which aligns with plan 207-210's intent that
 * "queued_no_attempt → safe to resume" and "finished_no_review → run
 * review recovery before resume" (the review recovery is performed by the
 * normal dispatch pipeline re-entering the attempt; a no-op until the
 * review pass completes).
 */
const runRecoveryGate = async (
  sessionStore: SessionStore,
  artifactStore: ArtifactStore,
  sessionId: string,
  storageRoot: string,
): Promise<RecoveryReport | null> => {
  let session = await sessionStore.loadSession(sessionId);
  if (session === null) {
    return null;
  }
  const loadEventKinds = buildEventKindLoader((sid) => readSessionEventLog(storageRoot, sid));
  let sessionDir = sessionStore.paths(sessionId).sessionDir;
  let report = await recoverState(session, sessionDir, { loadEventKinds });
  if (report.verdict.kind === "apply_incomplete") {
    const recovered = await recoverInterruptedApplyIfNeeded({
      sessionStore,
      artifactStore,
      storageRoot,
      sessionId,
    });
    if (recovered) {
      session = await sessionStore.loadSession(sessionId);
      if (session === null) {
        return null;
      }
      sessionDir = sessionStore.paths(sessionId).sessionDir;
      report = await recoverState(session, sessionDir, { loadEventKinds });
    }
  }
  if (
    report.verdict.kind === "healthy" &&
    report.lock.kind !== "stale" &&
    report.lock.kind !== "corrupt"
  ) {
    return null;
  }
  logRecoveryNotice(report);
  if (report.blocksResume) {
    throw new SessionResumeBlockedError(report);
  }
  return report;
};

/** Thrown when `recoverState` classifies the session as `running_incomplete`. */
export class SessionResumeBlockedError extends Error {
  public readonly report: RecoveryReport;
  public constructor(report: RecoveryReport) {
    super(
      `session ${report.sessionId} cannot be resumed: ${report.code} — ` +
        `run bakudo inspect --session ${report.sessionId} to review`,
    );
    this.name = "SessionResumeBlockedError";
    this.report = report;
  }
}

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

const planAttemptOptionsFor = (
  tokenBudget: number | null,
  isExplicitCommand: boolean | undefined,
): { isExplicitCommand?: true; tokenBudget?: number } => ({
  ...(tokenBudget !== null ? { tokenBudget } : {}),
  ...(isExplicitCommand ? { isExplicitCommand: true as const } : {}),
});

/**
 * Resolve the effective auto-approve flag, honoring `--allow-all-tools` as a
 * Copilot-parity shortcut for Autopilot mode. Deny-precedence still wins
 * inside `resolveApprovalBeforeDispatch` — this only collapses the composer
 * mode so the planner emits `allowAllTools: true` on the spec.
 */
export const resolveAutoApprove = (args: HostCliArgs): boolean =>
  (args.yes ?? false) || args.copilot.allowAllTools === true;

export type SessionDispatchOptions = {
  onProgress?: (event: WorkerTaskProgressEvent) => void;
  eventLogWriterFactory?: EventLogWriterFactory;
  /**
   * Optional JSONL tee for `--output-format=json`. When provided, pre-dispatch
   * envelopes (`host.turn_queued`) are also forwarded to the sink alongside
   * the attempt-scoped writer stream. The dispatch-inner writer receives the
   * sink via `eventLogWriterFactory`; they are supplied together by
   * `runNonInteractiveOneShot`.
   */
  sink?: JsonEventSink;
};

export const createAndRunFirstTurn = async (
  prompt: string,
  args: HostCliArgs,
  options: SessionDispatchOptions = {},
): Promise<SessionDispatchResult> => {
  const { sessionStore, artifactStore, runner } = await buildRunnerContext(args);
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

  // Acquire the per-session lock before the first write. For a freshly-created
  // session there is no prior holder, so this call is always uncontended; it
  // wires the crash-release hook and registers the handle with the store so
  // subsequent writes in this function pass the lock guard.
  const { release: releaseLock } = await withAcquiredLock(sessionStore, sessionId);
  try {
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
      options.sink,
    );

    const attemptId = createSessionTaskKey(session.sessionId, "turn1-attempt-1");
    const composerMode = taskModeToComposerMode(args.mode, resolveAutoApprove(args));
    const repoRoot = repoRootFor(args.repo);
    const plannerOpts = planAttemptOptionsFor(budget?.tokens ?? null, args.isExplicitCommand);
    const { plan } = planAttempt(
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

    const { reviewed, candidateState } = await executeAttempt(
      {
        sessionStore,
        artifactStore,
        runner,
        sessionId: session.sessionId,
        turnId,
        args,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.eventLogWriterFactory
          ? { eventLogWriterFactory: options.eventLogWriterFactory }
          : {}),
      },
      plan,
    );

    const updated = await sessionStore.saveSession({
      ...(await sessionStore.loadSession(session.sessionId))!,
      status: sessionStatusFromReview(reviewed, candidateState),
    });

    return { sessionId: updated.sessionId, turnId, attemptId, reviewed, session: updated };
  } finally {
    await releaseLock();
  }
};

export const appendTurnToActiveSession = async (
  sessionId: string,
  prompt: string,
  args: HostCliArgs,
  options: SessionDispatchOptions = {},
): Promise<SessionDispatchResult> => {
  const { sessionStore, artifactStore, runner } = await buildRunnerContext(args);
  const storageRoot = storageRootFor(args.repo, args.storageRoot);

  // Recovery gate — runs BEFORE we acquire the lock. If the prior host
  // crashed in the middle of a dispatch, we must surface the verdict (and
  // possibly block resume) before the append path overwrites any state.
  await runRecoveryGate(sessionStore, artifactStore, sessionId, storageRoot);

  const { release: releaseLock } = await withAcquiredLock(sessionStore, sessionId);
  try {
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
      options.sink,
    );

    const withTurn = await sessionStore.loadSession(sessionId);
    if (withTurn === null) {
      throw new Error(`session disappeared during turn append: ${sessionId}`);
    }
    const attemptId = nextAttemptId(withTurn, turnId);
    const composerMode = taskModeToComposerMode(args.mode, resolveAutoApprove(args));
    const repoRoot = repoRootFor(args.repo);
    const appendPlannerOpts = planAttemptOptionsFor(budget?.tokens ?? null, args.isExplicitCommand);
    const { plan } = planAttempt(
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
    const { reviewed, candidateState } = await executeAttempt(
      {
        sessionStore,
        artifactStore,
        runner,
        sessionId,
        turnId,
        args,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.eventLogWriterFactory
          ? { eventLogWriterFactory: options.eventLogWriterFactory }
          : {}),
      },
      plan,
    );

    const updated = await sessionStore.saveSession({
      ...(await sessionStore.loadSession(sessionId))!,
      status: sessionStatusFromReview(reviewed, candidateState),
    });

    return { sessionId, turnId, attemptId, reviewed, session: updated };
  } finally {
    await releaseLock();
  }
};

export const resumeNamedSession = async (
  sessionId: string,
  args: HostCliArgs,
): Promise<SessionRecord | null> => {
  const { sessionStore, artifactStore } = await buildRunnerContext(args);
  const storageRoot = storageRootFor(args.repo, args.storageRoot);
  // Recovery gate: run BEFORE handing the session back to the caller so the
  // caller never sees a session that must be inspected before further writes.
  // A blocked-resume verdict throws `SessionResumeBlockedError` here.
  await runRecoveryGate(sessionStore, artifactStore, sessionId, storageRoot);
  return sessionStore.loadSession(sessionId);
};
