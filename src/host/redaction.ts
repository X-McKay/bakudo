/**
 * Phase 6 Workstream 5 — Security And Data-Handling Rules.
 *
 * Defines the {@link RedactionPolicy} shape, the redaction primitives
 * ({@link redactText}, {@link redactRecord}), and the {@link DEFAULT_REDACTION_POLICY}
 * used everywhere the host persists, renders, or surfaces session data.
 *
 * Design summary (plan 06 §W5 lines 329-389):
 *
 *   1. Redaction must happen BEFORE persistence where possible (hard rule 382).
 *      Every artifact-record writer routes through {@link redactRecord} so the
 *      on-disk index never retains obvious secrets.
 *   2. Inspect summaries must NEVER expose raw secret values (hard rule 383).
 *      The inspect formatter routes string fields through {@link redactText}
 *      before rendering.
 *   3. `bakudo doctor` reports the active redaction policy mode (hard rule 384).
 *      See `src/host/commands/doctor.ts` — `redaction` section.
 *
 * The policy is DATA (a {@link RedactionPolicy} struct), not behaviour, so
 * callers can inject a stricter or looser policy per invocation without
 * forking this module. The Phase 2 config cascade accepts a `redaction`
 * block that deep-merges into the default.
 */

/**
 * Marker string substituted in place of any matched secret. Chosen to be
 * unambiguous in logs (`[REDACTED]` — six chars, brackets, uppercase) and to
 * survive a JSON round-trip without shell escaping. Kept as a module-level
 * constant so tests can assert the exact marker.
 */
export const REDACTION_MARKER = "[REDACTED]" as const;

/**
 * Declarative redaction policy consumed by {@link redactText} and
 * {@link redactRecord}. Three axes:
 *
 *   - `envAllowlist`:  env-var names that may pass through unfiltered when the
 *     host spawns a worker (consumed by {@link import("./envPolicy.js").filterEnv}
 *     via a mirrored key on {@link EnvPolicy}). Empty by default — callers
 *     opt individual names in via config cascade.
 *   - `envDenyPatterns`: regexes matched against env-var NAMES. A name that
 *     matches any pattern is redacted from records / inspect output even when
 *     present in the allowlist (defense in depth).
 *   - `textSecretPatterns`: regexes matched against the VALUE side of any
 *     string. Matched substrings are replaced with {@link REDACTION_MARKER}.
 */
export type RedactionPolicy = {
  envAllowlist: string[];
  envDenyPatterns: RegExp[];
  textSecretPatterns: RegExp[];
};

/**
 * Common env-var name patterns that almost always carry secrets. Used on
 * BOTH axes: filtered out of env passthrough unless explicitly allowlisted,
 * and scrubbed from persisted metadata when a record's key name matches.
 *
 * Patterns are deliberately conservative — the goal is "obvious secrets"
 * (plan acceptance criterion 388), not "every possible credential". Where a
 * substring could clash with a non-secret camelCase field (e.g. `sessionId`
 * vs the env var `SESSION_TOKEN`), the pattern anchors on uppercase +
 * underscore boundaries so bakudo's internal record shapes (camelCase keys
 * like `sessionId`, `artifactId`) are left alone.
 */
const DEFAULT_ENV_DENY_PATTERNS: RegExp[] = [
  /TOKEN/u,
  /SECRET/u,
  /(^|_)KEY($|_)/u,
  /PASSWORD/iu,
  /PASSWD/iu,
  /CREDENTIAL/iu,
  /(^|_)SESSION(_|$)/u,
  /(^|_)AUTH(_|$)/u,
  /COOKIE/u,
  /API_?KEY/u,
  /PRIVATE_?KEY/u,
  /BEARER/u,
];

/**
 * Common secret-looking VALUE patterns. Each replaces the matched substring
 * (not the whole field) with {@link REDACTION_MARKER} so surrounding context
 * in a log line survives for debugging.
 */
