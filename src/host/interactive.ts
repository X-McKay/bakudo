import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { basename } from "node:path";

import { initialHostAppState, type ComposerMode } from "./appState.js";
import { buildDefaultCommandRegistry } from "./commandRegistryDefaults.js";
import { loadConfigCascade } from "./config.js";
import {
  dispatchChronicleCommand,
  dispatchCleanupCommand,
  dispatchDoctorCommand,
  dispatchHelpCommand,
  dispatchInspectCommand,
  dispatchMetricsCommand,
  dispatchUsageCommand,
  dispatchVersionCommand,
} from "./distributionCommands.js";
import { emitUserTurnSubmitted } from "./eventLogWriter.js";
import {
  HOST_STATE_SCHEMA_VERSION,
  loadHostState,
  saveHostState,
  type HostStateRecord,
} from "./hostStateStore.js";
import { runtimeIo, withCapturedStdout, type TextWriter } from "./io.js";
import { runInit } from "./init.js";
import {
  createSessionRenderer,
  deriveShellContext,
  executePrompt,
  type InteractiveResolution,
  type ShellContext,
  type TickDeps,
} from "./interactiveRenderLoop.js";
import { registerKeybinding } from "./keybindings/hooks.js";
import { installSignalHandlers, registerCleanupHandler } from "./signalHandlers.js";
import {
  buildInteractiveRunResolution,
  createInteractiveSessionIdentity,
  rememberInteractiveContext,
  renderPrompt,
  resolveInteractiveInput,
  resolveSessionScopedInteractiveCommand,
  sessionPromptLabel,
} from "./interactiveResolvers.js";
import { getMetricsRecorder } from "./metrics/metricsRecorder.js";
import { resumeSession } from "./sessionLifecycle.js";
import { repoRootFor, resolveRuntimeHostArgs, storageRootFor } from "./sessionRunSupport.js";
import { parseHostArgs, tokenizeCommand, type HostCliArgs } from "./parsing.js";
import {
  printLogs,
  printReview,
  printSandbox,
  printSessions,
  printStatus,
  printTasks,
} from "./printers.js";
import {
  answerPrompt,
  cancelPrompt as cancelPendingPrompt,
  resetPromptResolvers,
} from "./promptResolvers.js";
import { createProgressCoalescer } from "./progressCoalescer.js";
import { reduceHost } from "./reducer.js";
import type { TranscriptItem } from "./renderModel.js";
import { createHostStore } from "./store/index.js";
import { buildTranscriptFacade } from "./transcriptFacade.js";
import {
  appendTurnToActiveSession,
  createAndRunFirstTurn,
  type SessionDispatchResult,
} from "./sessionController.js";
import { printUsage } from "./usage.js";

export type { InteractiveResolution } from "./interactiveRenderLoop.js";
export { buildInteractiveRunResolution, createInteractiveSessionIdentity };
export { rememberInteractiveContext, renderPrompt, resolveInteractiveInput, sessionPromptLabel };
export { resolveSessionScopedInteractiveCommand };

// Phase 5 PR11 — one-shot dispatch extracted to `./oneShotRun.ts` so this
// file stays under the 400-line cap. Re-exported for backward compatibility.
import { runNonInteractiveOneShot } from "./oneShotRun.js";
export { runNonInteractiveOneShot };

