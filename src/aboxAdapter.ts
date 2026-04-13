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

export class ABoxAdapter {
  private sequence = 0;

  public constructor(
    private readonly aboxBin: string = "abox",
    private readonly repoPath?: string,
    private readonly execFn: ExecFileFn = execFileAsync,
    private readonly spawnFn: SpawnFn = spawn,
  ) {}

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
  ): Promise<ToolResult> {
    const { taskId, cmd } = this.buildInvocation(streamId, command);
    const child = this.spawnFn(this.aboxBin, cmd, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
    const cmd = [
      ...(this.repoPath ? ["--repo", this.repoPath] : []),
      "run",
      "--task",
      taskId,
      "--ephemeral",
      "--",
      "bash",
      "-lc",
      command,
    ];
    return { taskId, cmd };
  }

  private nextTaskId(streamId: string): string {
    this.sequence += 1;
    const sanitized = streamId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const prefix = sanitized.length > 0 ? sanitized : "stream";
    return `bakudo-${prefix}-${this.sequence}`;
  }
}
