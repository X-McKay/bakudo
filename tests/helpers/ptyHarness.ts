/**
 * Phase 6 Workstream 10 (PR15) — PTY harness.
 *
 * Spawns the configured command under a pseudo-terminal so the TTY
 * renderer path is exercised, and captures the resulting byte stream
 * for golden comparison. Golden fixtures live at
 * `plans/bakudo-ux/examples/*.tty.txt` and are loaded by `./golden.ts`.
 *
 * `node-pty` is NOT a dependency of bakudo — no native build, portability
 * across CI. Instead, this harness allocates a PTY via the POSIX
 * `script(1)` utility (available on every Linux and macOS host, already
 * used by other integration tests). If `script(1)` is not present,
 * `runUnderPty` resolves `{ status: "skipped" }` so callers can skip
 * cleanly.
 *
 * The returned `PtyRunResult.bytes` is the raw TTY byte stream — ANSI
 * escapes as real `\u001B` bytes, not the literal `\e[...]` form fixtures
 * use. `./golden.ts` performs literal → byte decoding on the fixture side
 * so comparison happens in a single canonical form. See
 * `docs/golden-maintenance.md` for the full rationale.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";

const runtimeProcess = (
  globalThis as unknown as {
    process: {
      env: Record<string, string | undefined>;
      execPath: string;
      platform: string;
    };
  }
).process;

export type PtyScenario = {
  name: string;
  input: string[];
  env?: Record<string, string>;
  /**
   * Optional normalizer applied to the captured byte stream before diff.
   * Scenario-specific normalisers (stripping terminal-type echo, etc.)
   * live here; generic ones (timestamps, IDs, ANSI) live in `./golden.ts`.
   */
  normalize?: (text: string) => string;
};

export type PtyRunResult =
  | { status: "ok"; bytes: string; exitCode: number | null }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

export type RunUnderPtyOptions = {
  cwd?: string;
  timeoutMs?: number;
  columns?: number;
  rows?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const SCRIPT_CANDIDATES = ["/usr/bin/script", "/bin/script", "/usr/local/bin/script"];

export const findScriptBinary = async (): Promise<string | null> => {
  for (const candidate of SCRIPT_CANDIDATES) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep walking
    }
  }
  return null;
};

/**
 * Spawn the configured command under a PTY and return the captured bytes.
 *
 * Linux util-linux form:  `script -q -c '<cmd>' /dev/null`
 * BSD / macOS form:       `script -q /dev/null sh -c '<cmd>'`
 */
export const runUnderPty = async (
  scenario: PtyScenario,
  options: RunUnderPtyOptions = {},
): Promise<PtyRunResult> => {
  const scriptBin = await findScriptBinary();
  if (scriptBin === null) {
    return {
      status: "skipped",
      reason: "script(1) binary not found — PTY allocation unavailable",
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cols = options.columns ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;

  const innerCmd = [runtimeProcess.execPath, ...scenario.input]
    .map((token) => shellQuote(token))
    .join(" ");

  const scriptArgs = buildScriptArgs(runtimeProcess.platform, innerCmd);

  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeProcess.env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }
  mergedEnv.TERM = mergedEnv.TERM ?? "xterm-256color";
  mergedEnv.LINES = String(rows);
  mergedEnv.COLUMNS = String(cols);
  for (const [key, value] of Object.entries(scenario.env ?? {})) {
    mergedEnv[key] = value;
  }

  return new Promise<PtyRunResult>((resolve) => {
    const child = spawn(scriptBin, scriptArgs, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: PtyRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ status: "error", reason: `PTY child exceeded timeout of ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", (err: Error) => {
      finish({ status: "error", reason: err.message });
    });

    child.on("close", (code: number | null) => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const stripped = stripScriptPreamble(raw);
      const bytes = scenario.normalize ? scenario.normalize(stripped) : stripped;
      finish({ status: "ok", bytes, exitCode: code });
    });
  });
};

const buildScriptArgs = (platform: string, innerCmd: string): string[] => {
  if (platform === "darwin" || platform === "freebsd") {
    return ["-q", "/dev/null", "sh", "-c", innerCmd];
  }
  return ["-q", "-c", innerCmd, "/dev/null"];
};

export const shellQuote = (token: string): string => {
  if (token.length > 0 && /^[A-Za-z0-9_\-/.=:@,]+$/u.test(token)) {
    return token;
  }
  return `'${token.replace(/'/gu, "'\\''")}'`;
};

/**
 * `script -q` can still emit a banner on some distributions (util-linux
 * 2.38 prints `Script started, file is /dev/null\r\n`). Strip any such
 * prefix / trailer so the captured byte stream represents only what the
 * child itself produced.
 */
export const stripScriptPreamble = (raw: string): string => {
  const withoutHead = raw.replace(/^Script started[^\n]*\r?\n/u, "");
  return withoutHead.replace(/\r?\nScript done[^\n]*\r?\n?$/u, "");
};