export const dispatchHostCommand = async (args: HostCliArgs): Promise<number> => {
  const runtimeArgs = await resolveRuntimeHostArgs(args);
  // Wave 6d PR11 review blocker B2: user-initiated top-level dispatch — one
  // increment per invocation. `dispatchHostCommand` has a single caller
  // (`hostCli.ts`) and does not recurse, so double-counting is not possible
  // from the current call graph. If a future refactor adds a recursive
  // internal dispatch, this site needs to be guarded.
  getMetricsRecorder().incWorkflowCommand();
  if (runtimeArgs.command === "help") {
    return dispatchHelpCommand(runtimeArgs);
  }
  if (runtimeArgs.command === "version") {
    return dispatchVersionCommand(runtimeArgs);
  }
  if (runtimeArgs.command === "doctor") {
    return dispatchDoctorCommand(runtimeArgs);
  }
  if (runtimeArgs.command === "cleanup") {
    return dispatchCleanupCommand(runtimeArgs);
  }
  if (runtimeArgs.command === "usage") {
    return dispatchUsageCommand(runtimeArgs);
  }
  if (runtimeArgs.command === "chronicle") {
    return dispatchChronicleCommand(runtimeArgs);
  }
  if (runtimeArgs.command === "metrics") {
    return dispatchMetricsCommand(runtimeArgs);
  }
  if (
    runtimeArgs.command === "run" ||
    runtimeArgs.command === "build" ||
    runtimeArgs.command === "plan"
  ) {
    return runNonInteractiveOneShot(runtimeArgs);
  }
  if (runtimeArgs.command === "sessions") {
    return printSessions(runtimeArgs);
  }
  if (runtimeArgs.command === "status") {
    return printStatus(runtimeArgs);
  }
  if (runtimeArgs.command === "sandbox") {
    return printSandbox(runtimeArgs);
  }
  if (runtimeArgs.command === "resume") {
    return resumeSession(runtimeArgs);
  }
  if (runtimeArgs.command === "tasks") {
    return printTasks(runtimeArgs);
  }
  if (runtimeArgs.command === "review") {
    return printReview(runtimeArgs);
  }
  if (runtimeArgs.command === "inspect") {
    return dispatchInspectCommand(runtimeArgs);
  }
  if (runtimeArgs.command === "init") {
    return runInit(runtimeArgs);
  }
  return printLogs(runtimeArgs);
};

const buildHostStateFromDeps = (deps: TickDeps): HostStateRecord => ({
  schemaVersion: HOST_STATE_SCHEMA_VERSION,
  lastUsedMode: deps.appState.composer.mode,
  autoApprove: deps.appState.composer.autoApprove,
  ...(deps.appState.activeSessionId ? { lastActiveSessionId: deps.appState.activeSessionId } : {}),
  ...(deps.appState.activeTurnId ? { lastActiveTurnId: deps.appState.activeTurnId } : {}),
});

const applyHostStateToStore = (
  store: ReturnType<typeof createHostStore>,
  record: HostStateRecord,
): void => {
  store.dispatch({ type: "set_mode", mode: record.lastUsedMode });
  if (record.lastActiveSessionId) {
    store.dispatch({
      type: "set_active_session",
      sessionId: record.lastActiveSessionId,
      ...(record.lastActiveTurnId ? { turnId: record.lastActiveTurnId } : {}),
    });
  }
};

const baseInteractiveArgs = (mode: "build" | "plan", autoApprove: boolean): HostCliArgs => ({
  command: "run",
  config: "config/default.json",
  aboxBin: "abox",
  mode,
  yes: autoApprove,
  shell: "bash",
  timeoutSeconds: 120,
  maxOutputBytes: 256 * 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  copilot: {},
});

type ControllerRoute = { goal: string; overrideMode?: "build" | "plan" };

const routePromptToController = (line: string): ControllerRoute | null => {
  if (!line.startsWith("/")) {
    return { goal: line };
  }
  const [command = "", ...rest] = tokenizeCommand(line.slice(1));
  if (command !== "run" && command !== "build" && command !== "plan") {
    return null;
  }
  const goal = rest.join(" ").trim();
  if (goal.length === 0) {
    return null;
  }
  return command === "run" ? { goal } : { goal, overrideMode: command };
};

const composerModeToTaskMode = (mode: ComposerMode): "build" | "plan" =>
  mode === "plan" ? "plan" : "build";

// Discards bytes written to stdout during dispatch. The semantic narration
// path (via createProgressCoalescer below) is the only writer that should
// reach the transcript; raw per-event log lines from executeAttempt must not
// surface in the interactive default. Logs remain available via /inspect logs.
const sinkWriter: TextWriter = { write: () => true };

