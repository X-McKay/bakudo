import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { basename } from "node:path";

import { initialHostAppState, type ComposerMode } from "./appState.js";
import { buildDefaultCommandRegistry } from "./commandRegistryDefaults.js";
import { loadConfigCascade } from "./config.js";
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
  deriveShellContext,
  executePrompt,
  tickRender,
  type InteractiveResolution,
  type ShellContext,
  type TickDeps,
} from "./interactiveRenderLoop.js";
import {
  buildInteractiveRunResolution,
  createInteractiveSessionIdentity,
  rememberInteractiveContext,
  renderPrompt,
  resolveInteractiveInput,
  resolveSessionScopedInteractiveCommand,
  sessionPromptLabel,
} from "./interactiveResolvers.js";
import { repoRootFor, resumeSession, storageRootFor } from "./orchestration.js";
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
  if (args.command === "help") {
    printUsage();
    return 0;
  }
  if (args.command === "run" || args.command === "build" || args.command === "plan") {
    return runNonInteractiveOneShot(args);
  }
  if (args.command === "sessions") {
    return printSessions(args);
  }
  if (args.command === "status") {
    return printStatus(args);
  }
  if (args.command === "sandbox") {
    return printSandbox(args);
  }
  if (args.command === "resume") {
    return resumeSession(args);
  }
  if (args.command === "tasks") {
    return printTasks(args);
  }
  if (args.command === "review") {
    return printReview(args);
  }
  if (args.command === "init") {
    return runInit(args);
  }
  return printLogs(args);
};

const buildHostStateFromDeps = (deps: TickDeps): HostStateRecord => ({
  schemaVersion: HOST_STATE_SCHEMA_VERSION,
  lastUsedMode: deps.appState.composer.mode,
  autoApprove: deps.appState.composer.autoApprove,
  ...(deps.appState.activeSessionId ? { lastActiveSessionId: deps.appState.activeSessionId } : {}),
  ...(deps.appState.activeTurnId ? { lastActiveTurnId: deps.appState.activeTurnId } : {}),
});

const applyHostStateToDeps = (deps: TickDeps, record: HostStateRecord): void => {
  deps.appState = reduceHost(deps.appState, { type: "set_mode", mode: record.lastUsedMode });
  if (record.lastActiveSessionId) {
    deps.appState = reduceHost(deps.appState, {
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
// reach the transcript; raw per-event log lines from executeTask must not
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
  const args: HostCliArgs = activeSessionId === undefined ? { ...baseArgs, sessionId } : baseArgs;
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

const applyDispatchResult = (result: SessionDispatchResult, deps: TickDeps): void => {
  deps.appState = reduceHost(deps.appState, {
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
  const transcript: TranscriptItem[] = [];

  // Load config cascade — CLI flag threading deferred to Phase 6.
  const configSnapshot = await loadConfigCascade(repoRoot, {});
  const deps: TickDeps = {
    transcript,
    appState: initialHostAppState(),
    repoLabel,
    config: configSnapshot.merged,
  };

  resetPromptResolvers();
  const prior = await loadHostState(repoRoot);
  if (prior !== null) {
    applyHostStateToDeps(deps, prior);
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

  const handleSigint = (): void => {
    const head = deps.appState.promptQueue[0];
    if (head === undefined) {
      rl.close();
      return;
    }
    cancelPendingPrompt(head.id);
    deps.appState = reduceHost(deps.appState, { type: "cancel_prompt", id: head.id });
    tickRender(deps);
  };
  type SignalHandler = (name: string, handler: () => void) => unknown;
  const nodeProcess = (globalThis as { process?: { on?: SignalHandler; off?: SignalHandler } })
    .process;
  nodeProcess?.on?.("SIGINT", handleSigint);

  tickRender(deps);
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
        tickRender(deps);
        continue;
      }

      transcript.push({ kind: "user", text: line });
      const dispatched = await registry.dispatch(line, deps);
      if (dispatched.kind === "exit") {
        await persistHostState();
        return dispatched.code;
      }
      if (dispatched.kind === "handled") {
        await persistHostState();
        tickRender(deps);
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
            applyDispatchResult(result, deps);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.transcript.push({ kind: "assistant", text: `Error: ${message}`, tone: "error" });
          }
          await persistHostState();
          tickRender(deps);
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
          tickRender(deps);
          continue;
        }
      }

      if (dispatched.kind === "fallthrough") {
        await executePromptFromResolution(dispatched.resolution, line, deps, execDeps);
      }

      await persistHostState();
      tickRender(deps);
    }
  } finally {
    nodeProcess?.off?.("SIGINT", handleSigint);
    resetPromptResolvers();
    rl.close();
  }
};
