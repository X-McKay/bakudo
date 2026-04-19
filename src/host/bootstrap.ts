import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";

import type { SessionEventEnvelope } from "../protocol.js";
import { loadConfigCascade, type BakudoConfig } from "./config.js";
import { setExperimentalConfigResolver } from "./flags.js";
import { HOST_STATE_SCHEMA_VERSION, loadHostState } from "./hostStateStore.js";
import type { HostStateRecord } from "./hostStateStore.js";
import { getMetricsRecorder } from "./metrics/metricsRecorder.js";
import { repoRootFor } from "./sessionRunSupport.js";
import { profileCheckpoint, profileReport } from "./startupProfiler.js";
import {
  HEAP_WATCHDOG_GATE_ENV,
  HEAP_RSS_THRESHOLD_ENV,
  isWatchdogEnabled,
  parseThresholdEnv,
  startHeapWatchdog,
  type HeapWatchdogHandle,
} from "./telemetry/heapWatchdog.js";
import { resolveLogLevel, type LogLevel } from "./telemetry/logLevel.js";
import { bakudoLogDir } from "./telemetry/xdgPaths.js";
import { migrateToXdg, realMigrationFs, type MigrationPaths } from "./xdgMigration.js";

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
  /**
   * Resolved effective log level for this process. Wave 6c PR7 (A6.7):
   * result of `resolveLogLevel(config → env → CLI → TTY heuristic)`.
   * Callers that want to gate verbose output consult this instead of
   * reading `process.env.BAKUDO_LOG_LEVEL` directly.
   */
  logLevel: Exclude<LogLevel, "default">;
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
  // Wave 6c PR7 (A6.7): BAKUDO_LOG_LEVEL is no longer auto-populated here.
  // The real effective level is resolved by `resolveLogLevel` from the
  // cascade (config → env → CLI → TTY heuristic). Preserving user-set
  // BAKUDO_LOG_LEVEL values is intentional — that env var is still a
  // runtime override.
};

const registerShutdownHandlers = (watchdog: HeapWatchdogHandle | null): (() => Promise<void>) => {
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
    // Wave 6c PR7 (A6.6): stop the heap watchdog timer so a short-lived
    // CLI command can exit cleanly. The interval is `.unref()`-ed at
    // start so this is belt-and-braces, not load-bearing.
    if (watchdog !== null) {
      watchdog.stop();
    }
    await profileReport();
  };
};

/**
 * Wave 6c PR7 (A6.6) — opt-in heap-snapshot watchdog. Returns `null` when
 * the gate env var is not set to `"1"`. The watchdog's interval is
 * `unref()`-ed so a short-lived CLI never blocks on shutdown.
 */
const maybeStartHeapWatchdog = (): HeapWatchdogHandle | null => {
  const env = getProcess()?.env ?? {};
  if (!isWatchdogEnabled(env)) {
    return null;
  }
  const thresholdBytes = parseThresholdEnv(env[HEAP_RSS_THRESHOLD_ENV]);
  return startHeapWatchdog({ thresholdBytes });
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
 * Phase 6 Wave 6e PR16 — append the migration envelope to a dedicated
 * `bootstrap-events.ndjson` sibling to the time-delta logs. Separate file
 * (not a session log) because the migration happens pre-session. Emission
 * failures must never block bootstrap — diagnostic is fire-and-forget.
 */
const appendBootstrapEvent = async (
  logDir: string,
  envelope: SessionEventEnvelope,
): Promise<void> => {
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(`${logDir}/bootstrap-events.ndjson`, `${JSON.stringify(envelope)}\n`, "utf8");
  } catch {
    /* swallow — diagnostic emission MUST NOT break bootstrap */
  }
};

/**
 * Phase 6 Wave 6e PR16 — one-way `.bakudo/` → XDG migration. Runs before
 * config/state reads so the first legitimate consumer sees the new layout.
 * Idempotent after the marker lands. Failure must not wedge startup.
 */
const runXdgMigrationIfNeeded = async (repoRoot: string): Promise<void> => {
  const logDir = bakudoLogDir();
  const paths: MigrationPaths = {
    repoRoot,
    home: homedir(),
    xdgLogDir: logDir,
  };
  try {
    await migrateToXdg({
      fs: realMigrationFs({ mutate: true }),
      paths,
      emit: (env) => {
        void appendBootstrapEvent(logDir, env);
      },
    });
  } catch {
    // A hard failure here must NOT wedge every bakudo invocation. The
    // marker remains unwritten and the next launch retries.
  }
};

/**
 * preAction bootstrap. Loads the minimum state needed before a subcommand
 * runs, registers graceful-shutdown handlers, and kicks off async prefetches
 * so the first real call doesn't pay their latency. Heavy work is deferred.
 */
export const initHost = memoize(async (): Promise<HostBootstrap> => {
  profileCheckpoint("preaction_entry");
  // Wave 6d PR11 (W7 shell-startup metric): record the entry-time mark so
  // the render loop can compute shell-startup latency on first paint.
  getMetricsRecorder().mark("shell.startup_begin");

  const repoRoot = repoRootFor(undefined);
  applySafeEnv();
  // Wave 6e PR16 — one-way `.bakudo/` → XDG migration. Runs BEFORE the
  // async fan-out so the first config/state read sees the new layout.
  // Idempotent after first success.
  await runXdgMigrationIfNeeded(repoRoot);
  // Wave 6c PR7 (A6.6): start the opt-in heap watchdog BEFORE the async
  // fan-out so a long-blocking fs.stat during config load is visible on
  // the watchdog's RSS samples. Disposal cleans it up.
  const watchdog = maybeStartHeapWatchdog();
  const dispose = registerShutdownHandlers(watchdog);

  const [hostState, aboxCapabilities, configResult] = await Promise.all([
    prefetchHostState(repoRoot),
    probeAboxCapabilities(),
    loadConfigCascade(repoRoot, {}),
  ]);

  // Phase 5 PR13: expose the merged experimental config to `flags.ts` so
  // `experimental(flag)` can consult the cascade at the access site.
  setExperimentalConfigResolver(() => configResult.merged.experimental);

  // Wave 6c PR7 (A6.7): resolve the effective log level from the cascade +
  // env override. CLI flags are applied by hostCli after parsing; the
  // bootstrap-level value is the "no CLI flag" baseline and is re-resolved
  // by callers that have a CLI argv in hand.
  const env = getProcess()?.env ?? {};
  const tty =
    (globalThis as unknown as { process?: { stdout?: { isTTY?: boolean } } }).process?.stdout
      ?.isTTY === true;
  const logLevel = resolveLogLevel({
    ...(configResult.merged.logLevel !== undefined ? { config: configResult.merged.logLevel } : {}),
    ...(env.BAKUDO_LOG_LEVEL !== undefined ? { env: env.BAKUDO_LOG_LEVEL } : {}),
    isTty: tty,
  });

  profileCheckpoint("preaction_done");

  return {
    repoRoot,
    hostState,
    config: configResult.merged,
    aboxCapabilities,
    logLevel,
    dispose,
  };
});

/** Re-export constants for consumers that want to document the gating env. */
export { HEAP_WATCHDOG_GATE_ENV, HEAP_RSS_THRESHOLD_ENV };

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
