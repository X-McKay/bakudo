import { z } from "zod";

import type { ComposerMode } from "./host/appState.js";
import type { ArtifactKind } from "./host/artifactStore.js";

// ---------------------------------------------------------------------------
// TurnIntent
// ---------------------------------------------------------------------------

export type TurnIntentKind =
  | "inspect_repository"
  | "implement_change"
  | "run_check"
  | "run_explicit_command";

export type TurnIntent = {
  intentId: string;
  kind: TurnIntentKind;
  composerMode: ComposerMode;
  prompt: string;
  repoRoot: string;
  acceptanceGoals: string[];
  constraints: string[];
  tokenBudget?: number;
};

// ---------------------------------------------------------------------------
// AttemptSpec helpers
// ---------------------------------------------------------------------------

export type AttemptTaskKind = "assistant_job" | "explicit_command" | "verification_check";

export type PermissionEffect = "allow" | "ask" | "deny";
export type KnownPermissionTool = "shell" | "write" | "network" | "edit" | "task";
export type PermissionTool = KnownPermissionTool | (string & {});
export type PermissionSource = "agent_profile" | "user_interactive" | "repo_config" | "user_config";

export type PermissionRule = {
  effect: PermissionEffect;
  tool: PermissionTool;
  pattern: string;
  scope?: string;
  source: PermissionSource;
};

export type AcceptanceCheck = {
  checkId: string;
  label: string;
  command?: string[];
  assertExitZero?: boolean;
};

export type ArtifactRequest = {
  name: string;
  kind: ArtifactKind;
  required: boolean;
};

export type AttemptSpec = {
  schemaVersion: 3;
  sessionId: string;
  turnId: string;
  attemptId: string;
  taskId: string;
  intentId: string;
  mode: "build" | "plan";
  taskKind: AttemptTaskKind;
  prompt: string;
  instructions: string[];
  cwd: string;
  execution: {
    engine: "agent_cli" | "shell";
    command?: string[];
  };
  permissions: {
    rules: PermissionRule[];
    allowAllTools: boolean;
    noAskUser: boolean;
  };
  budget: {
    timeoutSeconds: number;
    maxOutputBytes: number;
    heartbeatIntervalMs: number;
    tokenBudget?: number;
  };
  acceptanceChecks: AcceptanceCheck[];
  artifactRequests: ArtifactRequest[];
};

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export type CheckResult = {
  checkId: string;
  passed: boolean;
  exitCode: number;
  output: string;
};

export type AttemptExecutionResult = {
  schemaVersion: 3;
  attemptId: string;
  taskKind: AttemptTaskKind;
  status: "succeeded" | "failed" | "blocked" | "cancelled";
  summary: string;
  exitCode?: number | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  artifacts: string[];
  checkResults?: CheckResult[];
};

// ---------------------------------------------------------------------------
// Zod schemas — `.strip()` for tolerant reading
// ---------------------------------------------------------------------------

const TurnIntentKindSchema = z.enum([
  "inspect_repository",
  "implement_change",
  "run_check",
  "run_explicit_command",
]);

export const TurnIntentSchema = z
  .object({
    intentId: z.string(),
    kind: TurnIntentKindSchema,
    composerMode: z.enum(["standard", "plan", "autopilot"]),
    prompt: z.string(),
    repoRoot: z.string(),
    acceptanceGoals: z.array(z.string()),
    constraints: z.array(z.string()),
    tokenBudget: z.number().optional(),
  })
  .strip();

const PermissionEffectSchema = z.enum(["allow", "ask", "deny"]);
const PermissionSourceSchema = z.enum([
  "agent_profile",
  "user_interactive",
  "repo_config",
  "user_config",
]);

export const PermissionRuleSchema = z
  .object({
    effect: PermissionEffectSchema,
    tool: z.string(),
    pattern: z.string(),
    scope: z.string().optional(),
    source: PermissionSourceSchema,
  })
  .strip();

const AcceptanceCheckSchema = z
  .object({
    checkId: z.string(),
    label: z.string(),
    command: z.array(z.string()).optional(),
    assertExitZero: z.boolean().optional(),
  })
  .strip();

const ArtifactKindSchema = z.enum([
  "result",
  "log",
  "dispatch",
  "patch",
  "summary",
  "diff",
  "report",
]);

const ArtifactRequestSchema = z
  .object({
    name: z.string(),
    kind: ArtifactKindSchema,
    required: z.boolean(),
  })
  .strip();

const AttemptTaskKindSchema = z.enum(["assistant_job", "explicit_command", "verification_check"]);

export const AttemptSpecSchema = z
  .object({
    schemaVersion: z.literal(3),
    sessionId: z.string(),
    turnId: z.string(),
    attemptId: z.string(),
    taskId: z.string(),
    intentId: z.string(),
    mode: z.enum(["build", "plan"]),
    taskKind: AttemptTaskKindSchema,
    prompt: z.string(),
    instructions: z.array(z.string()),
    cwd: z.string(),
    execution: z
      .object({
        engine: z.enum(["agent_cli", "shell"]),
        command: z.array(z.string()).optional(),
      })
      .strip(),
    permissions: z
      .object({
        rules: z.array(PermissionRuleSchema),
        allowAllTools: z.boolean(),
        noAskUser: z.boolean(),
      })
      .strip(),
    budget: z
      .object({
        timeoutSeconds: z.number(),
        maxOutputBytes: z.number(),
        heartbeatIntervalMs: z.number(),
        tokenBudget: z.number().optional(),
      })
      .strip(),
    acceptanceChecks: z.array(AcceptanceCheckSchema),
    artifactRequests: z.array(ArtifactRequestSchema),
  })
  .strip();

const CheckResultSchema = z
  .object({
    checkId: z.string(),
    passed: z.boolean(),
    exitCode: z.number(),
    output: z.string(),
  })
  .strip();

export const AttemptExecutionResultSchema = z
  .object({
    schemaVersion: z.literal(3),
    attemptId: z.string(),
    taskKind: AttemptTaskKindSchema,
    status: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    summary: z.string(),
    exitCode: z.number().nullable().optional(),
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number(),
    artifacts: z.array(z.string()),
    checkResults: z.array(CheckResultSchema).optional(),
  })
  .strip();
