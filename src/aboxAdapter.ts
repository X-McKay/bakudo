import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ToolResult } from "./models.js";

const execFileAsync = promisify(execFile);
type ExecFileFn = typeof execFileAsync;

export class ABoxAdapter {
  private sequence = 0;

  public constructor(
    private readonly aboxBin: string = "abox",
    private readonly repoPath?: string,
    private readonly execFn: ExecFileFn = execFileAsync,
  ) {}

  public async runInStream(
    streamId: string,
    command: string,
    timeoutSeconds = 120,
  ): Promise<ToolResult> {
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

  private nextTaskId(streamId: string): string {
    this.sequence += 1;
    const sanitized = streamId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const prefix = sanitized.length > 0 ? sanitized : "stream";
    return `bakudo-${prefix}-${this.sequence}`;
  }
}
