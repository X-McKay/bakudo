import type {
  AcceptanceCheck,
  ArtifactRequest,
  AttemptSpec,
  AttemptTaskKind,
  PermissionRule,
  TurnIntent,
  TurnIntentKind,
} from "../attemptProtocol.js";
import { reservedGuestOutputDirForAttempt } from "../attemptProtocol.js";
import {
  BAKUDO_HOST_EXECUTION_ENGINES,
  BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION,
  BAKUDO_HOST_TASK_KINDS,
} from "../protocol.js";
import type { ComposerMode } from "./appState.js";
import type { BakudoConfig } from "./config.js";
import { compileProfilePermissions } from "./permissionEvaluator.js";

// ---------------------------------------------------------------------------
// Host capability surface (Phase 6 W3)
// ---------------------------------------------------------------------------

/**
 * Snapshot of what the compiler can produce — the AttemptSpec schema version
 * it emits, the task kinds it understands, and the execution engines it
 * routes them to. `ABoxTaskRunner.runAttempt` compares this surface against
 * the worker's `--capabilities` reply and throws `WorkerProtocolMismatchError`
 * on a miss. Exported so `bakudo doctor` and the negotiation tests can read
 * the host side without re-deriving it from the maps below.
 */
export const HOST_ATTEMPT_CAPABILITIES = {
  protocolVersion: BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION,
  taskKinds: BAKUDO_HOST_TASK_KINDS,
  executionEngines: BAKUDO_HOST_EXECUTION_ENGINES,
} as const;

// ---------------------------------------------------------------------------
// Public context type
// ---------------------------------------------------------------------------

export type CompilerContext = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  taskId: string;
  repoRoot: string;
  config: BakudoConfig;
};

// ---------------------------------------------------------------------------
// Mode translation
// ---------------------------------------------------------------------------

/**
 * Translate the user-facing {@link ComposerMode} to the worker-facing
 * `TaskMode`. Standard and autopilot both produce `"build"`; plan produces
 * `"plan"`.
 */
export const composerModeToTaskMode = (mode: ComposerMode): "build" | "plan" =>
  mode === "plan" ? "plan" : "build";

// ---------------------------------------------------------------------------
// Task kind mapping
// ---------------------------------------------------------------------------

const TASK_KIND_MAP: Record<TurnIntentKind, AttemptTaskKind> = {
  inspect_repository: "assistant_job",
  implement_change: "assistant_job",
  run_check: "verification_check",
  run_explicit_command: "explicit_command",
};

const ENGINE_MAP: Record<AttemptTaskKind, "agent_cli" | "shell"> = {
  assistant_job: "agent_cli",
  explicit_command: "shell",
  verification_check: "shell",
};

// ---------------------------------------------------------------------------
// Permission defaults
// ---------------------------------------------------------------------------

type PermProfile = Record<string, "allow" | "ask" | "deny">;

const PERMISSION_DEFAULTS: Record<ComposerMode, PermProfile> = {
  standard: { shell: "ask", write: "ask", network: "ask" },
  plan: { shell: "deny", write: "deny", network: "ask" },
  autopilot: { shell: "allow", write: "allow", network: "allow" },
};

const PROFILE_NAME: Record<ComposerMode, string> = {
  standard: "default",
  plan: "plan",
  autopilot: "autopilot",
};

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const PROMPT_MAP: Record<AttemptTaskKind, string> = {
  assistant_job:
    "Implement the requested change, make a minimal patch, and run targeted verification.",
  verification_check: "Execute the requested check command and capture outputs.",
  explicit_command: "", // overridden with raw command
};

// ---------------------------------------------------------------------------
// Artifact request defaults
// ---------------------------------------------------------------------------

const ARTIFACT_REQUESTS: Record<AttemptTaskKind, ArtifactRequest[]> = {
  assistant_job: [
    { name: "result.json", kind: "result", required: true },
    { name: "summary.md", kind: "summary", required: false },
    { name: "patch.diff", kind: "patch", required: false },
  ],
  explicit_command: [{ name: "result.json", kind: "result", required: true }],
  verification_check: [{ name: "result.json", kind: "result", required: true }],
};

// ---------------------------------------------------------------------------
// Command extraction
// ---------------------------------------------------------------------------