const dispatchThroughController = async (
  goal: string,
  deps: TickDeps,
  overrideMode?: "build" | "plan",
): Promise<SessionDispatchResult> => {
  const shell: ShellContext = deriveShellContext(deps.appState);
  const mode = overrideMode ?? composerModeToTaskMode(deps.appState.composer.mode);
  const baseArgs = baseInteractiveArgs(mode, shell.autoApprove);
  // Pre-generate sessionId so user.turn_submitted lands before the dispatch.
  const activeSessionId = deps.appState.activeSessionId;
  const sessionId = activeSessionId ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const initialArgs: HostCliArgs =
    activeSessionId === undefined ? { ...baseArgs, sessionId } : baseArgs;
  const args = await resolveRuntimeHostArgs(initialArgs);
  const root = storageRootFor(args.repo, args.storageRoot);
  await emitUserTurnSubmitted(root, sessionId, goal, deps.appState.composer.mode);
  const coalesce = createProgressCoalescer((item) => {
    deps.transcript.push(item);
  });
  const options = { onProgress: coalesce };
  try {
    return await withCapturedStdout(sinkWriter, async () => {
      if (activeSessionId !== undefined) {
        return appendTurnToActiveSession(activeSessionId, goal, args, options);
      }
      return createAndRunFirstTurn(goal, args, options);
    });
  } finally {
    coalesce.flushNow();
  }
};

const applyDispatchResult = (
  result: SessionDispatchResult,
  deps: TickDeps,
  store: ReturnType<typeof createHostStore>,
): void => {
  store.dispatch({
    type: "set_active_session",
    sessionId: result.sessionId,
    turnId: result.turnId,
  });
  deps.transcript.push({
    kind: "review",
    outcome: result.reviewed.outcome,
    summary: result.reviewed.reason,
    nextAction: result.reviewed.action,
  });
};

type ExecDeps = {
  resolveInput: typeof resolveInteractiveInput;
  parse: typeof parseHostArgs;
  dispatch: typeof dispatchHostCommand;
  remember: typeof rememberInteractiveContext;
};

const executePromptFromResolution = async (
  resolution: InteractiveResolution,
  line: string,
  deps: TickDeps,
  execDeps: ExecDeps,
): Promise<void> => {
  const wrapped: ExecDeps = { ...execDeps, resolveInput: () => resolution };
  await executePrompt(line, deps, wrapped);
};

const answerHeadPrompt = (line: string, deps: TickDeps): boolean => {
  const head = deps.appState.promptQueue[0];
  if (head === undefined) {
    return false;
  }
  answerPrompt(head.id, line);
  return true;
};