const DEFAULT_TEXT_SECRET_PATTERNS: RegExp[] = [
  // GitHub personal access tokens / fine-grained / installation tokens.
  /gh[pousr]_[A-Za-z0-9]{36,255}/gu,
  // OpenAI / Anthropic-style API keys.
  /sk-[A-Za-z0-9_-]{20,}/gu,
  // AWS access key IDs.
  /AKIA[0-9A-Z]{16}/gu,
  // AWS session tokens / secret access keys (40-char base64-ish).
  /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/giu,
  // Bearer / Basic auth headers.
  /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/giu,
  // Slack tokens.
  /xox[abpr]-[A-Za-z0-9-]{10,}/gu,
  // Generic `api_key=<value>`-style inline secrets (quoted or bare).
  /(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/giu,
  // JWT-shaped three-segment tokens.
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
];

/**
 * The default policy used by every persistence / render path when the caller
 * does not inject an override. Empty allowlist — nothing passes through to
 * workers by default.
 */
export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  envAllowlist: [],
  envDenyPatterns: DEFAULT_ENV_DENY_PATTERNS,
  textSecretPatterns: DEFAULT_TEXT_SECRET_PATTERNS,
};

/**
 * Replace every substring in `input` that matches any pattern in
 * `policy.textSecretPatterns` with {@link REDACTION_MARKER}. Pure — same
 * input, same output. Non-string inputs are returned unchanged.
 *
 * The function applies each pattern in turn; regexes with the global flag
 * replace every match, non-global regexes replace only the first. Callers
 * that want every-occurrence semantics MUST pass `g`-flag patterns (the
 * defaults in this module already do).
 */
export const redactText = (input: string, policy: RedactionPolicy): string => {
  if (typeof input !== "string" || input.length === 0) {
    return input;
  }
  let out = input;
  for (const pattern of policy.textSecretPatterns) {
    out = out.replace(pattern, REDACTION_MARKER);
  }
  return out;
};

/**
 * Test whether an env-var NAME matches any of `policy.envDenyPatterns`. A
 * match means the value is considered secret-bearing even if the var is in
 * the allowlist — defense in depth for metadata persisted in records.
 */
export const isDenyListedEnvName = (name: string, policy: RedactionPolicy): boolean => {
  for (const pattern of policy.envDenyPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
};

/**
 * Recursive redaction for persisted records and metadata. Traverses an
 * arbitrary JSON-shaped value and:
 *
 *   - replaces every string leaf via {@link redactText};
 *   - for object leaves whose KEY name matches any `envDenyPatterns`, replaces
 *     the VALUE (regardless of shape) with {@link REDACTION_MARKER}.
 *
 * Arrays are mapped element-wise; plain objects are rebuilt key-by-key.
 * Non-enumerable shapes (Map, Set, Buffer, Date) are passed through
 * unchanged — those do not appear in bakudo's JSON records.
 *
 * Returns a NEW object tree; the input is never mutated.
 */
export const redactRecord = <T>(
  value: T,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): T => {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value, policy) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactRecord(entry, policy)) as unknown as T;
  }
  if (typeof value === "object" && value.constructor === Object) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(src)) {
      if (isDenyListedEnvName(key, policy)) {
        // Deny-listed key name — blank the value regardless of shape. We
        // keep the KEY so the record's schema stays stable (inspect still
        // shows "password: [REDACTED]" rather than dropping the field).
        out[key] = REDACTION_MARKER;
        continue;
      }
      out[key] = redactRecord(v, policy);
    }
    return out as unknown as T;
  }
  // Primitives (number, boolean, bigint) + non-plain objects (Date, Buffer)
  // are returned unchanged. The JSON serializers handle them.
  return value;
};

/**
 * Summary used by `bakudo doctor` (hard rule 384) to describe the active
 * redaction policy without leaking the pattern bodies.
 */
export type RedactionPolicySummary = {
  active: boolean;
  envAllowlistCount: number;
  envDenyPatternCount: number;
  textPatternCount: number;
};

