import type { HostCommandSpec } from "../commandRegistry.js";
import { deriveShellContext } from "../interactiveRenderLoop.js";
import {
  buildInteractiveRunResolution,
  resolveSessionScopedInteractiveCommand,
} from "../interactiveResolvers.js";

const runLikeHandler =
  (command: "run" | "build" | "plan"): HostCommandSpec["handler"] =>
  ({ args, deps }) => {
    const goal = args.join(" ").trim();
    if (goal.length === 0) {
      deps.transcript.push({
        kind: "assistant",
        text: `missing goal for /${command}`,
        tone: "error",
      });
      return;
    }
    return buildInteractiveRunResolution(command, goal, deriveShellContext(deps.appState));
  };

const sessionScopedHandler =
  (command: "status" | "tasks" | "review" | "logs" | "sandbox"): HostCommandSpec["handler"] =>
  ({ args, deps }) =>
    resolveSessionScopedInteractiveCommand(command, args, deriveShellContext(deps.appState));

export const legacyCommands: readonly HostCommandSpec[] = [
  {
    name: "run",
    group: "legacy",
    description: "Dispatch a sandbox task with the current mode.",
    handler: runLikeHandler("run"),
  },
  {
    name: "build",
    group: "legacy",
    description: "Dispatch a build-mode sandbox task.",
    handler: runLikeHandler("build"),
  },
  {
    name: "plan",
    group: "legacy",
    description: "Dispatch a plan-mode sandbox task.",
    handler: runLikeHandler("plan"),
  },
  {
    name: "status",
    group: "legacy",
    description: "Show session status.",
    handler: ({ args, deps }) => {
      const shell = deriveShellContext(deps.appState);
      if (args[0]) {
        return { argv: ["status", args[0]], sessionId: args[0] };
      }
      if (shell.lastSessionId) {
        return {
          argv: ["status", shell.lastSessionId],
          sessionId: shell.lastSessionId,
          ...(shell.lastTaskId ? { taskId: shell.lastTaskId } : {}),
        };
      }
      return { argv: ["status"] };
    },
  },
  {
    name: "tasks",
    group: "legacy",
    description: "List attempts for a session.",
    handler: sessionScopedHandler("tasks"),
  },
  {
    name: "review",
    group: "legacy",
    description: "Show the reviewed outcome for a session attempt.",
    handler: sessionScopedHandler("review"),
  },
  {
    name: "sandbox",
    group: "legacy",
    description: "Show abox dispatch metadata.",
    handler: sessionScopedHandler("sandbox"),
  },
  {
    name: "logs",
    group: "legacy",
    description: "Print the worker event stream.",
    handler: sessionScopedHandler("logs"),
  },
];
