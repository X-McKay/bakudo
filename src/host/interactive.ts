import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { createSessionTaskKey } from "../sessionTypes.js";
import { initialHostAppState } from "./appState.js";
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
import { runNewSession, resumeSession } from "./orchestration.js";
import { type HostCliArgs, parseHostArgs, tokenizeCommand } from "./parsing.js";
import {
  printLogs,
  printReview,
  printSandbox,
  printSessions,
  printStatus,
  printTasks,
} from "./printers.js";
import type { TranscriptItem } from "./renderModel.js";
import { printUsage } from "./usage.js";

export type { InteractiveResolution, InteractiveShellState } from "./interactiveRenderLoop.js";

export const createInteractiveSessionIdentity = (): { sessionId: string; taskId: string } => {
  const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    sessionId,
    taskId: createSessionTaskKey(sessionId, "task-1"),
  };
};

export const buildInteractiveRunResolution = (
  command: "run" | "build" | "plan",
  goal: string,
  state: InteractiveShellState,
): InteractiveResolution => {
  const trimmedGoal = goal.trim();
  const { sessionId, taskId } = createInteractiveSessionIdentity();
  const argv: string[] = [command];
  if (command === "run") {
    argv.push("--mode", state.currentMode);
  }
  if (state.autoApprove) {
    argv.push("--yes");
  }
  argv.push("--session-id", sessionId, trimmedGoal);
  return { argv, sessionId, taskId };
};

export const resolveSessionScopedInteractiveCommand = (
  command: "status" | "tasks" | "review" | "logs" | "sandbox" | "resume",
  args: string[],
  state: InteractiveShellState,
): InteractiveResolution => {
  if (args[0]) {
    return {
      argv: [command, ...args],
      sessionId: args[0],
      ...(args[1] ? { taskId: args[1] } : {}),
    };
  }
  if (state.lastSessionId) {
    const trailingTask = state.lastTaskId ? [state.lastTaskId] : [];
    return {
      argv: [command, state.lastSessionId, ...trailingTask],
      sessionId: state.lastSessionId,
      ...(state.lastTaskId ? { taskId: state.lastTaskId } : {}),
    };
  }
  return { argv: [command, ...args] };
};

export const resolveInteractiveInput = (
  line: string,
  state: InteractiveShellState,
): InteractiveResolution => {
  if (!line.startsWith("/")) {
    return buildInteractiveRunResolution("run", line, state);
  }

  const [command = "", ...args] = tokenizeCommand(line.slice(1));
  if (command === "build" || command === "plan") {
    return buildInteractiveRunResolution(command, args.join(" "), state);
  }
  if (command === "run") {
    return buildInteractiveRunResolution("run", args.join(" "), state);
  }
  if (command === "status") {
    return args[0]
      ? { argv: ["status", args[0]], sessionId: args[0] }
      : state.lastSessionId
        ? {
            argv: ["status", state.lastSessionId],
            sessionId: state.lastSessionId,
            ...(state.lastTaskId ? { taskId: state.lastTaskId } : {}),
          }
        : { argv: ["status"] };
  }
  if (
    command === "tasks" ||
    command === "review" ||
    command === "logs" ||
    command === "sandbox" ||
    command === "resume"
  ) {
    return resolveSessionScopedInteractiveCommand(command, args, state);
  }
  if (command === "sessions" || command === "help" || command === "init") {
    return { argv: [command, ...(state.autoApprove && command === "init" ? ["--yes"] : [])] };
  }

  return { argv: [command, ...args] };
};

export const rememberInteractiveContext = (
  state: InteractiveShellState,
  args: HostCliArgs,
  resolution: InteractiveResolution,
): void => {
  if (resolution.sessionId) {
    state.lastSessionId = resolution.sessionId;
  } else if (args.sessionId) {
    state.lastSessionId = args.sessionId;
  }

  if (resolution.taskId) {
    state.lastTaskId = resolution.taskId;
  } else if (args.taskId) {
    state.lastTaskId = args.taskId;
  }
};

export const sessionPromptLabel = (sessionId: string | undefined): string => {
  if (!sessionId) {
    return "no-session";
  }

  const parts = sessionId.split("-");
  return parts.at(-1) ?? sessionId;
};

export const renderPrompt = (state: InteractiveShellState): string => {
  const session = sessionPromptLabel(state.lastSessionId);
  const mode = state.currentMode === "build" ? "BUILD" : "PLAN";
  const approval = state.autoApprove ? "AUTO" : "PROMPT";
  return `bakudo ${mode} ${approval} ${session}> `;
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

export const runInteractiveShell = async (): Promise<number> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    printUsage();
    return 0;
  }

  const rl = createInterface({ input, output });
  const shellState: InteractiveShellState = {
    currentMode: "build",
    autoApprove: false,
  };
  const transcript: TranscriptItem[] = [];
  const deps: TickDeps = {
    shellState,
    transcript,
    appState: initialHostAppState(),
  };
  const execDeps = {
    resolveInput: resolveInteractiveInput,
    parse: parseHostArgs,
    dispatch: dispatchHostCommand,
    remember: rememberInteractiveContext,
  };

  tickRender(deps);
  try {
    while (true) {
      let answer: string;
      try {
        answer = await rl.question(renderPrompt(shellState));
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
      if (handleControlCommand(line, deps)) {
        tickRender(deps);
        continue;
      }

      transcript.push({ kind: "user", text: line });
      await executePrompt(line, deps, execDeps);
      tickRender(deps);
    }
  } finally {
    rl.close();
  }
};
