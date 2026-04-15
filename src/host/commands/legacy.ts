import type { HostCommandSpec } from "../commandRegistry.js";
import {
  buildInteractiveRunResolution,
  resolveSessionScopedInteractiveCommand,
} from "../interactive.js";

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
    return buildInteractiveRunResolution(command, goal, deps.shellState);
  };

const sessionScopedHandler =
  (command: "status" | "tasks" | "review" | "logs" | "sandbox"): HostCommandSpec["handler"] =>
  ({ args, deps }) =>
    resolveSessionScopedInteractiveCommand(command, args, deps.shellState);

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
      if (args[0]) {
        return { argv: ["status", args[0]], sessionId: args[0] };
      }
      if (deps.shellState.lastSessionId) {
        return {
          argv: ["status", deps.shellState.lastSessionId],
          sessionId: deps.shellState.lastSessionId,
          ...(deps.shellState.lastTaskId ? { taskId: deps.shellState.lastTaskId } : {}),
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
