import type { SessionEventEnvelope } from "../protocol.js";

/**
 * Hook-dispatch surface types. PR3 ships types only; the actual dispatcher
 * lands in Phase 2 PR6. {@link dispatchHook} is a stub that throws — wire-up
 * sites should guard with explicit checks before PR6.
 */

/**
 * Identifiers for user-configured lifecycle hooks. The nine kinds below mirror
 * the phase-2 design doc's hook catalog. PR6 maps these onto external commands
 * via the config cascade.
 */
export type HookEventKind =
  | "sessionStart"
  | "preDispatch"
  | "preToolUse"
  | "postToolUse"
  | "postToolUseFailure"
  | "postDispatch"
  | "permissionRequest"
  | "notification"
  | "sessionEnd";

export type HookResponseDecision = "allow" | "deny" | "skip" | "replace";

/**
 * Wrapper passed to a hook implementation: the full envelope plus the hook
 * kind that triggered the dispatch. Kept generic so specific hook producers
 * can re-export stricter shapes in PR6.
 */
export type HookEnvelope<K extends HookEventKind = HookEventKind> = {
  envelope: SessionEventEnvelope;
  hookKind: K;
};

/**
 * Result returned by a hook dispatcher. `replace` callers must also supply the
 * replacement payload or envelope; the exact shape is defined in PR6.
 */
export type HookResult = {
  decision: HookResponseDecision;
  reason?: string;
  replacement?: Record<string, unknown>;
};

/**
 * Placeholder dispatcher. PR6 wires this through the config cascade to an
 * external command. Any call site reaching this before PR6 indicates a bug.
 */
export const dispatchHook = (): never => {
  throw new Error("dispatchHook is a PR6 stub; do not call before Phase 2 PR6");
};
