import type { AttemptSpec, TurnIntent } from "../attemptProtocol.js";
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
): { intent: TurnIntent; spec: AttemptSpec } => {
  const intent = buildTurnIntent(prompt, composerMode, context.repoRoot, options);
  const spec = compileAttemptSpec(intent, context);
  return { intent, spec };
};
