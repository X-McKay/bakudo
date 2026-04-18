/**
 * Small state machine that buffers strokes for multi-key chord bindings.
 *
 * Usage pattern (at the dispatch site):
 *   1. On each stroke, call `matchBinding(event, chord.current(), bindings)`.
 *   2. If the result is `{ partial: true }`, call `chord.push(event)`.
 *   3. If the result is `{ action }`, dispatch and then `chord.reset()`.
 *   4. If the result is `null`, `chord.reset()`.
 *
 * The tracker also self-resets if no stroke arrives within `timeoutMs`
 * (default 1000ms per `05-…hardening.md:563-564`).
 *
 * This module is pure state; it has no I/O and no dependency on node timers
 * other than the ambient `setTimeout`/`clearTimeout` signatures.
 */
import type { KeyStroke } from "./parser.js";

export type ChordState = {
  strokes: KeyStroke[];
  timerId?: ReturnType<typeof setTimeout>;
};

export type ChordTracker = {
  push: (stroke: KeyStroke) => void;
  reset: () => void;
  current: () => KeyStroke[];
};

export type ChordTrackerOptions = {
  timeoutMs?: number;
  /**
   * Optional hook invoked when the tracker auto-resets due to timeout.
   * Mainly useful in tests and for dev logging; production callers can omit.
   */
  onTimeout?: () => void;
};

const DEFAULT_TIMEOUT_MS = 1000;

export const createChordTracker = (opts: ChordTrackerOptions = {}): ChordTracker => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const state: ChordState = { strokes: [] };

  const clearTimer = (): void => {
    if (state.timerId !== undefined) {
      clearTimeout(state.timerId);
      delete state.timerId;
    }
  };

  const armTimer = (): void => {
    clearTimer();
    state.timerId = setTimeout(() => {
      state.strokes = [];
      delete state.timerId;
      if (opts.onTimeout !== undefined) {
        opts.onTimeout();
      }
    }, timeoutMs);
  };

  return {
    push: (stroke: KeyStroke): void => {
      state.strokes.push(stroke);
      armTimer();
    },
    reset: (): void => {
      clearTimer();
      state.strokes = [];
    },
    current: (): KeyStroke[] => state.strokes.slice(),
  };
};
