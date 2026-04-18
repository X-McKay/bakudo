/**
 * Phase 6 Wave 6c PR7 / A6.7 — persistent log-level resolution.
 *
 * Plan 06 lines 938-949:
 *
 *   Config key  `log_level`  at `~/.config/bakudo/config.json`.
 *   Values      `"none" | "error" | "warning" | "info" | "debug" | "all" | "default"`.
 *   Override    `BAKUDO_LOG_LEVEL=<level>` env var.
 *   Override    `--log-level=<level>` CLI flag.
 *   `default`   resolves to `warning` in TTY interactive mode, `info` otherwise.
 *
 * This module is pure — the config cascade (see `src/host/config.ts`) owns
 * the `logLevel` schema field; this file owns the deterministic merge that
 * produces the final effective level for a process.
 */

export type LogLevel = "none" | "error" | "warning" | "info" | "debug" | "all" | "default";

/** The seven permitted values in the plan-stated precedence. */
export const LOG_LEVELS: ReadonlyArray<LogLevel> = [
  "none",
  "error",
  "warning",
  "info",
  "debug",
  "all",
  "default",
];

/**
 * Level ordering used for filter comparison. Lower ordinal = less verbose.
 * `default` is deliberately NOT in this map — it resolves through the
 * TTY-aware heuristic before any comparison is made.
 */
export const LOG_LEVEL_ORDINALS: Readonly<Record<Exclude<LogLevel, "default">, number>> = {
  none: 0,
  error: 1,
  warning: 2,
  info: 3,
  debug: 4,
  all: 5,
};

/** Narrow a free-form string to a {@link LogLevel} (case-insensitive). */
export const parseLogLevel = (value: string | undefined): LogLevel | undefined => {
  if (value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  for (const level of LOG_LEVELS) {
    if (level === normalised) return level;
  }
  return undefined;
};

/**
 * Input to {@link resolveLogLevel}. Any field may be absent.
 *
 * - `config`: value from the deep-merged config cascade.
 * - `env`: raw `$BAKUDO_LOG_LEVEL` string (we parse here).
 * - `cliFlag`: raw `--log-level=<value>` argument body (we parse here).
 * - `isTty`: whether the host detected an interactive TTY. Drives the
 *   `default` → concrete level collapse. Missing = `false` (non-interactive).
 */
export type ResolveLogLevelInput = {
  config?: LogLevel | undefined;
  env?: string | undefined;
  cliFlag?: string | undefined;
  isTty?: boolean | undefined;
};

/**
 * Resolve the effective log level given the four precedence sources.
 *
 * Precedence (highest wins):
 *   1. `cliFlag`    — `--log-level=<level>`
 *   2. `env`        — `$BAKUDO_LOG_LEVEL`
 *   3. `config`     — persistent `log_level` field
 *   4. `default`    — `warning` if `isTty`, else `info`
 *
 * `default` from any source falls through to the TTY heuristic so a user
 * who writes `"log_level": "default"` gets the documented behaviour instead
 * of a literal "default" leaking into the logger filter.
 */
export const resolveLogLevel = (input: ResolveLogLevelInput): Exclude<LogLevel, "default"> => {
  const cli = parseLogLevel(input.cliFlag);
  const env = parseLogLevel(input.env);
  const cfg = input.config;

  const first: LogLevel | undefined = cli ?? env ?? cfg;
  if (first !== undefined && first !== "default") {
    return first;
  }
  // `default` or no source — TTY-aware fallback.
  return input.isTty === true ? "warning" : "info";
};

/**
 * Extract the body of a `--log-level=<value>` flag from an argv list.
 * Returns `undefined` when no such flag is present. Both
 * `--log-level=debug` and `--log-level debug` forms are accepted; the
 * second form reads the next argv slot.
 */
export const extractLogLevelCliFlag = (argv: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--log-level=")) {
      return arg.slice("--log-level=".length);
    }
    if (arg === "--log-level" && i + 1 < argv.length) {
      return argv[i + 1];
    }
  }
  return undefined;
};

/**
 * Classic threshold predicate. Returns `true` when a line tagged with
 * `candidate` should be emitted under the effective `threshold`.
 * `candidate` is a concrete level (never `default` — callers must resolve
 * first); `threshold` is likewise concrete.
 */
export const shouldLog = (
  threshold: Exclude<LogLevel, "default">,
  candidate: Exclude<LogLevel, "default">,
): boolean => LOG_LEVEL_ORDINALS[candidate] <= LOG_LEVEL_ORDINALS[threshold];
