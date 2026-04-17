/**
 * Inline token-budget extraction from user prompts.
 *
 * Supports three patterns:
 *   1. Shorthand prefix:  `+500k do something` → 500_000
 *   2. Shorthand suffix:  `do something +500k.` → 500_000
 *   3. Verbose:           `spend 2M tokens on refactor` → 2_000_000
 *
 * Multipliers: k = 1_000, m = 1_000_000, b = 1_000_000_000.
 * First matching pattern wins. `cleanedPrompt` strips only the budget expression.
 */

export type TokenBudget = {
  /** Resolved token count. */
  tokens: number;
  /** Raw matched expression (e.g. "+500k", "spend 2M tokens"). */
  raw: string;
};

export type TokenBudgetParseResult = {
  budget: TokenBudget | null;
  cleanedPrompt: string;
};

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

/**
 * Ordered list of extraction patterns. Each entry defines a regex and how to
 * derive `raw` and `cleanedPrompt` from the match.
 */
type PatternDef = {
  regex: RegExp;
  extract: (match: RegExpExecArray, prompt: string) => { raw: string; cleaned: string };
};

const PATTERNS: readonly PatternDef[] = [
  // 1. Shorthand prefix: `+500k ...` or `+2.5M ...`
  {
    regex: /^\+(\d+(?:\.\d+)?)(k|m|b)\b\s*/i,
    extract: (match, prompt) => ({
      raw: match[0]!.trim(),
      cleaned: prompt.slice(match[0]!.length).trim(),
    }),
  },
  // 2. Shorthand suffix: `... +500k.` or `... +500k`
  {
    regex: /\s*\+(\d+(?:\.\d+)?)(k|m|b)\.?\s*$/i,
    extract: (match, prompt) => ({
      raw: match[0]!.trim().replace(/\.$/, ""),
      cleaned: prompt.slice(0, match.index).trim(),
    }),
  },
  // 3. Verbose: `spend 2M tokens on ...`
  {
    regex: /spend\s+(\d+(?:\.\d+)?)(k|m|b)\s+tokens?\b\s*/i,
    extract: (match, prompt) => ({
      raw: match[0]!.trim(),
      cleaned: (prompt.slice(0, match.index) + prompt.slice(match.index! + match[0]!.length))
        .replace(/\s+/g, " ")
        .trim(),
    }),
  },
];

const resolveTokens = (value: string, suffix: string): number => {
  const multiplier = MULTIPLIERS[suffix.toLowerCase()]!;
  return parseFloat(value) * multiplier;
};

/**
 * Parse a token budget from the prompt. Returns the budget (if any) and the
 * cleaned prompt with the budget expression removed.
 */
export const parseTokenBudget = (prompt: string): TokenBudgetParseResult => {
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(prompt);
    if (match !== null) {
      const numStr = match[1]!;
      const suffix = match[2]!;
      const tokens = resolveTokens(numStr, suffix);
      const { raw, cleaned } = pattern.extract(match, prompt);
      return {
        budget: { tokens, raw },
        cleanedPrompt: cleaned,
      };
    }
  }
  return { budget: null, cleanedPrompt: prompt };
};
