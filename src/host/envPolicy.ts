/**
 * Phase 6 Workstream 5 — env-var passthrough policy.
 *
 * Determines which environment variables from the bakudo host process may be
 * forwarded to an abox-spawned worker. The default allowlist is EMPTY —
 * nothing passes through unless a user opts in via the Phase 2 config
 * cascade or the `BAKUDO_ENV_ALLOWLIST` override.
 *
 * Plan 06 §W5 recommended default rule 3 ("require explicit opt-in for
 * passing nonstandard env vars to workers") and hard rule 381 motivate this
 * module: we centralise the allow/deny decision so every dispatch path —
 * `aboxTaskRunner`, future direct-spawn paths, and test harnesses — shares
 * one set of rules.
 */

import {
  DEFAULT_REDACTION_POLICY,
  isDenyListedEnvName,
  type RedactionPolicy,
} from "./redaction.js";

/**
 * An env-passthrough policy. Intentionally small — the heavy lifting of
 * secret-name matching lives on {@link RedactionPolicy}. An {@link EnvPolicy}
 * stores the user-facing allowlist and inherits the deny patterns from the
 * bound redaction policy so the two cannot drift.
 */
export type EnvPolicy = {
  /** Names that may be forwarded to spawned workers. Case-sensitive. */
  allowlist: ReadonlyArray<string>;
  /** Deny-pattern source (defaults to {@link DEFAULT_REDACTION_POLICY}). */
  redactionPolicy: RedactionPolicy;
};

/**
 * The default policy — empty allowlist, deny patterns inherited from
 * {@link DEFAULT_REDACTION_POLICY}. Plan 06 line 362 explicitly: "require
 * explicit opt-in for passing nonstandard env vars to workers".
 */
export const DEFAULT_ENV_POLICY: EnvPolicy = {
  allowlist: [],
  redactionPolicy: DEFAULT_REDACTION_POLICY,
};

/**
 * A readable map of process env vars (the shape `process.env` produces:
 * `string | undefined` values).
 */
export type EnvMap = Readonly<Record<string, string | undefined>>;

/**
 * Filter a full env map down to the subset allowed by `policy`.
 *
 * Rules (applied in order):
 *   1. A name must appear in `policy.allowlist` to survive.
 *   2. A name that also matches any deny pattern is dropped (defense in
 *      depth — user cannot accidentally allowlist a secret by name).
 *   3. `undefined` values are dropped (matching the JSON env shape node
 *      expects when forwarding to a child process).
 *
 * Pure — no process-state reads, no mutation. Returns a fresh object so
 * callers can safely pass it to `child_process.spawn`.
 */
export const filterEnv = (
  fullEnv: EnvMap,
  policy: EnvPolicy = DEFAULT_ENV_POLICY,
): Record<string, string> => {
  const allow = new Set(policy.allowlist);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(fullEnv)) {
    if (!allow.has(name)) continue;
    if (value === undefined) continue;
    if (isDenyListedEnvName(name, policy.redactionPolicy)) continue;
    out[name] = value;
  }
  return out;
};

/**
 * Validate a user-provided allowlist from config or an environment variable.
 *
 * Rejects:
 *   - Empty strings
 *   - Entries that do not match `/^[A-Za-z_][A-Za-z0-9_]*$/` (POSIX env-var
 *     name grammar; no spaces, no `=` signs)
 *
 * Returns `{ ok, names }` with the validated subset; invalid names surface in
 * `ok === false` output so the caller can warn and fall back to the empty
 * default without crashing.
 */
export const validateEnvAllowlist = (
  raw: ReadonlyArray<string>,
): { ok: boolean; names: string[]; rejected: string[] } => {
  const shape = /^[A-Za-z_][A-Za-z0-9_]*$/u;
  const names: string[] = [];
  const rejected: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      rejected.push(String(entry));
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || !shape.test(trimmed)) {
      rejected.push(entry);
      continue;
    }
    names.push(trimmed);
  }
  return { ok: rejected.length === 0, names, rejected };
};

/**
 * Parse the comma-separated `BAKUDO_ENV_ALLOWLIST` override. Empty / missing
 * string returns an empty allowlist (matching the safe default).
 */
export const parseEnvAllowlistOverride = (raw: string | undefined): string[] => {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return validateEnvAllowlist(parts).names;
};

/**
 * Build an {@link EnvPolicy} from the (optional) config cascade block plus
 * the `BAKUDO_ENV_ALLOWLIST` env override. The override wins — it is a
 * session-scoped escape hatch while the config block is workspace-durable.
 */
export const resolveEnvPolicy = (input: {
  configAllowlist?: ReadonlyArray<string>;
  overrideRaw?: string | undefined;
  redactionPolicy?: RedactionPolicy;
}): EnvPolicy => {
  const fromConfig =
    input.configAllowlist !== undefined ? validateEnvAllowlist(input.configAllowlist).names : [];
  const fromOverride = parseEnvAllowlistOverride(input.overrideRaw);
  const merged = Array.from(new Set([...fromConfig, ...fromOverride]));
  return {
    allowlist: merged,
    redactionPolicy: input.redactionPolicy ?? DEFAULT_REDACTION_POLICY,
  };
};
