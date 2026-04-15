import { randomUUID } from "node:crypto";

import { createSessionTaskKey } from "../sessionTypes.js";
import type { InteractiveResolution, InteractiveShellState } from "./interactiveRenderLoop.js";
import { tokenizeCommand } from "./parsing.js";

export const createInteractiveSessionIdentity = (): { sessionId: string; taskId: string } => {
  const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return { sessionId, taskId: createSessionTaskKey(sessionId, "task-1") };
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
  args: { sessionId?: string; taskId?: string },
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
