/**
 * Phase 6 W1 — UI rollout mode registry.
 *
 * The UX migration is staged and reversible per
 * `plans/bakudo-ux/06-rollout-reliability-and-operability.md:76-147`. This
 * module is the single source of truth for the four documented rollout
 * states. `--ui <mode>` selects a mode at invocation time; the active value
 * is observable via {@link getActiveUiMode} and is emitted in the
 * `bakudo doctor` envelope so bug reports can surface it directly.
 *
 * Rollout states (plan lines 94-126):
 *
 *   - `preview`  Stage A. Opt-in preview of the new host UX. Never default.
 *   - `default`  Stage B. New UX is the default; `--ui legacy` is the
 *                escape hatch. Current stage as of Phase 6 PR1.
 *   - `legacy`   Stages B + C. Legacy host surface (`--goal` + friends) is
 *                selected explicitly. Stage C hides this from help output
 *                but keeps the code path.
 *   - `hidden`   Stage C marker. The legacy code path is still reachable via
 *                `--ui legacy` but help no longer advertises it. Distinct
 *                from Stage D ("legacy removed") which this phase forbids.
 *
 * Hard rules enforced by this module (plan lines 128-131):
 *
 *   1. Do NOT remove the legacy path in the release that makes the new UX
 *      default. `legacy` MUST remain resolvable here as long as Stage C is
 *      the furthest the repo has advanced.
 *   2. Keep a documented rollback flag for at least one release cycle. That
 *      flag is `--ui legacy`; the help surface for it lives in
 *      {@link describeUiMode}.
 *   3. Record the active UI mode in `doctor` output and bug reports. The
 *      doctor envelope reads {@link getActiveUiMode}; see
 *      `src/host/commands/doctor.ts`.
 */

export type UiMode = "preview" | "default" | "legacy" | "hidden";

/**
 * The mode value the CLI defaults to when `--ui` is not supplied. Changing
 * this constant is the code-level signal that the rollout has advanced a
 * stage. Stage transitions (per plan 94-126):
 *
 *   - Pre-Stage-B: `DEFAULT_UI_MODE = "preview"` — new UX only via opt-in.
 *   - Stage B (current):  `DEFAULT_UI_MODE = "default"` — new UX is default,
 *                         `--ui legacy` fallback still advertised.
 *   - Stage C:            `DEFAULT_UI_MODE = "default"`, help output stops
 *                         listing `--ui legacy`; flag still works. Flip
 *                         {@link LEGACY_HIDDEN_IN_HELP} to `true`.
 *   - Stage D:            Not permitted in Phase 6 (plan line 129). Remove
 *                         `legacy` + `hidden` from this union only after a
 *                         dedicated release cycle.
 */
export const DEFAULT_UI_MODE: UiMode = "default";

/**
 * Whether `--ui legacy` is advertised in `bakudo --help`. Stage B keeps it
 * visible; Stage C flips this to `true`. Stage D removes the flag entirely
 * (not permitted in Phase 6).
 */
export const LEGACY_HIDDEN_IN_HELP = false as const;

/** Canonical list of accepted `--ui` values (for parsing + error messages). */
export const UI_MODES: readonly UiMode[] = ["preview", "default", "legacy", "hidden"];

/**
 * Parse a raw string from the CLI into a {@link UiMode}. Returns `undefined`
 * for unrecognized values so the caller can throw a parse error with the
 * original input in the message.
 */
export const parseUiMode = (raw: string): UiMode | undefined => {
  const normalized = raw.trim().toLowerCase();
  for (const mode of UI_MODES) {
    if (mode === normalized) {
      return mode;
    }
  }
  return undefined;
};

/**
 * Human-readable one-liner for each mode. Drives `--help` output and the
 * doctor report. Stable text — treat as contract for bug-report search.
 */
export const describeUiMode = (mode: UiMode): string => {
  switch (mode) {
    case "preview":
      return "opt-in preview of the new host UX (stage A)";
    case "default":
      return "new host UX (current default, stage B)";
    case "legacy":
      return "legacy --goal surface as an escape hatch (stages B-C)";
    case "hidden":
      // Phase 6 Wave 6d carryover #1 (from phase-6-mid handoff): this is
      // NOT an alias for `default` — selecting `--ui hidden` is the stage-C
      // marker that the legacy surface is hidden from help while the
      // `legacy` code path itself remains resolvable (plan 129 +
      // lock-in 27). The flag marks the stage-C rollout checkpoint, not a
      // default-UX shortcut.
      return "stage-C marker: legacy surface is hidden from --help, but `--ui legacy` still resolves (plan line 129)";
  }
};

/**
 * Process-local active mode. Set by `runHostCli` when `--ui` is parsed;
 * cleared via {@link resetActiveUiMode} on teardown so test harnesses that
 * reuse the process do not leak state across invocations.
 *
 * Kept as a module-local let instead of a class/singleton to match the
 * surrounding pattern (`flags.ts`, `copilotFlags.ts`).
 */
let activeUiMode: UiMode = DEFAULT_UI_MODE;

/**
 * Return the currently active UI mode. Always defined; defaults to
 * {@link DEFAULT_UI_MODE} when no `--ui` flag was supplied and no prior
 * call to {@link setActiveUiMode} happened this process.
 */
export const getActiveUiMode = (): UiMode => activeUiMode;

/**
 * Record the active UI mode for the current invocation. Validated by the
 * type system; callers that parse raw strings should run {@link parseUiMode}
 * first and throw on the `undefined` case.
 */
export const setActiveUiMode = (mode: UiMode): void => {
  activeUiMode = mode;
};

/** Reset the active mode to {@link DEFAULT_UI_MODE}. Used by test teardown. */
export const resetActiveUiMode = (): void => {
  activeUiMode = DEFAULT_UI_MODE;
};

/**
 * Consume `--ui <value>` / `--ui=value` at `argv[index]`. Returns the number
 * of tokens consumed and the parsed mode, or `{ consumed: 0 }` when the flag
 * does not match. Throws with the acceptable-values list on invalid input so
 * the user can recover without reading source.
 *
 * Delegation target for the main parser — inlined here (rather than in
 * `parsing.ts`) to keep `parsing.ts` under the 400-line cap.
 */
export const tryConsumeUiFlag = (
  argv: string[],
  index: number,
): { consumed: number; uiMode?: UiMode } => {
  const arg = argv[index];
  if (arg === undefined) {
    return { consumed: 0 };
  }
  if (arg !== "--ui" && !arg.startsWith("--ui=")) {
    return { consumed: 0 };
  }
  let rawValue: string;
  let consumed: number;
  if (arg === "--ui") {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error("missing value for --ui");
    }
    rawValue = next;
    consumed = 2;
  } else {
    rawValue = arg.slice("--ui=".length);
    consumed = 1;
  }
  const parsed = parseUiMode(rawValue);
  if (parsed === undefined) {
    throw new Error(
      `invalid --ui: expected one of ${UI_MODES.join(", ")} (got ${JSON.stringify(rawValue)})`,
    );
  }
  return { consumed, uiMode: parsed };
};
