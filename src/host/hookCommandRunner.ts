import { spawn, type ChildProcess } from "node:child_process";

import { z } from "zod";

import type { SessionEventEnvelope } from "../protocol.js";
import { PolicyDeniedError } from "./errors.js";

/**
 * Wave 6c PR9 — user-configurable command hooks (plan 06 lines 740–764).
 *
 * Rules (each has a 1:1 test in `tests/unit/hookCommandRunner.test.ts`):
 *  1. Envelope on stdin as JSON.
 *  2. HookResponse JSON on stdout: `{ action, reason? }`.
 *  3. `permissionRequest` may return approve/deny; others continue/block only.
 *  4. Block / deny / invalid → PolicyDeniedError with `hook: <name>` in details.
 *  5. 10 s hard timeout; non-zero exit treated as block.
 *
 * Coexists with the in-process {@link import("./hooks.js").dispatchHook}
 * pipeline — that one is for internal handlers (W2 recovery, W4 approval
 * producer); this one is for user-configured spawn hooks from the config
 * cascade.
 */

/** User-facing hook event names (plan lines 749–753). */
export type CommandHookEventKind =
  | "sessionStart"
  | "preToolUse"
  | "postToolUse"
  | "permissionRequest"
  | "sessionEnd";

export const COMMAND_HOOK_EVENT_KINDS: readonly CommandHookEventKind[] = [
  "sessionStart",
  "preToolUse",
  "postToolUse",
  "permissionRequest",
  "sessionEnd",
];

/** Shape of a single hook entry in the config cascade. */
export type CommandHookEntry = { type: "command"; command: string };

/**
 * Per-event list of configured hook commands. Arrays run sequentially; the
 * first non-`continue` / non-`approve` action short-circuits.
 */
export type CommandHooksConfig = Partial<Record<CommandHookEventKind, readonly CommandHookEntry[]>>;

/**
 * {@link HookResponse} contract (plan line 761). The `action` enum is
 * permissive at parse time — per-kind restriction is enforced by
 * {@link enforceHookActionMatrix}.
 */
export const HookResponseSchema = z
  .object({
    action: z.enum(["continue", "block", "approve", "deny"]),
    reason: z.string().optional(),
  })
  .strip();

export type HookResponse = z.infer<typeof HookResponseSchema>;

/** Default 10 s timeout (plan line 764). */
const COMMAND_HOOK_DEFAULT_TIMEOUT_MS = 10_000;

/** Rule 3: `permissionRequest` permits all four actions; others continue/block only. */
const isActionAllowedForKind = (
  kind: CommandHookEventKind,
  action: HookResponse["action"],
): boolean => (kind === "permissionRequest" ? true : action === "continue" || action === "block");

type BlockCause =
  | "block"
  | "deny"
  | "exit_nonzero"
  | "timeout"
  | "spawn_error"
  | "invalid_response";

/**
 * Throw a {@link PolicyDeniedError} carrying the hook name in `details` per
 * rule 4 (plan line 763). Callers at the dispatch seam catch this the same
 * way they catch any other policy-denied error — the error taxonomy handles
 * the exit code (3) and the JSON envelope.
 */
const throwHookBlock = (args: {
  kind: CommandHookEventKind;
  command: string;
  reason: string;
  cause: BlockCause;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}): never => {
  const details: Record<string, unknown> = {
    hook: args.kind,
    hookCommand: args.command,
    reason: args.reason,
    cause: args.cause,
  };
  if (args.exitCode !== undefined) {
    details.exitCode = args.exitCode;
  }
  if (args.signal !== undefined && args.signal !== null) {
    details.signal = args.signal;
  }
  throw new PolicyDeniedError(`Hook "${args.kind}" blocked: ${args.reason}`, { details });
};

/**
 * Enforce the per-kind action matrix (rule 3) and translate `block` / `deny`
 * into a thrown {@link PolicyDeniedError} (rule 4). Returns the response
 * untouched when the action is allowed to proceed — that is, `continue`, or
 * `approve` on `permissionRequest`.
 */
