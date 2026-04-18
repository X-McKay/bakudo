/**
 * Crash-recovery + graceful-shutdown signal handlers for the interactive host.
 *
 * Phase 5 PR5. Complements `TtyBackend.dispose()` — without these handlers a
 * fatal signal (Ctrl+C, process kill, uncaught throw) would leave the terminal
 * stuck in the alt-screen buffer with the cursor hidden. Cleanup handlers run
 * in LIFO order so the TtyBackend (registered early in `runInteractiveShell`)
 * disposes after later-registered listeners have had a chance to quiesce.
 *
 * Contract (per scope memo):
 *  - SIGINT → cleanup + `process.exit(130)` (POSIX Ctrl+C convention).
 *  - SIGTERM → cleanup + `process.exit(143)`.
 *  - uncaughtException / unhandledRejection → cleanup + stderr log + exit(1).
 *
 * Handler errors are caught and logged to stderr; they do NOT block subsequent
 * cleanups. This is deliberate: one broken cleanup must not leave the terminal
 * wedged.
 */

export type CleanupHandler = () => void | Promise<void>;

type SignalListener = (signal: string) => void;
type ErrorListener = (err: unknown) => void;
type PromiseRejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

type ProcessLike = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  exit?: (code?: number) => never;
  stderr?: { write?: (chunk: string) => unknown };
};

const getProcess = (): ProcessLike | undefined =>
  (globalThis as unknown as { process?: ProcessLike }).process;

// Module-level handler list. A Set would lose ordering; an array preserves
// insertion order so we can pop LIFO.
const handlers: CleanupHandler[] = [];

/** Register a cleanup handler. Returns an unregister function. */
export const registerCleanupHandler = (handler: CleanupHandler): (() => void) => {
  handlers.push(handler);
  return () => {
    const idx = handlers.lastIndexOf(handler);
    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  };
};

/** Test-only: clear all registered handlers. */
export const clearCleanupHandlers = (): void => {
  handlers.length = 0;
};

/** Test-only: read the current handler count. */
export const cleanupHandlerCount = (): number => handlers.length;

const writeToStderr = (proc: ProcessLike | undefined, message: string): void => {
  const stderr = proc?.stderr;
  const write = stderr?.write;
  if (stderr !== undefined && typeof write === "function") {
    try {
      write.call(stderr, message);
    } catch {
      // Swallow — the terminal may already be in an inconsistent state; the
      // priority is reaching `process.exit`.
    }
  }
};

const logToStderr = (message: string): void => {
  writeToStderr(getProcess(), message);
};

/** Run all registered handlers in LIFO order; errors logged, not propagated. */
export const runCleanupHandlers = async (): Promise<void> => {
  // Snapshot + reverse so we traverse last-registered-first. Pop from the
  // shared list as we go so a later signal can't double-run the same handler.
  const snapshot = handlers.slice().reverse();
  handlers.length = 0;
  for (const handler of snapshot) {
    try {
      await handler();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logToStderr(`cleanup_handler_error: ${message}\n`);
    }
  }
};

export type InstallSignalHandlersOptions = {
  /** Invoked after cleanup, before `process.exit`. Primarily for tests. */
  onFatal?: (signalOrError: string | Error) => void;
  /**
   * Injected process-exit. Defaults to `process.exit`. Tests pass a spy so
   * the runner doesn't actually terminate.
   */
  exit?: (code: number) => void;
  /** Injected process for tests. Defaults to global `process`. */
  process?: ProcessLike;
};

/**
 * Install SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers.
 * Returns a single uninstaller; calling it removes every listener this call
 * registered. Idempotent: the uninstaller may be invoked multiple times.
 */
export const installSignalHandlers = (opts: InstallSignalHandlersOptions = {}): (() => void) => {
  const proc = opts.process ?? getProcess();
  if (proc?.on === undefined || proc.off === undefined) {
    // No-op environment (browser, worker without process). Return a trivial
    // uninstaller so callers don't need to branch.
    return () => {};
  }

  const exit = opts.exit ?? ((code: number): void => proc.exit?.(code));

  const onSignal =
    (signal: string, code: number): SignalListener =>
    () => {
      void (async (): Promise<void> => {
        await runCleanupHandlers();
        opts.onFatal?.(signal);
        exit(code);
      })();
    };

  const onUncaughtException: ErrorListener = (err) => {
    void (async (): Promise<void> => {
      await runCleanupHandlers();
      const error = err instanceof Error ? err : new Error(String(err));
      writeToStderr(proc, `uncaught_exception: ${error.message}\n`);
      if (error.stack !== undefined) {
        writeToStderr(proc, `${error.stack}\n`);
      }
      opts.onFatal?.(error);
      exit(1);
    })();
  };

  const onUnhandledRejection: PromiseRejectionListener = (reason) => {
    void (async (): Promise<void> => {
      await runCleanupHandlers();
      const error = reason instanceof Error ? reason : new Error(String(reason));
      writeToStderr(proc, `unhandled_rejection: ${error.message}\n`);
      if (error.stack !== undefined) {
        writeToStderr(proc, `${error.stack}\n`);
      }
      opts.onFatal?.(error);
      exit(1);
    })();
  };

  const sigintHandler = onSignal("SIGINT", 130);
  const sigtermHandler = onSignal("SIGTERM", 143);

  proc.on("SIGINT", sigintHandler as (...args: unknown[]) => void);
  proc.on("SIGTERM", sigtermHandler as (...args: unknown[]) => void);
  proc.on("uncaughtException", onUncaughtException as (...args: unknown[]) => void);
  proc.on("unhandledRejection", onUnhandledRejection as (...args: unknown[]) => void);

  let uninstalled = false;
  return () => {
    if (uninstalled) {
      return;
    }
    uninstalled = true;
    proc.off?.("SIGINT", sigintHandler as (...args: unknown[]) => void);
    proc.off?.("SIGTERM", sigtermHandler as (...args: unknown[]) => void);
    proc.off?.("uncaughtException", onUncaughtException as (...args: unknown[]) => void);
    proc.off?.("unhandledRejection", onUnhandledRejection as (...args: unknown[]) => void);
  };
};
