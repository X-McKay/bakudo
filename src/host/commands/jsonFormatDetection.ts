/**
 * Phase 6 Wave 6c PR8 — shared argv inspection for error-envelope routing.
 *
 * When a subcommand's own parser rejects its argv, the CLI wrapper needs to
 * decide whether to emit a plain-text diagnostic or the canonical
 * `{ok:false, kind:"error", error:{code,message,details?}}` envelope (phase-6-mid
 * handoff lock-in 19). The decision cannot come from the parser's successful
 * result because there isn't one; instead we scan the raw argv for the
 * `--format=json` / `--output-format=json` marker that the caller explicitly
 * set, and fall back to the non-TTY hint (lock-in 12 — JSON mode is
 * TTY-independent, so a non-TTY caller is implicitly machine-readable).
 *
 * Kept in its own module so every command that grew a `--format` knob can
 * reuse the same detection without a circular import through the command
 * barrel.
 */

/** Flags a caller might use to request JSON output on these subcommands. */
const JSON_FORMAT_TOKENS: readonly string[] = ["--format=json", "--output-format=json"];

/** Long flags whose *next* argv token carries the format value. */
const JSON_FORMAT_FLAGS: readonly string[] = ["--format", "--output-format"];

/**
 * Detect whether the caller requested JSON output. Honours both the
 * `--format=json` / `--output-format=json` inline form and the space-separated
 * `--format json` / `--output-format json` form. When no explicit token is
 * present, falls back to `stdoutIsTty === false` (machine-readable is the
 * documented default for non-TTY callers per lock-in 12).
 *
 * The `stdoutIsTty` argument is intentionally `boolean | undefined`: a
 * missing probe (test harness, sub-shell) is treated as non-TTY, which is
 * also the runtime default in `runUsageCommand` / `runChronicleCommand`.
 */
export const argvRequestsJson = (argv: ReadonlyArray<string>, stdoutIsTty?: boolean): boolean => {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (JSON_FORMAT_TOKENS.includes(arg)) return true;
    if (JSON_FORMAT_FLAGS.includes(arg) && argv[i + 1] === "json") return true;
  }
  return stdoutIsTty === false;
};
