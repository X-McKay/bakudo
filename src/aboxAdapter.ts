import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { ToolResult } from "./models.js";

const execFileAsync = promisify(execFile);
type ExecFileFn = typeof execFileAsync;
type SpawnFn = typeof spawn;

export type StreamHandlers = {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

/**
 * Phase 6 W5 — explicit env override for a single spawn. When `undefined`
 * the adapter inherits the parent process env (the pre-W5 behavior). The
 * {@link import("./aboxTaskRunner.js").ABoxTaskRunner} passes the
 * env-allowlist-filtered map here so nothing leaks beyond what the user
 * opted in to.
 */
export type SpawnEnv = Readonly<Record<string, string>> | undefined;

export class ABoxAdapter {
  private sequence = 0;

  public constructor(
    private readonly aboxBin: string = "abox",
    private readonly repoPath?: string,
    private readonly execFn: ExecFileFn = execFileAsync,
    private readonly spawnFn: SpawnFn = spawn,
  ) {}

  /**
   * Resolved binary path (or bin name) used to invoke abox. Phase 6 W3
   * uses this as the cache key for the worker capability probe so two
   * adapters pointing at the same binary share one probe.
   */
  public get binPath(): string {
    return this.aboxBin;
  }

  public async runInStream(
    streamId: string,
    command: string,
    timeoutSeconds = 120,
  ): Promise<ToolResult> {
    const { taskId, cmd } = this.buildInvocation(streamId, command);
    try {
      const { stdout, stderr } = await this.execFn(this.aboxBin, cmd, {
        timeout: timeoutSeconds * 1000,
        windowsHide: true,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      return {
        ok: true,
        output,
        metadata: { errorType: "ok", cmd: [this.aboxBin, ...cmd], taskId },
      };
    } catch (error) {
      const err = error as {
        code?: string | number;
        stdout?: string;
        stderr?: string;
        signal?: string;
        message?: string;
      };
      const output = [err.stdout ?? "", err.stderr ?? "", err.message ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim();
      const timeout = err.code === "ETIMEDOUT";
      return {
        ok: false,
        output: timeout ? `timeout: ${output}` : output,
        metadata: {
          errorType: timeout ? "timeout" : "nonzero_exit",
          code: String(err.code ?? "unknown"),
          signal: err.signal ?? "",
          cmd: [this.aboxBin, ...cmd],
          taskId,
        },
      };
    }
  }

  public async runInStreamLive(
    streamId: string,
    command: string,
    timeoutSeconds = 120,
    handlers: StreamHandlers = {},
    env?: SpawnEnv,
  ): Promise<ToolResult> {
    const { taskId, cmd } = this.buildInvocation(streamId, command);
    const spawnEnv = this.resolveSpawnEnv(env);
    // Phase 6 W5 — when `env` is supplied, we pass ONLY those vars (plus the
    // ephemeral-opt-out signal the adapter inspects below); without `env` we
    // inherit the parent process env (pre-W5 behaviour). The `ABoxTaskRunner`
    // always supplies a filtered map so nothing leaks from the host to the
    // worker unless explicitly allowlisted.
    const spawnOptions: Parameters<SpawnFn>[2] = {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(spawnEnv === undefined ? {} : { env: spawnEnv }),
    };
    const child = this.spawnFn(this.aboxBin, cmd, spawnOptions);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 1000).unref?.();
    }, timeoutSeconds * 1000);
    timeoutHandle.unref?.();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdoutChunks.push(text);
      handlers.onStdout?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrChunks.push(text);
      handlers.onStderr?.(text);
    });

    return new Promise<ToolResult>((resolve) => {
      child.once("error", (error) => {
        clearTimeout(timeoutHandle);
        const message = error instanceof Error ? error.message : String(error);
        const output = [...stdoutChunks, ...stderrChunks, message].filter(Boolean).join("").trim();
        resolve({
          ok: false,
          output: timedOut ? `timeout: ${output}` : output,
          metadata: {
            errorType: timedOut ? "timeout" : "spawn_error",
            code: "spawn_error",
            signal: "",
            cmd: [this.aboxBin, ...cmd],
            taskId,
          },
        });
      });

      child.once("close", (code, signal) => {
        clearTimeout(timeoutHandle);
        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("");
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        const ok = !timedOut && code === 0;
        resolve({
          ok,
          output: timedOut ? `timeout: ${output}` : output,
          metadata: {
            errorType: ok ? "ok" : timedOut ? "timeout" : "nonzero_exit",
            code: String(code ?? "unknown"),
            signal: signal ?? "",
            cmd: [this.aboxBin, ...cmd],
            taskId,
          },
        });
      });
    });
  }

  private buildInvocation(streamId: string, command: string): { taskId: string; cmd: string[] } {
    const taskId = this.nextTaskId(streamId);
    const ephemeral = process.env.BAKUDO_EPHEMERAL !== "0";
    const cmd = [
      ...(this.repoPath ? ["--repo", this.repoPath] : []),
      "run",
      "--task",
      taskId,
      ...(ephemeral ? ["--ephemeral"] : []),
      "--",
      "bash",
      "-lc",
      command,
    ];
    return { taskId, cmd };
  }

  private resolveSpawnEnv(env: SpawnEnv): Record<string, string> | undefined {
    if (env === undefined) return undefined;

    const spawnEnv = { ...env };
    // F-04: bare command names require the host PATH for binary resolution.
    // This PATH is only for the host-side abox spawn, not worker env policy.
    if (!/[\\/]/u.test(this.aboxBin) && process.env.PATH !== undefined) {
      spawnEnv.PATH = process.env.PATH;
    }
    return spawnEnv;
  }

  private nextTaskId(streamId: string): string {
    this.sequence += 1;
    const sanitized = streamId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const prefix = sanitized.length > 0 ? sanitized : "stream";
    return `bakudo-${prefix}-${this.sequence}`;
  }
}
