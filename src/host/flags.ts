/**
 * Phase 5 PR13 — fine-grained experimental-flag registry and accessor.
 *
 * Mirrors OpenCode's env-var gate pattern
 * (`refs/opencode/packages/opencode/src/flag/flag.ts:52-86`): each feature
 * registers a name + description in {@link EXPERIMENTAL_FLAGS}. Runtime
 * checks call {@link experimental} at the access site (late-binding), so
 * env vars set mid-session take effect on the next evaluation.
 *
 * Resolution order for `experimental(flagName)` (highest-wins):
 *
 *   1. `BAKUDO_EXPERIMENTAL_<FLAG>=1|true|on|yes` — per-feature env var.
 *   2. `BAKUDO_EXPERIMENTAL=all` — cluster env var turns every flag on.
 *   3. {@link configResolver} (optional) — merged config provider. A
 *      `Record<string, boolean>` keyed by flag name overrides the cluster,
 *      while a bare `boolean` enables the whole cluster.
 *   4. `false` — flags default off.
 *
 * The `Record<string, boolean>` vs `boolean` split at layer 3 matches the
 * UX plan: `/experimental on` writes `{ experimental: true }` to enable
 * the cluster; per-feature toggles write `{ experimental: { FLAG: true } }`.
 */

/**
 * Metadata for a single experimental feature gate. `name` is the SHOUTY_SNAKE
 * identifier used in `BAKUDO_EXPERIMENTAL_<NAME>` and in the config
 * `experimental` record. `description` renders in `/experimental show` and
 * `bakudo help config`.
 */
export type ExperimentalFlag = { name: string; description: string };

/**
 * Registered experimental features. Extend this array as features ship so
 * `/experimental show` and `bakudo help config` keep a single source of
 * truth for what is gated. The two entries below seed the registry for
 * Phase 5 — QUICK_SEARCH gates Ctrl+Shift+F global search (PR14 candidate)
 * and RICH_TUI gates the experimental rich TUI renderer rollout.
 */
export const EXPERIMENTAL_FLAGS: readonly ExperimentalFlag[] = [
  { name: "QUICK_SEARCH", description: "Enable Ctrl+Shift+F global search" },
  { name: "RICH_TUI", description: "Enable the experimental rich TUI renderer" },
];

/**
 * Shape of the `experimental` config field after merge. Either a bare
 * boolean (cluster on/off, legacy shape) or a per-feature record.
 */
export type ExperimentalConfigValue = boolean | Record<string, boolean>;

/**
 * Supplier that returns the merged experimental config. Injected so the
 * accessor can be unit-tested without booting the full config cascade.
 * Returning `undefined` is equivalent to "cluster off, no overrides".
 */
export type ExperimentalConfigResolver = () => ExperimentalConfigValue | undefined;

let configResolver: ExperimentalConfigResolver | undefined;

/**
 * Session-scoped cluster override set by the `--experimental` startup flag.
 * Distinct from the persisted config so a flag-driven session does not
 * mutate `~/.config/bakudo/config.json`. Evaluated between the env-var
 * layer and the config-resolver layer.
 */
let sessionClusterOverride: boolean | undefined;

/**
 * Turn the experimental cluster on for the current process only. Invoked by
 * the host CLI when `--experimental` is parsed. Does NOT persist.
 */
export const setSessionExperimentalCluster = (enabled: boolean): void => {
  sessionClusterOverride = enabled;
};

/** Clear the session override so later tests start from the env/config state. */
export const resetSessionExperimentalCluster = (): void => {
  sessionClusterOverride = undefined;
};

/**
 * Install a supplier that returns the merged experimental config.
 * `bootstrap` calls this after the cascade loads so `experimental(flag)`
 * can consult the user/repo config. Callers MUST invoke
 * {@link resetExperimentalConfigResolver} between test cases to avoid
 * cross-test leakage.
 */
export const setExperimentalConfigResolver = (resolver: ExperimentalConfigResolver): void => {
  configResolver = resolver;
};

/** Clear the resolver so later tests start from the env-only state. */
export const resetExperimentalConfigResolver = (): void => {
  configResolver = undefined;
};

/**
 * Normalize a value read from env or config. `undefined` / empty string
 * return `undefined`; recognized truthy and falsy strings return booleans;
 * anything else returns `undefined` (treated as "no opinion at this layer").
 */
const parseBool = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed === "1" || trimmed === "true" || trimmed === "on" || trimmed === "yes") {
    return true;
  }
  if (trimmed === "0" || trimmed === "false" || trimmed === "off" || trimmed === "no") {
    return false;
  }
  return undefined;
};

/**
 * Read an env var case-sensitively (matches OpenCode). Node preserves env-var
 * case on POSIX; on Windows env vars are case-insensitive at the OS level but
 * `process.env` indexing remains case-sensitive — documented risk, acceptable
 * for a developer-facing CLI.
 */
const readEnv = (name: string): string | undefined => process.env[name];

/**
 * Evaluate the experimental gate for `flagName`. Late-binding: the value is
 * computed at each call so env-var changes take effect without restart.
 *
 * @param flagName — must be a {@link EXPERIMENTAL_FLAGS} `name`. Unknown
 *   flag names still resolve through the same rules (forward-compat for
 *   features added to the registry before this file ships).
 */
export const experimental = (flagName: string): boolean => {
  // Layer 1: per-feature env var.
  const perFeature = parseBool(readEnv(`BAKUDO_EXPERIMENTAL_${flagName}`));
  if (perFeature !== undefined) {
    return perFeature;
  }

  // Layer 2: cluster env var (`BAKUDO_EXPERIMENTAL=all`).
  const clusterEnv = readEnv("BAKUDO_EXPERIMENTAL");
  if (clusterEnv !== undefined && clusterEnv.trim().toLowerCase() === "all") {
    return true;
  }

  // Layer 2.5: session-scoped `--experimental` flag.
  if (sessionClusterOverride === true) {
    return true;
  }

  // Layer 3: merged config (cluster boolean or per-feature record).
  const configValue = configResolver?.();
  if (configValue !== undefined) {
    if (typeof configValue === "boolean") {
      return configValue;
    }
    const byFlag = configValue[flagName];
    if (typeof byFlag === "boolean") {
      return byFlag;
    }
    // Per-feature record with no entry for this flag → treat as "cluster off"
    // unless an explicit cluster entry exists. The magic key "all" inside the
    // record mirrors the env var for consistency with /experimental on.
    const clusterEntry = configValue["all"];
    if (typeof clusterEntry === "boolean") {
      return clusterEntry;
    }
  }

  // Layer 4: default off.
  return false;
};

/**
 * Summarize the current state of every registered flag. Used by
 * `/experimental show` and future `bakudo help config` output.
 */
export const summarizeExperimentalFlags = (): ReadonlyArray<{
  name: string;
  description: string;
  enabled: boolean;
}> =>
  EXPERIMENTAL_FLAGS.map((flag) => ({
    name: flag.name,
    description: flag.description,
    enabled: experimental(flag.name),
  }));