/**
 * Extract a shell command from the user prompt for explicit commands.
 * Strips a leading `/run-command ` prefix if present.
 */
const extractCommand = (prompt: string): string[] => {
  const stripped = prompt.replace(/^\/run-command\s+/u, "");
  return ["bash", "-lc", stripped];
};

/**
 * Derive a shell command for check-like prompts. Simple heuristic: strip
 * the leading verb ("run", "execute", "check") and wrap the rest.
 */
const deriveCheckCommand = (prompt: string): string[] => {
  const stripped = prompt.replace(/^\/check\s*/u, "").replace(/^(run|execute|check)\s+/iu, "");
  return ["bash", "-lc", stripped];
};

// ---------------------------------------------------------------------------
// Permission compilation
// ---------------------------------------------------------------------------

const compilePermissions = (composerMode: ComposerMode, config: BakudoConfig): PermissionRule[] => {
  const profileName = PROFILE_NAME[composerMode];
  const agentProfile = config.agents?.[profileName];

  if (agentProfile?.permissions) {
    return compileProfilePermissions(agentProfile.permissions, "agent_profile");
  }
  return compileProfilePermissions(PERMISSION_DEFAULTS[composerMode], "agent_profile");
};

// ---------------------------------------------------------------------------
// Acceptance checks
// ---------------------------------------------------------------------------

const buildAcceptanceChecks = (intent: TurnIntent): AcceptanceCheck[] => {
  if (intent.kind === "run_check") {
    const command = deriveCheckCommand(intent.prompt);
    return [
      {
        checkId: "check-0",
        label: intent.acceptanceGoals[0] ?? "run requested verification check",
        command,
      },
    ];
  }

  return intent.acceptanceGoals.map((label, i) => ({
    checkId: `check-${i}`,
    label,
  }));
};

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const buildInstructions = (intent: TurnIntent, attemptId: string): string[] => {
  const parts: string[] = [];
  parts.push(`User prompt: ${intent.prompt}`);
  if (TASK_KIND_MAP[intent.kind] === "assistant_job") {
    parts.push(`Reserved output directory: ${reservedGuestOutputDirForAttempt(attemptId)}`);
  }
  for (const c of intent.constraints) {
    parts.push(`Constraint: ${c}`);
  }
  for (const ar of ARTIFACT_REQUESTS[TASK_KIND_MAP[intent.kind]]) {
    parts.push(
      `Artifact: produce ${ar.name} (${ar.kind}, ${ar.required ? "required" : "optional"})`,
    );
  }
  return parts;
};

// ---------------------------------------------------------------------------
// Main compiler
// ---------------------------------------------------------------------------

/**
 * Transform a {@link TurnIntent} into a fully-populated {@link AttemptSpec}.
 * No I/O — pure data transformation.
 */
export const compileAttemptSpec = (intent: TurnIntent, context: CompilerContext): AttemptSpec => {
  const taskKind = TASK_KIND_MAP[intent.kind];
  const engine = ENGINE_MAP[taskKind];
  const mode = composerModeToTaskMode(intent.composerMode);

  // Command
  let command: string[] | undefined;
  if (taskKind === "explicit_command") {
    command = extractCommand(intent.prompt);
  }

  // Prompt
  const prompt = taskKind === "explicit_command" ? intent.prompt : PROMPT_MAP[taskKind];

  return {
    schemaVersion: 3,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attemptId: context.attemptId,
    taskId: context.taskId,
    intentId: intent.intentId,
    mode,
    taskKind,
    prompt,
    instructions: buildInstructions(intent, context.attemptId),
    cwd: context.repoRoot,
    execution: {
      engine,
      ...(command !== undefined ? { command } : {}),
    },
    permissions: {
      rules: compilePermissions(intent.composerMode, context.config),
      allowAllTools: intent.composerMode === "autopilot",
      noAskUser: intent.composerMode === "autopilot",
    },
    budget: {
      timeoutSeconds: 300,
      maxOutputBytes: 10_000_000,
      heartbeatIntervalMs: 5000,
      ...(intent.tokenBudget !== undefined ? { tokenBudget: intent.tokenBudget } : {}),
    },
    acceptanceChecks: buildAcceptanceChecks(intent),
    artifactRequests: ARTIFACT_REQUESTS[taskKind],
  };
};
