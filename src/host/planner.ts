import type { AttemptSpec, DispatchPlan, ExecutionProfile, TurnIntent } from "../attemptProtocol.js";
import type { ComposerMode } from "./appState.js";
import { compileAttemptSpec, type CompilerContext } from "./attemptCompiler.js";
import { buildTurnIntent } from "./intentClassifier.js";

// ---------------------------------------------------------------------------
// Unified planner entry point
// ---------------------------------------------------------------------------

/**
 * Single authoritative path from user prompt to {@link AttemptSpec}. Classifies
 * intent, then compiles the spec. No I/O — pure data transformation.
 */
export const planAttempt = (
  prompt: string,
  composerMode: ComposerMode,
  context: CompilerContext,
  options?: { isExplicitCommand?: boolean; tokenBudget?: number },
): { intent: TurnIntent; plan: DispatchPlan; spec: AttemptSpec } => {
  const intent = buildTurnIntent(prompt, composerMode, context.repoRoot, options);
  const spec = compileAttemptSpec(intent, context);
  const usesEphemeralSandbox =
    intent.kind === "inspect_repository" ||
    intent.kind === "run_check" ||
    intent.kind === "run_explicit_command";
  const isAuto = composerMode === "autopilot" || composerMode === "plan";
  const profile: ExecutionProfile = {
    agentBackend: "codex exec --dangerously-bypass-approvals-and-sandbox",
    sandboxLifecycle: usesEphemeralSandbox ? "ephemeral" : "preserved",
    mergeStrategy: usesEphemeralSandbox ? "none" : isAuto ? "auto" : "interactive",
  };
  const plan: DispatchPlan = {
    schemaVersion: 1,
    candidateId: spec.attemptId,
    profile,
    spec,
  };
  return { intent, plan, spec };
};
