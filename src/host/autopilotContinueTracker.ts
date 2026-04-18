/**
 * Phase 5 PR11 — bound on unattended Autopilot continue chains.
 *
 * Tracks the depth of sequential attempts within a single session while
 * Autopilot is engaged. When the depth exceeds the per-invocation cap
 * (see `CopilotParityFlags.maxAutopilotContinues`), {@link shouldHaltAutopilot}
 * returns the sentinel halt message and the caller MUST stop dispatching
 * follow-up attempts on the same session.
 *
 * The tracker is deliberately small and framework-free: callers own the
 * per-session map (typically keyed by `sessionId`). Unit tests consume the
 * tracker directly without touching the dispatch pipeline.
 */

import { DEFAULT_MAX_AUTOPILOT_CONTINUES } from "./parsing.js";

/** Message returned when the cap is exceeded. Exposed for assertions. */
export const AUTOPILOT_CONTINUE_LIMIT_MESSAGE = "autopilot continue limit reached" as const;

/**
 * Per-session Autopilot continue counters. Keep as a `Map` rather than a
 * plain record so we can iterate and clear per-session state when a session
 * is archived or reviewed.
 */
export type AutopilotContinueTracker = {
  /** Number of continues recorded against each session id. */
  readonly depths: Map<string, number>;
  /** Effective cap for this tracker (from the CLI flag, clamped to >= 1). */
  readonly cap: number;
};

/**
 * Build a fresh tracker with an optional cap. When `cap` is `undefined` the
 * default from {@link DEFAULT_MAX_AUTOPILOT_CONTINUES} applies.
 */
export const createAutopilotContinueTracker = (cap?: number): AutopilotContinueTracker => ({
  depths: new Map<string, number>(),
  cap: cap === undefined || cap <= 0 ? DEFAULT_MAX_AUTOPILOT_CONTINUES : cap,
});

/**
 * Record one more unattended continue for `sessionId`. Returns the updated
 * depth so callers can log it alongside the attempt.
 */
export const incrementAutopilotContinue = (
  tracker: AutopilotContinueTracker,
  sessionId: string,
): number => {
  const current = tracker.depths.get(sessionId) ?? 0;
  const next = current + 1;
  tracker.depths.set(sessionId, next);
  return next;
};

/** Read the current continue depth without mutating. */
export const currentAutopilotDepth = (
  tracker: AutopilotContinueTracker,
  sessionId: string,
): number => tracker.depths.get(sessionId) ?? 0;

/**
 * Predicate that returns a halt directive when the tracker's cap has been
 * exceeded for this session. When Autopilot is off (`autopilotEngaged` is
 * false) the tracker always returns `null` — the cap only gates unattended
 * chains.
 */
export type AutopilotHaltDecision = { halt: true; message: string } | null;

export const shouldHaltAutopilot = (
  tracker: AutopilotContinueTracker,
  sessionId: string,
  autopilotEngaged: boolean,
): AutopilotHaltDecision => {
  if (!autopilotEngaged) {
    return null;
  }
  const depth = currentAutopilotDepth(tracker, sessionId);
  if (depth > tracker.cap) {
    return { halt: true, message: AUTOPILOT_CONTINUE_LIMIT_MESSAGE };
  }
  return null;
};

/** Clear the counter for a session — call when a turn is reviewed by a human. */
export const resetAutopilotContinue = (
  tracker: AutopilotContinueTracker,
  sessionId: string,
): void => {
  tracker.depths.delete(sessionId);
};
