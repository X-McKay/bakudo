import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../protocol.js";
import type { WorkerTaskProgressEvent } from "../workerRuntime.js";
import { supportsAnsi } from "./ansi.js";
import type { ComposerMode, HostAppState } from "./appState.js";
import type { BakudoConfig } from "./config.js";
import { getBaseStdout, stderrWrite, withCapturedStdout } from "./io.js";
import type { HostCliArgs } from "./parsing.js";
import { createProgressCoalescer } from "./progressCoalescer.js";
import { selectRenderFrame, type TranscriptItem } from "./renderModel.js";
import { renderTranscriptFramePlain } from "./renderers/plainRenderer.js";
import { renderTranscriptFrame } from "./renderers/transcriptRenderer.js";
import type { TextWriter } from "./io.js";

/**
 * Derived read-only view of composer/session state for resolvers.
 * PR2 used a parallel `InteractiveShellState` object; now it is computed
 * from {@link HostAppState} on demand so the reducer is the sole source.
 */
export type ShellContext = {
  currentMode: "build" | "plan";
  autoApprove: boolean;
  lastSessionId?: string;
  /**
   * The most recently active turn identifier (e.g. `turn-1`). This is a
   * *turn* id, not an attempt/task id. Session-scoped commands that require
   * an attempt id (review, sandbox, logs) must NOT auto-fill from this field;
   * they should require the caller to supply an explicit attempt id or look
   * up the latest attempt from the session record.
   */
  lastTurnId?: string;
};

export const deriveShellContext = (state: HostAppState): ShellContext => {
  const composerMode: ComposerMode = state.composer.mode;
  const ctx: ShellContext = {
    currentMode: composerMode === "plan" ? "plan" : "build",
    autoApprove: state.composer.autoApprove,
  };
  if (state.activeSessionId !== undefined) {
    ctx.lastSessionId = state.activeSessionId;
  }
  if (state.activeTurnId !== undefined) {
    ctx.lastTurnId = state.activeTurnId;
  }
  return ctx;
};

export type InteractiveResolution = {
  argv: string[];
  sessionId?: string;
  taskId?: string;
};

export type TickDeps = {
  transcript: TranscriptItem[];
  appState: HostAppState;
  /** Short repo basename displayed in the frame header (PR3 follow-up). */
  repoLabel?: string;
  /** Merged config cascade. Populated by the interactive shell bootstrap. */
  config?: BakudoConfig;
};

const renderFrameLines = (
  state: HostAppState,
  transcript: TranscriptItem[],
  repoLabel?: string,
): string[] => {
  const frame = selectRenderFrame({
    state,
    transcript,
    ...(repoLabel !== undefined ? { repoLabel } : {}),
  });
  return supportsAnsi() ? renderTranscriptFrame(frame) : renderTranscriptFramePlain(frame);
};

const writeFrame = (lines: string[]): void => {
  const output = getBaseStdout();
  if (supportsAnsi()) {
    void output.write("\x1Bc");
  }
  void output.write(`${lines.join("\n")}\n`);
};

const createSilentCapture = (): { writer: TextWriter; lines: string[]; flush: () => void } => {
  const lines: string[] = [];
  let pending = "";
  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    const clean = pending.replace(/\r/g, "").trimEnd();
    pending = "";
    if (clean.length > 0) {
      lines.push(clean);
    }
  };
  return {
    flush,
    lines,
    writer: {
      write: (chunk: string | Uint8Array) => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        pending += text;
        const split = pending.split(/\r?\n/);
        pending = split.pop() ?? "";
        for (const line of split) {
          const clean = line.replace(/\r/g, "").trimEnd();
          if (clean.length > 0) {
            lines.push(clean);
          }
        }
        return true;
      },
    },
  };
};

const exitCodeToReviewItem = (code: number): TranscriptItem => {
  if (code === 0) {
    return {
      kind: "review",
      outcome: "success",
      summary: "task completed",
      nextAction: "inspect",
    };
  }
  if (code === 2) {
    return {
      kind: "review",
      outcome: "blocked_needs_user",
      summary: "task awaiting user input",
      nextAction: "resume",
    };
  }
  return {
    kind: "review",
    outcome: "failed",
    summary: `task exited with code ${code}`,
    nextAction: "inspect",
  };
};

const isExecCommand = (command: string): boolean =>
  command === "run" || command === "build" || command === "plan" || command === "resume";

export const tickRender = (deps: TickDeps): void => {
  writeFrame(renderFrameLines(deps.appState, deps.transcript, deps.repoLabel));
};

export type ExecuteDeps = {
  resolveInput: (line: string, shell: ShellContext) => InteractiveResolution;
  parse: (argv: string[]) => HostCliArgs;
  dispatch: (args: HostCliArgs) => Promise<number>;
  remember: (
    state: { appState: HostAppState },
    args: HostCliArgs,
    resolution: InteractiveResolution,
  ) => void;
};

const syntheticProgressEvent = (
  sessionId: string,
  taskId: string,
  kind: WorkerTaskProgressEvent["kind"],
  status: WorkerTaskProgressEvent["status"],
): WorkerTaskProgressEvent => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
  kind,
  taskId,
  sessionId,
  status,
  timestamp: new Date().toISOString(),
});

export const executePrompt = async (
  line: string,
  deps: TickDeps,
  exec: ExecuteDeps,
): Promise<void> => {
  try {
    const shell = deriveShellContext(deps.appState);
    const resolution = exec.resolveInput(line, shell);
    const parsed = exec.parse(resolution.argv);
    const isExec = isExecCommand(parsed.command);
    const sessionId = resolution.sessionId ?? parsed.sessionId ?? "interactive";
    const taskId = resolution.taskId ?? parsed.taskId ?? "task-1";

    const coalesce = createProgressCoalescer((item) => {
      deps.transcript.push(item);
    });

    if (isExec) {
      coalesce(syntheticProgressEvent(sessionId, taskId, "task.queued", "queued"));
    }

    const capture = createSilentCapture();
    const code = await withCapturedStdout(capture.writer, async () => exec.dispatch(parsed));
    capture.flush();

    if (isExec) {
      if (code === 0) {
        coalesce(syntheticProgressEvent(sessionId, taskId, "task.completed", "succeeded"));
      } else {
        coalesce(syntheticProgressEvent(sessionId, taskId, "task.failed", "failed"));
      }
      coalesce.flushNow();
      deps.transcript.push(exitCodeToReviewItem(code));
    } else {
      const recent = capture.lines.slice(-6);
      for (const captured of recent) {
        deps.transcript.push({ kind: "event", label: parsed.command, detail: captured });
      }
    }

    if (code !== 1) {
      exec.remember({ appState: deps.appState }, parsed, resolution);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderrWrite(`interactive_error: ${message}\n`);
    deps.transcript.push({
      kind: "assistant",
      text: `Error: ${message}`,
      tone: "error",
    });
  }
};
