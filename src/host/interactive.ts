import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { createSessionTaskKey } from "../sessionTypes.js";
import {
  ANSI,
  blue,
  bold,
  overviewPanelLines,
  paint,
  renderApprovalChip,
  renderKeyValue,
  renderModeChip,
} from "./ansi.js";
import { InteractiveDashboard, type InteractiveShellState } from "./dashboard.js";
import { runtimeIo, stderrWrite, withCapturedStdout } from "./io.js";
import { runInit } from "./init.js";
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
import { buildUsageLines, printUsage } from "./usage.js";
import type { TextWriter } from "./io.js";

export { InteractiveDashboard } from "./dashboard.js";
export type { InteractiveShellState } from "./dashboard.js";

export type InteractiveResolution = {
  argv: string[];
  sessionId?: string;
  taskId?: string;
};

export const createDashboardCapture = (
  dashboard: InteractiveDashboard,
  options: { live?: boolean; recordActivity?: boolean } = {},
): { writer: TextWriter; lines: string[]; flush: () => void } => {
  const live = options.live ?? false;
  const recordActivity = options.recordActivity ?? true;
  const lines: string[] = [];
  let pending = "";
  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    const clean = pending.replace(/\r/g, "").trimEnd();
    pending = "";
    if (clean.length === 0) {
      return;
    }
    lines.push(clean);
    if (recordActivity) {
      dashboard.appendActivity(clean);
    }
  };
  return {
    flush,
    lines,
    writer: {
      write: (chunk: string | Uint8Array) => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        pending += text;
        const split = pending.split(/\r?\n/);
        pending = split.pop() ?? "";
        for (const line of split) {
          const clean = line.replace(/\r/g, "").trimEnd();
          if (clean.length === 0) {
            continue;
          }
          lines.push(clean);
          if (recordActivity) {
            dashboard.appendActivity(clean);
          }
        }
        if (live) {
          dashboard.render();
        }
        return true;
      },
    },
  };
};

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
  const session = paint(sessionPromptLabel(state.lastSessionId), ANSI.bold, ANSI.gray);
  return `${bold(blue("bakudo"))} ${renderModeChip(state.currentMode)} ${renderApprovalChip(state.autoApprove)} ${session}> `;
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
  const state: InteractiveShellState = {
    currentMode: "build",
    autoApprove: false,
  };
  const dashboard = new InteractiveDashboard(() => state);
  dashboard.render();
  try {
    while (true) {
      let answer: string;
      try {
        answer = await rl.question(renderPrompt(state));
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
      if (line === "/help") {
        dashboard.setPanel("Help", buildUsageLines().slice(0, 18));
        dashboard.render();
        continue;
      }
      if (line === "/clear") {
        dashboard.setPanel("Overview", overviewPanelLines());
        dashboard.render();
        continue;
      }
      if (line.startsWith("/mode ")) {
        const nextMode = line.slice("/mode ".length).trim();
        if (nextMode !== "build" && nextMode !== "plan") {
          stderrWrite("interactive_error: mode must be build or plan\n");
          continue;
        }
        state.currentMode = nextMode;
        dashboard.setPanel("Mode", [
          renderKeyValue("Mode", `${renderModeChip(state.currentMode)} selected`),
        ]);
        dashboard.note(`Mode changed to ${state.currentMode}.`);
        dashboard.render();
        continue;
      }
      if (line.startsWith("/approve ")) {
        const policy = line.slice("/approve ".length).trim();
        if (policy !== "auto" && policy !== "prompt") {
          stderrWrite("interactive_error: approve must be auto or prompt\n");
          continue;
        }
        state.autoApprove = policy === "auto";
        dashboard.setPanel("Approval", [
          renderKeyValue("Policy", `${renderApprovalChip(state.autoApprove)} selected`),
        ]);
        dashboard.note(`Approval policy changed to ${policy}.`);
        dashboard.render();
        continue;
      }

      try {
        const resolution = resolveInteractiveInput(line, state);
        const parsed = parseHostArgs(resolution.argv);
        const activitySnapshot = dashboard.snapshotActivity();
        dashboard.note(`Command: ${line}`);
        const liveCapture =
          parsed.command === "run" ||
          parsed.command === "build" ||
          parsed.command === "plan" ||
          parsed.command === "resume";
        const recordActivity = liveCapture;
        const capture = createDashboardCapture(dashboard, { live: liveCapture, recordActivity });
        const code = await withCapturedStdout(capture.writer, async () =>
          dispatchHostCommand(parsed),
        );
        capture.flush();
        const panelTitle =
          parsed.command === "run" || parsed.command === "build" || parsed.command === "plan"
            ? "Command Result"
            : parsed.command.charAt(0).toUpperCase() + parsed.command.slice(1);
        dashboard.setPanel(panelTitle, capture.lines.slice(-18));
        if (!recordActivity) {
          dashboard.restoreActivity([...activitySnapshot, `Command: ${line}`]);
        }
        if (code !== 1) {
          rememberInteractiveContext(state, parsed, resolution);
        }
        dashboard.render();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderrWrite(`interactive_error: ${message}\n`);
        dashboard.note(`Error: ${message}`);
        dashboard.render();
      }
    }
  } finally {
    rl.close();
  }
};
