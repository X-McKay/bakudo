import type {
  PermissionEffect,
  PermissionRule,
  PermissionSource,
  PermissionTool,
} from "../attemptProtocol.js";

// ---------------------------------------------------------------------------
// Glob matching — inline, no external dependency
// ---------------------------------------------------------------------------

/**
 * Minimal glob matcher supporting `*` (any segment chars) and `**` (any number
 * of path segments including nested). Patterns are matched against the full
 * `target` string; no implicit anchoring is added.
 *
 * Supported:
 * - `*`  — matches any sequence of non-`/` characters within a single segment
 * - `**` — matches any sequence of characters including `/` (cross-segment)
 * - Literal characters are compared case-sensitively
 *
 * NOT supported (intentionally out-of-scope): `?`, `[abc]`, `{a,b}`.
 */
export const matchGlob = (pattern: string, target: string): boolean => {
  // Fast-path: literal equality or universal wildcard.
  if (pattern === "*" || pattern === "**") {
    return true;
  }
  if (!pattern.includes("*")) {
    return pattern === target;
  }

  // Convert pattern → regex.
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      // `**` matches everything (including path separators).
      regex += ".*";
      i += 2;
      // Skip a trailing `/` after `**` (e.g. `src/**/foo` → `src/` then `foo`).
      if (pattern[i] === "/") {
        // The `.*` already consumed the `/`, but we need the next segment to
        // match either after a `/` or at the start (for `**/foo` matching `foo`).
        regex += "(?:/)?";
        i++;
      }
    } else if (pattern[i] === "*") {
      // Single `*` — matches any non-`/` characters.
      regex += "[^/]*";
      i++;
    } else {
      // Escape regex-special characters.
      regex += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      i++;
    }
  }
  regex += "$";

  return new RegExp(regex, "u").test(target);
};

// ---------------------------------------------------------------------------
// Permission evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a permission request against a rule set. Implements the
 * deny-precedence invariant:
 *
 * 1. Filter rules where `rule.tool === tool` or `rule.tool === "*"`.
 * 2. Test `target` against each matching rule's `pattern` via {@link matchGlob}.
 * 3. If ANY matching rule has `effect === "deny"` → `"deny"`.
 * 4. Else if any has `"allow"` → `"allow"`.
 * 5. Else if any has `"ask"` → `"ask"`.
 * 6. No rules match → `"ask"` (safe default).
 */
export const evaluatePermission = (
  rules: PermissionRule[],
  tool: PermissionTool,
  target: string,
): PermissionEffect => {
  let hasAllow = false;
  let hasAsk = false;

  for (const rule of rules) {
    // Tool must match exactly or be the wildcard `*`.
    if (rule.tool !== tool && rule.tool !== "*") {
      continue;
    }
    // Pattern must match the target.
    if (!matchGlob(rule.pattern, target)) {
      continue;
    }
    // Deny wins immediately.
    if (rule.effect === "deny") {
      return "deny";
    }
    if (rule.effect === "allow") {
      hasAllow = true;
    } else {
      hasAsk = true;
    }
  }

  if (hasAllow) {
    return "allow";
  }
  if (hasAsk) {
    return "ask";
  }
  // No matching rules — safe default.
  return "ask";
};

// ---------------------------------------------------------------------------
// Profile compiler
// ---------------------------------------------------------------------------

/**
 * Convert a short-form agent profile permission map into a `PermissionRule[]`.
 * Each entry produces a rule with `pattern: "*"` (matches everything for that
 * tool) and the given `source`.
 *
 * Example input: `{ shell: "allow", write: "ask", network: "deny" }`
 */
export const compileProfilePermissions = (
  profile: Record<string, "allow" | "ask" | "deny">,
  source: PermissionSource,
): PermissionRule[] =>
  Object.entries(profile).map(([tool, effect]) => ({
    effect,
    tool,
    pattern: "*",
    source,
  }));
