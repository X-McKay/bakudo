import { randomUUID } from "node:crypto";

import type { AttemptSpec } from "../../attemptProtocol.js";
import type { HostCommandSpec } from "../commandRegistry.js";
import { deriveShellContext } from "../interactiveRenderLoop.js";
import { createInteractiveSessionIdentity } from "../interactiveResolvers.js";

/**
 * Build an {@link AttemptSpec} for an explicit shell command. This is the spec
 * shape that workerRuntime will dispatch via `explicit_command` task-kind.
 *
 * Exported for testing; the command handler below is what the registry uses.
 */
export const buildRunCommandSpec = (
  cmd: string,
  opts: { sessionId: string; taskId: string; cwd: string; autoApprove: boolean },
): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: opts.sessionId,
  turnId: `turn-${Date.now()}-${randomUUID().slice(0, 8)}`,
  attemptId: `attempt-${Date.now()}-${randomUUID().slice(0, 8)}`,
  taskId: opts.taskId,
  intentId: `intent-${Date.now()}-${randomUUID().slice(0, 8)}`,
  mode: "build",
  taskKind: "explicit_command",
  prompt: cmd,
  instructions: [],
  cwd: opts.cwd,
  execution: {
    engine: "shell",
    command: ["bash", "-lc", cmd],
  },
  permissions: {
    rules: [],
    allowAllTools: opts.autoApprove,
    noAskUser: opts.autoApprove,
  },
  budget: {
    timeoutSeconds: 120,
    maxOutputBytes: 262144,
    heartbeatIntervalMs: 5000,
  },
  acceptanceChecks: [],
  artifactRequests: [],
});

/**
 * `/run-command <cmd>` — escape hatch for dispatching a raw shell command as
 * an explicit_command task kind. PR10 routes through the same legacy dispatch
 * path as `/run`; PR11 will wire through the full planner pipeline.
 */
export const runCommandSpec: HostCommandSpec = {
  name: "run-command",
  aliases: ["rc"],
  group: "legacy",
  description: "Run an explicit shell command in the sandbox.",
  handler: ({ args, deps }) => {
    const cmd = args.join(" ").trim();
    if (cmd.length === 0) {
      deps.transcript.push({
        kind: "assistant",
        text: "usage: /run-command <command>",
        tone: "error",
      });
      return;
    }

    const shell = deriveShellContext(deps.appState);
    const { sessionId, taskId } = createInteractiveSessionIdentity();
    const argv = ["run", "--mode", "build", "--explicit-command"];
    if (shell.autoApprove) {
      argv.push("--yes");
    }
    argv.push("--session-id", sessionId, cmd);
    return { argv, sessionId, taskId };
  },
};