export const runInteractiveShell = async (): Promise<number> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    printUsage();
    return 0;
  }

  const repoRoot = repoRootFor(undefined);
  const repoLabel = basename(repoRoot) || repoRoot;
  const rl = createInterface({ input, output });

  // Load config cascade — CLI flag threading deferred to Phase 6.
  const configSnapshot = await loadConfigCascade(repoRoot, {});
  const store = createHostStore(reduceHost, initialHostAppState());

  const transcriptFacade = buildTranscriptFacade(store);

  const deps: TickDeps = {
    get transcript() {
      // Facade adapts Array-shaped call sites (.push, .length, iterator) to store dispatches; full Array API is intentionally partial.
      return transcriptFacade as unknown as TranscriptItem[];
    },
    get appState() {
      return store.getSnapshot();
    },
    repoLabel,
    config: configSnapshot.merged,
  } as TickDeps;

  resetPromptResolvers();
  const prior = await loadHostState(repoRoot);
  if (prior !== null) {
    applyHostStateToStore(store, prior);
  }

  const execDeps: ExecDeps = {
    resolveInput: resolveInteractiveInput,
    parse: parseHostArgs,
    dispatch: dispatchHostCommand,
    remember: rememberInteractiveContext,
  };

  const registry = buildDefaultCommandRegistry({
    getConfig: () => configSnapshot,
  });

  const persistHostState = async (): Promise<void> => {
    try {
      await saveHostState(repoRoot, buildHostStateFromDeps(deps));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.transcript.push({
        kind: "assistant",
        text: `Warning: could not persist host state: ${message}`,
        tone: "warning",
      });
    }
  };

  // Phase 5 PR5: session-scoped renderer + signal handlers. Single backend
  // across ticks so terminal state stays consistent; cleanup runs LIFO on
  // SIGINT/SIGTERM/uncaughtException. Phase 5-W2: the Ink backend is
  // state-driven, so `mount()` boots the React render loop once; subsequent
  // ticks are no-ops. Plain/Json backends still render per frame.
  const { tick: renderTick, backend: sessionBackend } = createSessionRenderer({
    store,
    repoLabel,
  });
  sessionBackend.mount?.();
  const unregisterBackendCleanup = registerCleanupHandler(() => {
    sessionBackend.dispose?.();
  });
  const uninstallSignals = installSignalHandlers();
  // TODO(phase5-pr5): `app:redraw` fires through the registry today; when W3
  // lands raw-key dispatch, Ctrl+L will invoke this handler on a live key.
  const unregisterRedraw = registerKeybinding("Global", "app:redraw", () => {
    renderTick(deps);
  });

  const handleSigint = (): void => {
    const head = deps.appState.promptQueue[0];
    if (head === undefined) {
      rl.close();
      return;
    }
    cancelPendingPrompt(head.id);
    store.dispatch({ type: "cancel_prompt", id: head.id });
    renderTick(deps);
  };
  type SignalHandler = (name: string, handler: () => void) => unknown;
  const nodeProcess = (globalThis as { process?: { on?: SignalHandler; off?: SignalHandler } })
    .process;
  nodeProcess?.on?.("SIGINT", handleSigint);

  renderTick(deps);
  try {
    while (true) {
      let answer: string;
      try {
        answer = await rl.question("");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes("readline was closed")) {
          return 0;
        }
        throw error;
      }
      const line = answer.trim();
      if (line.length === 0) {
        continue;
      }

      // Route answers for active prompts first.
      if (answerHeadPrompt(line, deps)) {
        renderTick(deps);
        continue;
      }

      deps.transcript.push({ kind: "user", text: line });
      const dispatched = await registry.dispatch(line, deps);
      if (dispatched.kind === "exit") {
        await persistHostState();
        return dispatched.code;
      }
      if (dispatched.kind === "handled") {
        await persistHostState();
        renderTick(deps);
        continue;
      }

      if (dispatched.kind === "unknown") {
        const controllerRoute = routePromptToController(line);
        if (controllerRoute !== null) {
          try {
            const result = await dispatchThroughController(
              controllerRoute.goal,
              deps,
              controllerRoute.overrideMode,
            );
            applyDispatchResult(result, deps, store);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.transcript.push({ kind: "assistant", text: `Error: ${message}`, tone: "error" });
          }
          await persistHostState();
          renderTick(deps);
          continue;
        }
        // Unknown slash command: push a notice rather than silently dropping.
        if (line.startsWith("/")) {
          deps.transcript.push({
            kind: "assistant",
            text: `unknown command: ${line.split(/\s+/)[0] ?? line}. Try /help.`,
            tone: "warning",
          });
          await persistHostState();
          renderTick(deps);
          continue;
        }
      }

      if (dispatched.kind === "fallthrough") {
        await executePromptFromResolution(dispatched.resolution, line, deps, execDeps);
      }

      await persistHostState();
      renderTick(deps);
    }
  } finally {
    nodeProcess?.off?.("SIGINT", handleSigint);
    resetPromptResolvers();
    rl.close();
    unregisterRedraw();
    uninstallSignals();
    unregisterBackendCleanup();
    sessionBackend.dispose?.();
  }
};
