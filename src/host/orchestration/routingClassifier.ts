/**
 * Routing Classifier
 *
 * Decides whether a user's natural-language input should be routed through
 * the Cognitive Meta-Orchestrator pipeline (complex goal → ObjectiveController)
 * or the existing single-shot SessionController path (simple request).
 *
 * Classification is intentionally heuristic — no LLM call, no latency.
 * The goal is to route correctly for the common cases:
 *
 * Simple (SessionController path):
 *   - Slash commands (`/version`, `/help`, etc.)
 *   - Very short queries (< 60 chars) with no multi-step keywords
 *   - Questions ("what is", "how do", "explain", "show me")
 *   - Single-file lookups ("read", "open", "cat", "print")
 *
 * Complex (ObjectiveController / meta-orchestrator path):
 *   - Multi-step engineering goals ("refactor", "implement", "migrate")
 *   - Tasks that imply parallel work ("add tests for", "redesign", "rewrite")
 *   - Goals with conjunctions ("and then", "also", "as well as")
 *   - Long inputs (≥ 60 chars) that don't match the simple-question pattern
 */

export type GoalComplexity = "simple" | "complex";

// ---------------------------------------------------------------------------
// Keyword lists
// ---------------------------------------------------------------------------

/**
 * Keywords that strongly suggest a multi-step engineering goal.
 * Matched case-insensitively against the full input string.
 */
const COMPLEX_KEYWORDS: readonly string[] = [
  "refactor",
  "implement",
  "add tests",
  "write tests",
  "migrate",
  "redesign",
  "rewrite",
  "create a",
  "build a",
  "build the",
  "set up",
  "set up a",
  "integrate",
  "update all",
  "fix all",
  "add support",
  "add feature",
  "add a feature",
  "extract",
  "decompose",
  "split",
  "consolidate",
  "move all",
  "rename all",
  "delete all",
  "remove all",
];

/**
 * Patterns that strongly suggest a simple question or lookup.
 * Matched case-insensitively against the trimmed input.
 */
const SIMPLE_PATTERNS: readonly RegExp[] = [
  /^what\s/i,
  /^how\s/i,
  /^why\s/i,
  /^when\s/i,
  /^where\s/i,
  /^who\s/i,
  /^explain\s/i,
  /^show\s+me\s/i,
  /^tell\s+me\s/i,
  /^list\s/i,
  /^print\s/i,
  /^read\s/i,
  /^open\s/i,
  /^cat\s/i,
  /^describe\s/i,
  /^summarize\s/i,
  /^check\s/i,
  /^find\s/i,
  /^search\s/i,
  /^look\s+up\s/i,
  /^is\s/i,
  /^does\s/i,
  /^can\s+you\s/i,
  /^do\s+you\s/i,
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a user's natural-language goal as `"simple"` or `"complex"`.
 *
 * The classification drives routing in `runTurn()`:
 * - `"simple"` → existing `executePromptFromResolution` / SessionController path
 * - `"complex"` → `OrchestratorDriver` → ObjectiveController pipeline
 *
 * @param text - The raw user input (already trimmed of leading/trailing whitespace).
 */
export const classifyGoal = (text: string): GoalComplexity => {
  const trimmed = text.trim();

  // Slash commands are always simple (handled by the command registry).
  if (trimmed.startsWith("/")) {
    return "simple";
  }

  // Empty input is simple (no-op).
  if (trimmed.length === 0) {
    return "simple";
  }

  const lower = trimmed.toLowerCase();

  // Check for simple-question patterns first — these override length.
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "simple";
    }
  }

  // Check for complex-goal keywords.
  for (const keyword of COMPLEX_KEYWORDS) {
    if (lower.includes(keyword)) {
      return "complex";
    }
  }

  // Long inputs without a simple-question pattern are treated as complex.
  if (trimmed.length >= 60) {
    return "complex";
  }

  // Default: short, no keywords → simple.
  return "simple";
};
