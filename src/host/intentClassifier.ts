import { randomUUID } from "node:crypto";

import type { TurnIntent, TurnIntentKind } from "../attemptProtocol.js";
import type { ComposerMode } from "./appState.js";

// ---------------------------------------------------------------------------
// Check-like prompt patterns
// ---------------------------------------------------------------------------

const CHECK_PROMPT_RE = /^(run|execute|check)\s+(tests?|lint|typecheck|build)\b/iu;
const CHECK_SLASH_RE = /^\/check\b/u;

// ---------------------------------------------------------------------------
// Intent classification — deterministic, no LLM
// ---------------------------------------------------------------------------

/**
 * Classify a user prompt into one of four intent kinds using deterministic
 * heuristics. Rules are evaluated in order; first match wins.
 *
 * 1. `isExplicitCommand` flag (set by `/run-command`) → `run_explicit_command`
 * 2. `composerMode === "plan"` → `inspect_repository`
 * 3. Check-like pattern in prompt → `run_check`
 * 4. Default → `implement_change`
 */
export const classifyIntent = (
  prompt: string,
  composerMode: ComposerMode,
  options?: { isExplicitCommand?: boolean },
): TurnIntentKind => {
  if (options?.isExplicitCommand === true) {
    return "run_explicit_command";
  }
  if (composerMode === "plan") {
    return "inspect_repository";
  }
  if (CHECK_PROMPT_RE.test(prompt) || CHECK_SLASH_RE.test(prompt)) {
    return "run_check";
  }
  return "implement_change";
};

// ---------------------------------------------------------------------------
// Acceptance goals and constraints per intent kind
// ---------------------------------------------------------------------------

const GOALS: Record<TurnIntentKind, string[]> = {
  inspect_repository: ["produce summary", "do not modify repo"],
  implement_change: ["make requested change", "run targeted checks"],
  run_check: ["execute command and capture outputs"],
  run_explicit_command: ["execute command and capture outputs"],
};

const CONSTRAINTS: Record<TurnIntentKind, string[]> = {
  inspect_repository: ["read-only intent"],
  implement_change: ["prefer minimal diff", "summarize results clearly"],
  run_check: ["explicit check path"],
  run_explicit_command: ["explicit shell path"],
};

// ---------------------------------------------------------------------------
// TurnIntent builder
// ---------------------------------------------------------------------------

/**
 * Generate an intent ID with the format `intent-<epochMs>-<rand8>`.
 */
const intentIdFor = (): string => `intent-${Date.now()}-${randomUUID().slice(0, 8)}`;

/**
 * Build a full {@link TurnIntent} by classifying the prompt, then populating
 * acceptance goals, constraints, and metadata.
 */
export const buildTurnIntent = (
  prompt: string,
  composerMode: ComposerMode,
  repoRoot: string,
  options?: { isExplicitCommand?: boolean; tokenBudget?: number },
): TurnIntent => {
  const kind = classifyIntent(prompt, composerMode, options);
  return {
    intentId: intentIdFor(),
    kind,
    composerMode,
    prompt,
    repoRoot,
    acceptanceGoals: GOALS[kind],
    constraints: CONSTRAINTS[kind],
    ...(options?.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
  };
};
