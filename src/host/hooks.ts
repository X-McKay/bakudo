import type { SessionEventEnvelope } from "../protocol.js";

/**
 * Hook-dispatch surface types and internal dispatch pipeline.
 * PR3 shipped types; PR6 delivers the dispatcher contract.
 *
 * Wave 6c PR9 adds a user-configurable command-hook surface specified at
 * plan 06 lines 740–764, implemented in the sibling module
 * `./hookCommandRunner.ts`. The existing in-process {@link dispatchHook}
 * pipeline is retained unchanged for internal handlers (W2 recovery,
 * W4 permissionRequest hook on the approval producer).
 */

/**
 * Identifiers for user-configured lifecycle hooks. The nine kinds below mirror
 * the phase-2 design doc's hook catalog.
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
 * kind that triggered the dispatch.
 */
export type HookEnvelope<K extends HookEventKind = HookEventKind> = {
  envelope: SessionEventEnvelope;
  hookKind: K;
};

/**
 * Result returned by a hook handler. `replace` callers must also supply the
 * replacement payload via the `replacement` field.
 */
export type HookResult = {
  decision: HookResponseDecision;
  reason?: string;
  replacement?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Dispatch pipeline
// ---------------------------------------------------------------------------

/** A single hook handler: receives an envelope, returns a result. */
export type HookHandler = (envelope: HookEnvelope) => Promise<HookResult>;

/** Registry mapping hook kinds to ordered handler lists. */
export type HookRegistry = Map<HookEventKind, HookHandler[]>;

/** Create an empty hook registry. */
export const createHookRegistry = (): HookRegistry => new Map();

/** Append a handler for the given hook kind. */
export const registerHook = (
  registry: HookRegistry,
  kind: HookEventKind,
  handler: HookHandler,
): void => {
  const existing = registry.get(kind);
  if (existing !== undefined) {
    existing.push(handler);
  } else {
    registry.set(kind, [handler]);
  }
};

/** Hook kinds that always dispatch asynchronously (fire-and-forget). */
type AsyncHookKind = "notification";

/** Hook kinds that always dispatch synchronously (blocking). */
type SyncHookKind = "permissionRequest";

const ASYNC_KINDS: ReadonlySet<HookEventKind> = new Set<AsyncHookKind>(["notification"]);

const DEFAULT_TIMEOUT_MS = 10_000;

const isSyncByDefault = (kind: HookEventKind): boolean => !ASYNC_KINDS.has(kind);

/**
 * Race a promise against a timeout. Resolves with the promise value or
 * `undefined` on timeout.
 */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        // Propagate errors — caller converts to deny.
        resolve(Promise.reject(error));
      },
    );
  });

export type DispatchHookOptions = {
  /** Per-dispatch timeout in milliseconds. Default: 10 000. */
  timeout?: number;
  /**
   * Force sync or async mode. When omitted, `permissionRequest` is sync,
   * `notification` is async, and all others are sync by default.
   */
  sync?: boolean;
};

/**
 * Dispatch a hook event to all registered handlers for the given kind.
 *
 * - **Sync mode** (default for all kinds except `notification`): runs handlers
 *   sequentially. Any `deny` result short-circuits — later handlers are skipped.
 *   Timeout or thrown error → `deny`.
 * - **Async mode** (default for `notification`): fires all handlers via
 *   `Promise.allSettled` with no await at the call site. Returns an empty
 *   result list immediately.
 */
export const dispatchHook = async (
  registry: HookRegistry,
  kind: HookEventKind,
  envelope: SessionEventEnvelope,
  options?: DispatchHookOptions,
): Promise<HookResult[]> => {
  const handlers = registry.get(kind);
  if (handlers === undefined || handlers.length === 0) {
    return [];
  }

  const timeoutMs = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const sync = options?.sync ?? isSyncByDefault(kind);
  const hookEnvelope: HookEnvelope = { envelope, hookKind: kind };

  if (!sync) {
    // Async (fire-and-forget): kick off all handlers, don't await.
    void Promise.allSettled(
      handlers.map((handler) => withTimeout(handler(hookEnvelope), timeoutMs).catch(() => {})),
    );
    return [];
  }

  // Sync: sequential with deny-precedence short-circuit.
  const results: HookResult[] = [];
  for (const handler of handlers) {
    try {
      const result = await withTimeout(handler(hookEnvelope), timeoutMs);
      if (result === undefined) {
        // Timeout → deny for sync hooks.
        const denyResult: HookResult = { decision: "deny", reason: "hook timed out" };
        results.push(denyResult);
        return results;
      }
      results.push(result);
      if (result.decision === "deny") {
        return results;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const denyResult: HookResult = { decision: "deny", reason };
      results.push(denyResult);
      return results;
    }
  }
  return results;
};

// Re-export kind discriminators for external consumers.
export type { SyncHookKind, AsyncHookKind };

// Wave 6c PR9 — user-configurable command-hook surface (plan 06 lines 740–764)
// lives in `./hookCommandRunner.ts` to keep this file under the 400-LOC cap.
// Consumers import it directly from that module.