const enforceHookActionMatrix = (
  kind: CommandHookEventKind,
  command: string,
  response: HookResponse,
): HookResponse => {
  if (!isActionAllowedForKind(kind, response.action)) {
    // Disallowed action for this kind is itself a block per rule 3.
    throwHookBlock({
      kind,
      command,
      reason: `hook returned "${response.action}" but only "continue" / "block" are allowed for "${kind}"`,
      cause: "invalid_response",
    });
  }
  if (response.action === "block" || response.action === "deny") {
    throwHookBlock({
      kind,
      command,
      reason: response.reason ?? response.action,
      cause: response.action === "deny" ? "deny" : "block",
    });
  }
  return response;
};

/**
 * Injection point — the real call uses `node:child_process.spawn`; tests
 * hand in a stub that returns a controllable {@link ChildProcess}-ish
 * object.
 */
export type CommandHookSpawnFn = (command: string) => ChildProcess;

const defaultSpawn: CommandHookSpawnFn = (command) =>
  spawn(command, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

export type RunCommandHookOptions = {
  /** Per-hook timeout override. Default 10 000 ms per plan line 764. */
  timeoutMs?: number;
  /** Override the spawn function (used by tests). */
  spawnFn?: CommandHookSpawnFn;
};

/**
 * Read all data from a readable stream into a UTF-8 string. Mirrors the
 * simple pattern used elsewhere in the host; swallows encoding on a stream
 * that emits raw buffers.
 */
const drainStream = (stream: NodeJS.ReadableStream | null | undefined): Promise<string> =>
  new Promise<string>((resolve) => {
    if (stream === null || stream === undefined) {
      resolve("");
      return;
    }
    const chunks: string[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(chunks.join(""));
    };
    // `data` handles both Readable and EventEmitter-like streams; `end` and
    // `close` cover normal EOF and destroy-path termination respectively.
    // Using event listeners (not for-await) avoids leaving pending async
    // iterators behind if the stream is destroyed mid-flight.
    stream.on("data", (chunk: unknown) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "",
      );
    });
    stream.on("end", finish);
    stream.on("close", finish);
    // An `error` after destroy() is expected on the timeout path — treat as
    // EOF so drain resolves cleanly.
    stream.on("error", finish);
  });

/**
 * Spawn a single configured hook command, feed it the envelope on stdin as
 * JSON, and parse its stdout as a {@link HookResponse}. Enforces rule 1
 * (envelope on stdin), rule 2 (JSON response), rule 5 (timeout), rule 6
 * (non-zero exit → block). Rule 3 + 4 are enforced by
 * {@link enforceHookActionMatrix} at the caller.
 *
 * Timeout semantics: at expiry the child is `SIGKILL`-ed and the function
 * throws a {@link PolicyDeniedError} — a stalled hook MUST NOT wedge
 * dispatch.
 */
