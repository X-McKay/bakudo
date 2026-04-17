import type { AttemptSpec } from "../attemptProtocol.js";
import type { TaskRunnerCommand } from "./taskKinds.js";

/**
 * `verification_check` runner.
 *
 * Runs `spec.acceptanceChecks` commands sequentially, fail-fast: the first
 * check whose command exits non-zero stops the sequence.
 *
 * Because workerRuntime spawns a single process, the runner folds all check
 * commands into a single `bash -lc` invocation joined by `&&`.
 */
export const runVerificationCheck = (spec: AttemptSpec): TaskRunnerCommand => {
  const checks = spec.acceptanceChecks.filter(
    (c) => c.command !== undefined && c.command.length > 0,
  );
  if (checks.length === 0) {
    return { command: ["echo", "no acceptance checks defined"] };
  }

  // Each check.command is a string[]. We shell-quote each token and join with
  // && so `bash -lc` runs them sequentially, stopping at the first failure.
  const joined = checks.map((c) => c.command!.map(shellQuote).join(" ")).join(" && ");

  return { command: ["bash", "-lc", joined] };
};

/**
 * Minimal shell quoting: wraps a token in single quotes unless it is clearly
 * safe (alphanumeric + common path characters only).
 */
const shellQuote = (token: string): string => {
  if (/^[a-zA-Z0-9_./:@=+-]+$/.test(token)) {
    return token;
  }
  // Escape embedded single quotes: replace ' with '\''
  return `'${token.replace(/'/g, "'\\''")}'`;
};
