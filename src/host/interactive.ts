import { createInterface } from "node:readline/promises";

import { initialHostAppState } from "./appState.js";
import { buildDefaultCommandRegistry } from "./commandRegistryDefaults.js";
import {
  HOST_STATE_SCHEMA_VERSION,
  loadHostState,
  saveHostState,
  type HostStateRecord,
} from "./hostStateStore.js";
import { runtimeIo } from "./io.js";
import { runInit } from "./init.js";
import {
  executePrompt,
  handleControlCommand,
  tickRender,
  type InteractiveResolution,
  type InteractiveShellState,
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
import { repoRootFor, runNewSession, resumeSession } from "./orchestration.js";
import { type HostCliArgs, parseHostArgs, tokenizeCommand } from "./parsing.js";
import {
  printLogs,
  printReview,
  printSandbox,
  printSessions,
  printStatus,
  printTasks,
} from "./printers.js";
import { reduceHost } from "./reducer.js";
import type { TranscriptItem } from "./renderModel.js";
import {
  appendTurnToActiveSession,
  createAndRunFirstTurn,
  type SessionDispatchResult,
} from "./sessionController.js";
import { printUsage } from "./usage.js";

export type { InteractiveResolution, InteractiveShellState } from "./interactiveRenderLoop.js";
export {
  buildInteractiveRunResolution,
  createInteractiveSessionIdentity,
  rememberInteractiveContext,
  renderPrompt,
  resolveInteractiveInput,
  resolveSessionScopedInteractiveCommand,
  sessionPromptLabel,
};

export const dispatchHostCommand = async (args: HostCliArgs): Promise<number> => {
  if (args.command === "help") {
    printUsage();
    return 0;
  }
  if (args.command === "run" || args.command === "build" || args.command === "plan") {
    return runNewSession(args);
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
  deps.shellState.currentMode = record.lastUsedMode === "plan" ? "plan" : "build";
  deps.shellState.autoApprove = record.autoApprove;
  if (record.lastActiveSessionId) {
    deps.shellState.lastSessionId = record.lastActiveSessionId;
  }
  if (record.lastActiveTurnId) {
    deps.shellState.lastTaskId = record.lastActiveTurnId;
  }
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

const dispatchThroughController = async (
  goal: string,
  deps: TickDeps,
  overrideMode?: "build" | "plan",
): Promise<SessionDispatchResult> => {
  const mode = overrideMode ?? deps.shellState.currentMode;
  const args = baseInteractiveArgs(mode, deps.shellState.autoApprove);
  if (deps.appState.activeSessionId !== undefined) {
    return appendTurnToActiveSession(deps.appState.activeSessionId, goal, args);
  }
  return createAndRunFirstTurn(goal, args);
};

const applyDispatchResult = (result: SessionDispatchResult, deps: TickDeps): void => {
  deps.appState = reduceHost(deps.appState, {
    type: "set_active_session",
    sessionId: result.sessionId,
    turnId: result.turnId,
  });
  deps.shellState.lastSessionId = result.sessionId;
  deps.shellState.lastTaskId = result.turnId;
  const outcome = result.reviewed.outcome;
  deps.transcript.push({
    kind: "assistant",
    text: outcome === "success" ? "Worker completed." : "Worker completed with errors.",
    tone: outcome === "success" ? "info" : "error",
  });
  deps.transcript.push({
    kind: "review",
    outcome,
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

export const runInteractiveShell = async (): Promise<number> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    printUsage();
    return 0;
  }

  const repoRoot = repoRootFor(undefined);
  const rl = createInterface({ input, output });
  const shellState: InteractiveShellState = { currentMode: "build", autoApprove: false };
  const transcript: TranscriptItem[] = [];
  const deps: TickDeps = { shellState, transcript, appState: initialHostAppState() };

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

  const registry = buildDefaultCommandRegistry();

  const persistHostState = async (): Promise<void> => {
    await saveHostState(repoRoot, buildHostStateFromDeps(deps));
  };

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
      if (line === "/quit" || line === "/exit") {
        return 0;
      }

      transcript.push({ kind: "user", text: line });
      const dispatched = await registry.dispatch(line, deps);
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
        if (handleControlCommand(line, deps)) {
          await persistHostState();
          tickRender(deps);
          continue;
        }
      }

      if (dispatched.kind === "fallthrough") {
        await executePromptFromResolution(dispatched.resolution, line, deps, execDeps);
      } else {
        await executePrompt(line, deps, execDeps);
      }

      await persistHostState();
      tickRender(deps);
    }
  } finally {
    rl.close();
  }
};
