import type {
  AttemptSpec,
  DispatchPlan,
  ExecutionProfile,
  TurnIntent,
} from "../attemptProtocol.js";
import type { ComposerMode } from "./appState.js";
import { compileAttemptSpec, type CompilerContext } from "./attemptCompiler.js";
import { buildTurnIntent } from "./intentClassifier.js";
import { providerRegistry } from "./providerRegistry.js";

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
  // Wave 1: Use registered provider ID. Resolve command on the host so the
  // worker never needs to import the registry.
  const providerId = "codex";
  const profile: ExecutionProfile = {
    providerId,
    resolvedCommand: providerRegistry.get(providerId).command,
    sandboxLifecycle: usesEphemeralSandbox ? "ephemeral" : "preserved",
    candidatePolicy: usesEphemeralSandbox ? "discard" : isAuto ? "auto_apply" : "manual_apply",
  };
  const plan: DispatchPlan = {
    schemaVersion: 1,
    candidateId: spec.attemptId,
    profile,
    spec,
  };
  return { intent, plan, spec };
};
