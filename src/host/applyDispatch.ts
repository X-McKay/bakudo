import type {
  AcceptanceCheck,
  AttemptSpec,
  AttemptTaskKind,
  DispatchPlan,
  PermissionRule,
} from "../attemptProtocol.js";

export type ApplyDispatchKind = Extract<AttemptTaskKind, "apply_verify" | "apply_resolve">;

export type BuildApplyDispatchInput = {
  kind: ApplyDispatchKind;
  sessionId: string;
  turnId: string;
  attemptId: string;
  taskId: string;
  intentId: string;
  workspaceRoot: string;
  prompt: string;
  instructions: string[];
  command?: string[];
  acceptanceChecks?: AcceptanceCheck[];
  permissionRules?: PermissionRule[];
  agentBackend?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
};

const engineFor = (kind: ApplyDispatchKind): "agent_cli" | "shell" =>
  kind === "apply_resolve" ? "agent_cli" : "shell";

export const buildApplyDispatchPlan = (input: BuildApplyDispatchInput): DispatchPlan => {
  const spec: AttemptSpec = {
    schemaVersion: 3,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    taskId: input.taskId,
    intentId: input.intentId,
    mode: "build",
    taskKind: input.kind,
    prompt: input.prompt,
    instructions: input.instructions,
    cwd: input.workspaceRoot,
    execution: {
      engine: engineFor(input.kind),
      ...(input.command === undefined ? {} : { command: input.command }),
    },
    permissions: {
      rules: input.permissionRules ?? [],
      allowAllTools: false,
      noAskUser: true,
    },
    budget: {
      timeoutSeconds: input.timeoutSeconds ?? 300,
      maxOutputBytes: input.maxOutputBytes ?? 10_000_000,
      heartbeatIntervalMs: input.heartbeatIntervalMs ?? 5000,
    },
    acceptanceChecks: input.acceptanceChecks ?? [],
    artifactRequests: [{ name: "result.json", kind: "result", required: true }],
  };
  return {
    schemaVersion: 1,
    candidateId: input.attemptId,
    profile: {
      agentBackend: input.agentBackend ?? "codex exec --dangerously-bypass-approvals-and-sandbox",
      sandboxLifecycle: "ephemeral",
      candidatePolicy: "discard",
    },
    spec,
  };
};
