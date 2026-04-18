import type { WorkerTaskProgressEvent } from "../workerRuntime.js";
import {
  isTerminalStage,
  mapWorkerEventToNarration,
  progressStagePriority,
  type ProgressMapping,
  type ProgressStage,
} from "./progressMapper.js";
import type { TranscriptItem } from "./renderModel.js";

/**
 * The coalescer's flush cadence. Events arriving inside the same 16ms tick
 * collapse to the latest emission per stage. Matches the 16ms reference rate
 * identified in the phase doc's streaming cadence appendix (2026-04-14).
 */
export const PROGRESS_COALESCE_INTERVAL_MS = 16;

export type ProgressCoalescerOptions = {
  /**
   * Override the timer used to schedule flushes. Tests inject a deterministic
   * scheduler (see {@link createManualTimers}).
   */
  scheduleFlush?: (callback: () => void, ms: number) => unknown;
  cancelFlush?: (handle: unknown) => void;
  nowMs?: () => number;
};

export type CoalescerHandle = {
  (event: WorkerTaskProgressEvent): void;
  /** Force any pending flush to run synchronously. */
  flushNow: () => void;
  /** Inspection helper for tests; returns the last stage that was emitted. */
  lastEmittedStage: () => ProgressStage | undefined;
};

const mappingToTranscript = (mapping: ProgressMapping): TranscriptItem | null => {
  if (mapping.line === undefined) {
    return null;
  }
  return { kind: "assistant", text: mapping.line, tone: mapping.tone ?? "info" };
};

const defaultSchedule = (callback: () => void, ms: number): unknown => setTimeout(callback, ms);

const defaultCancel = (handle: unknown): void => {
  if (handle !== undefined && handle !== null) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  }
};

/**
 * Build a stateful coalescer that converts a stream of {@link WorkerTaskProgressEvent}
 * into transcript narrations according to the Phase 1 semantic progress rules.
 *
 * Behavior:
 *  - Same-stage repeat events (e.g. running_output) inside one 16ms window
 *    produce at most one transcript line (the initial transition).
 *  - Escalation to a terminal stage (`timed_out`, `failed`) flushes the pending
 *    mapping immediately without waiting for the tick boundary.
 *  - Each call returns nothing; the coalescer dispatches through `emit`.
 */
export const createProgressCoalescer = (
  emit: (item: TranscriptItem) => void,
  options: ProgressCoalescerOptions = {},
): CoalescerHandle => {
  const scheduleFlush = options.scheduleFlush ?? defaultSchedule;
  const cancelFlush = options.cancelFlush ?? defaultCancel;

  let lastStage: ProgressStage | undefined;
  let pendingMapping: ProgressMapping | null = null;
  let timerHandle: unknown;

  const flush = (): void => {
    if (timerHandle !== undefined) {
      cancelFlush(timerHandle);
      timerHandle = undefined;
    }
    if (pendingMapping === null) {
      return;
    }
    const item = mappingToTranscript(pendingMapping);
    lastStage = pendingMapping.stage;
    pendingMapping = null;
    if (item !== null) {
      emit(item);
    }
  };

  const schedule = (): void => {
    if (timerHandle !== undefined) {
      return;
    }
    timerHandle = scheduleFlush(() => {
      timerHandle = undefined;
      flush();
    }, PROGRESS_COALESCE_INTERVAL_MS);
  };

  const handle = ((event: WorkerTaskProgressEvent): void => {
    const mapping = mapWorkerEventToNarration(event, lastStage);
    const isEscalation =
      pendingMapping === null
        ? isTerminalStage(mapping.stage) && mapping.stage !== "completed"
        : false;

    if (pendingMapping === null) {
      pendingMapping = mapping;
    } else {
      const priorPriority = progressStagePriority[pendingMapping.stage];
      const nextPriority = progressStagePriority[mapping.stage];
      if (nextPriority >= priorPriority) {
        pendingMapping = mapping;
      }
    }

    if (isEscalation || isTerminalStage(pendingMapping.stage)) {
      flush();
      return;
    }
    schedule();
  }) as CoalescerHandle;

  handle.flushNow = flush;
  handle.lastEmittedStage = (): ProgressStage | undefined => lastStage;

  return handle;
};