export const summarizeRedactionPolicy = (
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionPolicySummary => ({
  active: policy.textSecretPatterns.length > 0 || policy.envDenyPatterns.length > 0,
  envAllowlistCount: policy.envAllowlist.length,
  envDenyPatternCount: policy.envDenyPatterns.length,
  textPatternCount: policy.textSecretPatterns.length,
});

// ---------------------------------------------------------------------------
// Effective-policy factory (W6c PR7 carryover #7/#8)
// ---------------------------------------------------------------------------

/**
 * Input to {@link resolveEffectiveRedactionPolicy}. Both arrays are the
 * user-supplied pattern strings from the config cascade
 * (`redaction.extraTextPatterns`, `redaction.extraEnvDenyPatterns`).
 * Invalid regexes are dropped silently — the surface matches the
 * tolerant-merge pattern used elsewhere in the config layer.
 */
export type RedactionConfigExtra = {
  extraTextPatterns?: ReadonlyArray<string> | undefined;
  extraEnvDenyPatterns?: ReadonlyArray<string> | undefined;
};

const compilePatterns = (
  raw: ReadonlyArray<string>,
  flags: string,
): { ok: RegExp[]; rejected: string[] } => {
  const ok: RegExp[] = [];
  const rejected: string[] = [];
  for (const source of raw) {
    if (typeof source !== "string" || source.length === 0) {
      rejected.push(source);
      continue;
    }
    try {
      ok.push(new RegExp(source, flags));
    } catch {
      rejected.push(source);
    }
  }
  return { ok, rejected };
};

/**
 * Build the EFFECTIVE redaction policy: the default + any user-configured
 * `extraTextPatterns` / `extraEnvDenyPatterns` compiled as regexes.
 *
 * Plan 06 §W5 and Wave 6c carryover #7: the Zod schema already accepts
 * these fields. Before this factory the schema-accepted strings were
 * silently discarded by `artifactStore` and `inspectFormatter`, which
 * hard-coded `DEFAULT_REDACTION_POLICY`. This factory is the single seam
 * — callers pass the merged policy into `redactRecord` / `redactText` so
 * user overrides take effect end-to-end.
 *
 * Pattern-flag convention:
 *   - `extraTextPatterns` get `giu` so they match every occurrence,
 *     case-insensitively, with Unicode semantics — matches the spirit of
 *     {@link DEFAULT_TEXT_SECRET_PATTERNS}.
 *   - `extraEnvDenyPatterns` get `iu` (no global flag — name matching
 *     is membership-style, not substring-replacement).
 */
export const resolveEffectiveRedactionPolicy = (
  extra?: RedactionConfigExtra | undefined,
): RedactionPolicy => {
  if (
    extra === undefined ||
    (extra.extraTextPatterns === undefined && extra.extraEnvDenyPatterns === undefined)
  ) {
    return DEFAULT_REDACTION_POLICY;
  }
  const extraText = compilePatterns(extra.extraTextPatterns ?? [], "giu").ok;
  const extraEnv = compilePatterns(extra.extraEnvDenyPatterns ?? [], "iu").ok;
  return {
    envAllowlist: [...DEFAULT_REDACTION_POLICY.envAllowlist],
    envDenyPatterns: [...DEFAULT_REDACTION_POLICY.envDenyPatterns, ...extraEnv],
    textSecretPatterns: [...DEFAULT_REDACTION_POLICY.textSecretPatterns, ...extraText],
  };
};

/**
 * Host-side convenience mirroring `resolveEnvPolicyForHost` (lock-in 26):
 * resolve the effective redaction policy from a loaded config layer so
 * runner-construction sites never hard-code `DEFAULT_REDACTION_POLICY`.
 */
export const resolveRedactionPolicyForHost = (input: {
  configExtra?: RedactionConfigExtra | undefined;
}): RedactionPolicy => resolveEffectiveRedactionPolicy(input.configExtra);
