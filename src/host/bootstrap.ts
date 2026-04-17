import { loadConfigCascade, type BakudoConfig } from "./config.js";
import { HOST_STATE_SCHEMA_VERSION, loadHostState } from "./hostStateStore.js";
import type { HostStateRecord } from "./hostStateStore.js";
import { repoRootFor } from "./orchestration.js";
import { profileCheckpoint, profileReport } from "./startupProfiler.js";

export type AboxCapabilityProbe = {
  /** Stubbed until Phase 6 Workstream 3 wires the real probe. */
  kind: "stub";
  /** Best-effort hint only; actual capability negotiation happens in the sandbox. */
  version?: string;
};

export type HostBootstrap = {
  repoRoot: string;
  hostState: HostStateRecord | null;
  /** Merged config cascade (defaults + user + repo + env; CLI not applied here). */
  config: BakudoConfig;
  aboxCapabilities: AboxCapabilityProbe;
  /** Cleanup hooks registered by bootstrap. */
  dispose: () => Promise<void>;
};

/**
 * Wrap an async initializer so concurrent callers share the same promise.
 *
 * Exported for testing: the 2026-04-15 bootstrap second-pass explicitly
 * requires that the host cannot kick off two `initHost` pipelines when the
 * CLI is invoked by overlapping processes or tests.
 */
export const memoize = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending !== null) {
      return pending;
    }
    pending = fn().catch((error: unknown) => {
      // Allow retry after a rejection — otherwise a transient filesystem
      // failure would permanently break the cached bootstrap promise.
      pending = null;
      throw error;
    });
    return pending;
  };
};

type SignalHandler = (name: string, handler: () => void) => unknown;
type ErrorHandler = (name: string, handler: (err: unknown) => void) => unknown;
type ProcessLike = {
  on?: SignalHandler & ErrorHandler;
  off?: SignalHandler & ErrorHandler;
  env?: Record<string, string | undefined>;
};

const getProcess = (): ProcessLike | undefined => (globalThis as { process?: ProcessLike }).process;

const applySafeEnv = (): void => {
  const env = getProcess()?.env;
  if (env === undefined) {
    return;
  }
  // NO_COLOR: respected by the ansi helpers; the bootstrap defers to a user
  // override but does not clobber an existing explicit value.
  if (env.NO_COLOR === undefined && env.FORCE_COLOR === undefined) {
    // leave unset — ansi helpers auto-detect TTY
  }
  // BAKUDO_LOG_LEVEL placeholder; real config cascade lands in Phase 2.
  if (env.BAKUDO_LOG_LEVEL === undefined) {
    env.BAKUDO_LOG_LEVEL = "info";
  }
};

const registerShutdownHandlers = (): (() => Promise<void>) => {
  const proc = getProcess();
  const registered: Array<[string, () => void]> = [];
  const onTerm = (): void => {
    void profileReport();
  };
  const onUncaught = (): void => {
    void profileReport();
  };
  if (proc?.on) {
    proc.on("SIGINT", onTerm);
    proc.on("SIGTERM", onTerm);
    proc.on("uncaughtException", onUncaught);
    registered.push(["SIGINT", onTerm], ["SIGTERM", onTerm], ["uncaughtException", onUncaught]);
  }
  let disposed = false;
  return async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (proc?.off) {
      for (const [name, handler] of registered) {
        proc.off(name, handler);
      }
    }
    await profileReport();
  };
};

const prefetchHostState = async (repoRoot: string): Promise<HostStateRecord | null> => {
  try {
    return await loadHostState(repoRoot);
  } catch {
    return null;
  }
};

const probeAboxCapabilities = async (): Promise<AboxCapabilityProbe> =>
  // Deliberate stub — Phase 6 Workstream 3 replaces with a real
  // `abox --probe` roundtrip.
  ({ kind: "stub" });

/**
 * preAction bootstrap. Loads the minimum state needed before a subcommand
 * runs, registers graceful-shutdown handlers, and kicks off async prefetches
 * so the first real call doesn't pay their latency. Heavy work is deferred.
 */
export const initHost = memoize(async (): Promise<HostBootstrap> => {
  profileCheckpoint("preaction_entry");

  const repoRoot = repoRootFor(undefined);
  applySafeEnv();
  const dispose = registerShutdownHandlers();

  const [hostState, aboxCapabilities, configResult] = await Promise.all([
    prefetchHostState(repoRoot),
    probeAboxCapabilities(),
    loadConfigCascade(repoRoot, {}),
  ]);

  profileCheckpoint("preaction_done");

  return {
    repoRoot,
    hostState,
    config: configResult.merged,
    aboxCapabilities,
    dispose,
  };
});

/**
 * Drive `fn` under the bootstrap, guaranteeing disposal even on throw. The
 * memoization above means nested `withBootstrap` calls reuse the same boot.
 */
export const withBootstrap = async <T>(fn: (b: HostBootstrap) => Promise<T>): Promise<T> => {
  const boot = await initHost();
  try {
    return await fn(boot);
  } finally {
    await boot.dispose();
  }
};

export { HOST_STATE_SCHEMA_VERSION };
