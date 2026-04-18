/**
 * Phase 6 W3 helper — persist the failed-attempt record left after
 * `ABoxTaskRunner.runAttempt` throws `WorkerProtocolMismatchError`. The
 * decoration lives on `attempt.metadata.protocolMismatch` so the
 * `inspectFormatter` can read it without coupling to the error class.
 *
 * Extracted from `executeAttempt.ts` to keep that file under the 400-line
 * cap (CLAUDE.md hard constraint).
 */

import type { AttemptSpec } from "../attemptProtocol.js";
import type { SessionStore } from "../sessionStore.js";
import type { WorkerProtocolMismatchError } from "./errors.js";

export type PersistProtocolMismatchInput = {
  sessionStore: SessionStore;
  sessionId: string;
  turnId: string;
  spec: AttemptSpec;
  error: WorkerProtocolMismatchError;
};

/**
 * Decorate the queued attempt with `status: "failed"` and a
 * `metadata.protocolMismatch` payload so post-mortem surfaces (`inspect`,
 * the JSON event log) carry the diagnostic that produced the throw.
 *
 * The error itself is NOT swallowed — the caller re-throws so the host's
 * top-level classifier still returns exit code 4.
 */
export const persistProtocolMismatchAttempt = async (
  input: PersistProtocolMismatchInput,
): Promise<void> => {
  const { sessionStore, sessionId, turnId, spec, error } = input;
  const metadata: Record<string, unknown> = {
    protocolMismatch: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.recoveryHint !== undefined ? { recoveryHint: error.recoveryHint } : {}),
    },
  };
  await sessionStore.upsertAttempt(sessionId, turnId, {
    attemptId: spec.attemptId,
    status: "failed",
    lastMessage: error.message,
    attemptSpec: spec,
    metadata,
  });
};
