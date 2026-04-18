/**
 * Phase 5 PR11 — apply Copilot-parity CLI flags to their module-scoped
 * receivers before dispatch, then reset them afterward.
 *
 * The flags themselves are parsed into `HostCliArgs.copilot` in
 * `src/host/parsing.ts`. The wiring happens at three semantic points:
 *
 * 1. Renderer selection — `--output-format=json` routes frames through
 *    {@link JsonBackend} via {@link selectRendererBackend}.
 * 2. Approval dialog — `--no-ask-user` switches {@link launchApprovalDialog}
 *    from "enqueue overlay" to "throw".
 * 3. Diff artifacts — `--plain-diff` strips ANSI in the artifact-writer path.
 *
 * `--allow-all-tools` and `--max-autopilot-continues` live in the session
 * controller (they need per-session state or the composer mode).
 */

import { resetNoAskUser, setNoAskUser } from "./dialogLauncher.js";
import type { CopilotParityFlags } from "./parsing.js";
import type { ReviewClassification } from "../resultClassifier.js";
import { resetPlainDiff, setPlainDiff } from "./sessionArtifactWriter.js";

/**
 * Apply the pure-side-effect Copilot flags for the current CLI invocation.
 * Returns a disposer that unwinds every set-call in reverse order. Callers
 * MUST invoke the disposer (typically via `try/finally`) so state does not
 * leak between `runHostCli` entries, notably in unit tests.
 */
export const applyCopilotSideEffects = (flags: CopilotParityFlags): (() => void) => {
  if (flags.noAskUser === true) {
    setNoAskUser(true);
  }
  if (flags.plainDiff === true) {
    setPlainDiff(true);
  }
  return () => {
    // Reset in reverse order.
    if (flags.plainDiff === true) {
      resetPlainDiff();
    }
    if (flags.noAskUser === true) {
      resetNoAskUser();
    }
  };
};

/**
 * Does the current invocation opt into the JSON output stream? Equivalent
 * to `selectRendererBackend({ useJson: true })` when true.
 */
export const shouldUseJsonOutput = (flags: CopilotParityFlags): boolean =>
  flags.outputFormat === "json";

/**
 * `--stream=off` buffers stdout until the worker terminal event. Exposed as
 * a predicate so `runNonInteractiveOneShot` can replace `stdoutWrite` with
 * a buffered writer for the duration of a single dispatch.
 */
export const shouldBufferStream = (flags: CopilotParityFlags): boolean => flags.streamOff === true;

/**
 * Shape of the single-line review summary emitted when `--output-format=json`
 * is active on a one-shot `bakudo -p ...` invocation. Mirrors the envelope
 * the JsonBackend uses so downstream consumers can parse both with one
 * JSON-per-line reader.
 */
export type OneShotReviewJsonEnvelope = {
  kind: "review_completed";
  sessionId: string;
  outcome: ReviewClassification["outcome"];
  action: ReviewClassification["action"];
  reason: string;
  needsUser: boolean;
  retryable: boolean;
  confidence: ReviewClassification["confidence"];
};

/** Pure builder for {@link OneShotReviewJsonEnvelope}. Used by one-shot emit + tests. */
export const buildOneShotReviewEnvelope = (
  sessionId: string,
  reviewed: ReviewClassification,
): OneShotReviewJsonEnvelope => ({
  kind: "review_completed",
  sessionId,
  outcome: reviewed.outcome,
  action: reviewed.action,
  reason: reviewed.reason,
  needsUser: reviewed.needsUser,
  retryable: reviewed.retryable,
  confidence: reviewed.confidence,
});
