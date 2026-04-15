import { randomUUID } from "node:crypto";

import { createSessionTaskKey } from "../sessionTypes.js";
import type { HostAppState } from "./appState.js";
import type { InteractiveResolution, ShellContext } from "./interactiveRenderLoop.js";
import { reduceHost } from "./reducer.js";
import { tokenizeCommand } from "./parsing.js";

export const createInteractiveSessionIdentity = (): { sessionId: string; taskId: string } => {
  const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return { sessionId, taskId: createSessionTaskKey(sessionId, "task-1") };
};

export const buildInteractiveRunResolution = (
  command: "run" | "build" | "plan",
  goal: string,
  shell: ShellContext,
): InteractiveResolution => {
  const trimmedGoal = goal.trim();
  const { sessionId, taskId } = createInteractiveSessionIdentity();
  const argv: string[] = [command];
  if (command === "run") {
    argv.push("--mode", shell.currentMode);
  }
  if (shell.autoApprove) {
    argv.push("--yes");
  }
  argv.push("--session-id", sessionId, trimmedGoal);
  return { argv, sessionId, taskId };
};

export const resolveSessionScopedInteractiveCommand = (
  command: "status" | "tasks" | "review" | "logs" | "sandbox" | "resume",
  args: string[],
  shell: ShellContext,
): InteractiveResolution => {
  if (args[0]) {
    return {
      argv: [command, ...args],
      sessionId: args[0],
      ...(args[1] ? { taskId: args[1] } : {}),
    };
  }
  if (shell.lastSessionId) {
    const trailingTask = shell.lastTaskId ? [shell.lastTaskId] : [];
    return {
      argv: [command, shell.lastSessionId, ...trailingTask],
      sessionId: shell.lastSessionId,
      ...(shell.lastTaskId ? { taskId: shell.lastTaskId } : {}),
    };
  }
  return { argv: [command, ...args] };
};

export const resolveInteractiveInput = (
  line: string,
  shell: ShellContext,
): InteractiveResolution => {
  if (!line.startsWith("/")) {
    return buildInteractiveRunResolution("run", line, shell);
  }

  const [command = "", ...args] = tokenizeCommand(line.slice(1));
  if (command === "build" || command === "plan") {
    return buildInteractiveRunResolution(command, args.join(" "), shell);
  }
  if (command === "run") {
    return buildInteractiveRunResolution("run", args.join(" "), shell);
  }
  if (command === "status") {
    return args[0]
      ? { argv: ["status", args[0]], sessionId: args[0] }
      : shell.lastSessionId
        ? {
            argv: ["status", shell.lastSessionId],
            sessionId: shell.lastSessionId,
            ...(shell.lastTaskId ? { taskId: shell.lastTaskId } : {}),
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
    return resolveSessionScopedInteractiveCommand(command, args, shell);
  }
  if (command === "sessions" || command === "help" || command === "init") {
    return { argv: [command, ...(shell.autoApprove && command === "init" ? ["--yes"] : [])] };
  }

  return { argv: [command, ...args] };
};

export const rememberInteractiveContext = (
  deps: { appState: HostAppState },
  args: { sessionId?: string; taskId?: string },
  resolution: InteractiveResolution,
): void => {
  const nextSessionId = resolution.sessionId ?? args.sessionId;
  const nextTaskId = resolution.taskId ?? args.taskId;
  if (nextSessionId !== undefined) {
    deps.appState = reduceHost(deps.appState, {
      type: "set_active_session",
      sessionId: nextSessionId,
      ...(nextTaskId ? { turnId: nextTaskId } : {}),
    });
  }
};

export const sessionPromptLabel = (sessionId: string | undefined): string => {
  if (!sessionId) {
    return "no-session";
  }
  const parts = sessionId.split("-");
  return parts.at(-1) ?? sessionId;
};

export const renderPrompt = (shell: ShellContext): string => {
  const session = sessionPromptLabel(shell.lastSessionId);
  const mode = shell.currentMode === "build" ? "BUILD" : "PLAN";
  const approval = shell.autoApprove ? "AUTO" : "PROMPT";
  return `bakudo ${mode} ${approval} ${session}> `;
};