const spawnSingleCommandHook = async (args: {
  kind: CommandHookEventKind;
  entry: CommandHookEntry;
  envelope: SessionEventEnvelope;
  options: RunCommandHookOptions;
}): Promise<HookResponse> => {
  const { kind, entry, envelope, options } = args;
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? COMMAND_HOOK_DEFAULT_TIMEOUT_MS;

  let child: ChildProcess;
  try {
    child = spawnFn(entry.command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return throwHookBlock({
      kind,
      command: entry.command,
      reason: `failed to spawn hook: ${message}`,
      cause: "spawn_error",
    });
  }

  // Rule 1 — write the envelope on stdin. Stdin errors (closed pipe) are
  // tolerated; the hook either reads the bytes before exit or exits with a
  // non-zero code which we handle below.
  const stdin = child.stdin;
  if (stdin !== null && stdin !== undefined) {
    // Swallow EPIPE on a hook that closes stdin before we write. Without this
    // listener Node would upgrade EPIPE to an unhandled `error` event on the
    // child and wedge the test harness.
    stdin.once("error", () => {
      /* hook closed stdin early — non-zero exit path will report it */
    });
    try {
      stdin.write(`${JSON.stringify(envelope)}\n`);
      stdin.end();
    } catch {
      /* swallow — the hook will exit without reading and we'll surface non-zero */
    }
  }

  const stdoutPromise = drainStream(child.stdout);
  const stderrPromise = drainStream(child.stderr);

  // Single settle promise — race winner sets the result. Using one promise
  // (instead of Promise.race over two) means no leaked pending promise after
  // timeout wins.
  type ExitOrTimeout = { code: number | null; signal: NodeJS.Signals | null } | "timeout";
  let resolveExit: (value: ExitOrTimeout) => void = () => undefined;
  const settled = new Promise<ExitOrTimeout>((resolve) => {
    resolveExit = resolve;
  });
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    resolveExit({ code, signal });
  };
  const onError = (): void => resolveExit({ code: 1, signal: null });
  child.once("close", onClose);
  child.once("error", onError);

  const handle = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* best-effort */
    }
    // Destroy the streams so any outstanding `drainStream` listeners
    // terminate — otherwise the throw below leaves them pending.
    try {
      (child.stdout as { destroy?: () => void } | null)?.destroy?.();
    } catch {
      /* best-effort */
    }
    try {
      (child.stderr as { destroy?: () => void } | null)?.destroy?.();
    } catch {
      /* best-effort */
    }
    resolveExit("timeout");
  }, timeoutMs);

  const raced = await settled;
  clearTimeout(handle);
  child.off("close", onClose);
  child.off("error", onError);
  if (raced === "timeout") {
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    return throwHookBlock({
      kind,
      command: entry.command,
      reason: `hook timed out after ${timeoutMs}ms`,
      cause: "timeout",
    });
  }

  // Await the stream drains — they MUST complete to avoid a data race on the
  // parse below. Drain errors (pipe closed before read) resolve to "".
  const [stdoutText] = await Promise.all([stdoutPromise, stderrPromise]);
  const { code, signal } = raced;
  if (code !== 0) {
    // Rule 6 — non-zero exit is a block.
    return throwHookBlock({
      kind,
      command: entry.command,
      reason: `hook exited with code ${code ?? "null"}${signal !== null ? ` (signal ${signal})` : ""}`,
      cause: "exit_nonzero",
      exitCode: code,
      signal,
    });
  }

  // Rule 2 — parse stdout as JSON HookResponse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutText.trim().length > 0 ? stdoutText : "{}");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return throwHookBlock({
      kind,
      command: entry.command,
      reason: `hook stdout is not JSON: ${message}`,
      cause: "invalid_response",
    });
  }
  const validated = HookResponseSchema.safeParse(parsed);
  if (!validated.success) {
    return throwHookBlock({
      kind,
      command: entry.command,
      reason: `hook response failed validation: ${validated.error.message}`,
      cause: "invalid_response",
    });
  }
  return validated.data;
};

/**
 * Outcome returned by {@link runConfiguredCommandHooks} when no hook blocks
 * dispatch. `action` is the last handler's action (`continue`, or `approve`
 * on `permissionRequest`); `reason` echoes it for audit.
 */
export type CommandHookOutcome = {
  action: "continue" | "approve";
  reason?: string;
  /** Count of hook commands actually executed. */
  handlersRun: number;
};

/**
 * Run all configured command hooks for `kind` sequentially. Returns normally
 * when every hook returns `continue` (or `approve` on `permissionRequest`).
 * Throws {@link PolicyDeniedError} at the first `block` / `deny` / non-zero
 * exit / timeout / malformed response, per plan rules 1–6 (lines 759–764).
 *
 * When no hooks are configured for `kind`, returns
 * `{ action: "continue", handlersRun: 0 }` without spawning anything.
 */
export const runConfiguredCommandHooks = async (
  kind: CommandHookEventKind,
  envelope: SessionEventEnvelope,
  hooksConfig: CommandHooksConfig | undefined,
  options: RunCommandHookOptions = {},
): Promise<CommandHookOutcome> => {
  const entries = hooksConfig?.[kind];
  if (entries === undefined || entries.length === 0) {
    return { action: "continue", handlersRun: 0 };
  }

  let lastResponse: HookResponse = { action: "continue" };
  let handlersRun = 0;
  for (const entry of entries) {
    const response = await spawnSingleCommandHook({ kind, entry, envelope, options });
    handlersRun += 1;
    // enforceHookActionMatrix throws on block/deny/invalid-for-kind.
    const enforced = enforceHookActionMatrix(kind, entry.command, response);
    lastResponse = enforced;
    // `approve` on permissionRequest is a terminal-accept — downstream does
    // not need to consult later hooks; emit and short-circuit.
    if (enforced.action === "approve") {
      break;
    }
  }

  const outcome: CommandHookOutcome = {
    action: lastResponse.action === "approve" ? "approve" : "continue",
    handlersRun,
  };
  if (lastResponse.reason !== undefined) {
    outcome.reason = lastResponse.reason;
  }
  return outcome;
};
