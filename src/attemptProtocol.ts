import { z } from "zod";

export { reservedGuestOutputDirForAttempt, sanitizeAttemptPathSegment } from "./attemptPath.js";
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

export type AttemptTaskKind =
  | "assistant_job"
  | "explicit_command"
  | "verification_check"
  | "apply_verify"
  | "apply_resolve";

export type PermissionEffect = "allow" | "ask" | "deny";
export type KnownPermissionTool = "shell" | "write" | "network" | "edit" | "task";
export type PermissionTool = KnownPermissionTool | (string & {});
export type PermissionSource = "agent_profile" | "user_interactive" | "repo_config" | "user_config";
export type PermissionRuleScope = "once" | "session" | "always";

export type PermissionRule = {
  ruleId: string;
  effect: PermissionEffect;
  tool: PermissionTool;
  pattern: string;
  scope: PermissionRuleScope;
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

export type ExecutionProfile = {
  /**
   * Wave 1: Registered provider ID (e.g. `"claude-code"`, `"codex"`).
   * Takes precedence over the deprecated `agentBackend` string.
   */
  providerId?: string;
  /**
   * @deprecated Use `providerId` instead. Kept for backwards-compatibility
   * with serialised profiles that pre-date Wave 1. When both are present,
   * `providerId` wins.
   */
  agentBackend?: string;
  sandboxLifecycle: "preserved" | "ephemeral";
  candidatePolicy: "auto_apply" | "manual_apply" | "discard";
};

export type DispatchPlan = {
  schemaVersion: 1;
  candidateId?: string;
  batchId?: string;
  profile: ExecutionProfile;
  spec: AttemptSpec;
};

export type BatchSpec = {
  batchId: string;
  intentId: string;
  candidates: DispatchPlan[];
};

/**
 * Wave 3: CandidateSet extends BatchSpec with Objective/Campaign tracking
 * fields so it survives serialisation through the Daemon Gateway.
 */
export type CandidateSet = BatchSpec & {
  /** Wave 3: ID of the parent Objective this set belongs to. */
  objectiveId?: string;
  /** Wave 3: ID of the Campaign within the Objective. */
  campaignId?: string;
};

export type CandidateSetResult = {
  batchId: string;
  results: Record<string, AttemptExecutionResult>;
  selectedCandidateId?: string;
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
const PermissionRuleScopeSchema = z.enum(["once", "session", "always"]);

/**
 * Raw on-disk / over-the-wire shape — `ruleId` and `scope` are tolerant on
 * read so legacy rules written before the Phase 4 tightening still load.
 * Use {@link hydratePermissionRule} to fill the defaults and return a strict
 * {@link PermissionRule}.
 */
export const PermissionRuleSchema = z
  .object({
    ruleId: z.string().optional(),
    effect: PermissionEffectSchema,
    tool: z.string(),
    pattern: z.string(),
    scope: PermissionRuleScopeSchema.optional(),
    source: PermissionSourceSchema,
  })
  .strip();

export type RawPermissionRule = z.infer<typeof PermissionRuleSchema>;

/**
 * Deterministic ID for a legacy rule loaded without one. Same tool/pattern/
 * effect/source always hashes to the same `rule-<hex>` so inspect/approval
 * tables stay stable across loads.
 */
export const synthesizePermissionRuleId = (raw: {
  effect: PermissionEffect;
  tool: string;
  pattern: string;
  source: PermissionSource;
}): string => {
  const payload = `${raw.effect}|${raw.tool}|${raw.pattern}|${raw.source}`;
  // Small deterministic hash (FNV-1a 32-bit). 8 hex chars is enough for
  // practical uniqueness across a handful of rules per session and avoids
  // pulling crypto into a pure-data helper.
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `rule-${hash.toString(16).padStart(8, "0")}`;
};

/**
 * Promote a tolerantly-parsed {@link RawPermissionRule} to the strict
 * {@link PermissionRule}. Missing `ruleId` gets a deterministic synthesis;
 * missing `scope` defaults to `"session"` (rules loaded from agent profiles
 * are session-scoped unless the user has explicitly marked them `always`).
 */
export const hydratePermissionRule = (raw: RawPermissionRule): PermissionRule => ({
  ruleId: raw.ruleId ?? synthesizePermissionRuleId(raw),
  effect: raw.effect,
  tool: raw.tool,
  pattern: raw.pattern,
  scope: raw.scope ?? "session",
  source: raw.source,
});

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

const AttemptTaskKindSchema = z.enum([
  "assistant_job",
  "explicit_command",
  "verification_check",
  "apply_verify",
  "apply_resolve",
]);

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

export const ExecutionProfileSchema = z
  .object({
    /** Wave 1: registered provider ID. Takes precedence over agentBackend. */
    providerId: z.string().optional(),
    /** @deprecated Use providerId. Kept for backwards-compat with pre-Wave-1 profiles. */
    agentBackend: z.string().optional(),
    sandboxLifecycle: z.enum(["preserved", "ephemeral"]),
    candidatePolicy: z.enum(["auto_apply", "manual_apply", "discard"]),
  })
  .strip();

export const DispatchPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateId: z.string().optional(),
    batchId: z.string().optional(),
    profile: ExecutionProfileSchema,
    spec: AttemptSpecSchema,
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

export const BatchSpecSchema = z
  .object({
    batchId: z.string(),
    intentId: z.string(),
    candidates: z.array(DispatchPlanSchema),
  })
  .strip();

/**
 * Wave 3: CandidateSet schema extends BatchSpec with optional Objective/Campaign
 * tracking fields for the Daemon Gateway state model.
 */
export const CandidateSetSchema = BatchSpecSchema.extend({
  objectiveId: z.string().optional(),
  campaignId: z.string().optional(),
});

export const CandidateSetResultSchema = z
  .object({
    batchId: z.string(),
    results: z.record(z.string(), AttemptExecutionResultSchema),
    selectedCandidateId: z.string().optional(),
  })
  .strip();
