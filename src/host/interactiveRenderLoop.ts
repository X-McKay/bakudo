import { supportsAnsi } from "./ansi.js";
import type { ComposerMode, HostAppState } from "./appState.js";
import { getBaseStdout, stderrWrite, withCapturedStdout } from "./io.js";
import type { HostCliArgs } from "./parsing.js";
import { reduceHost } from "./reducer.js";
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
  lastTaskId?: string;
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
    ctx.lastTaskId = state.activeTurnId;
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
};

const renderFrameLines = (state: HostAppState, transcript: TranscriptItem[]): string[] => {
  const frame = selectRenderFrame({ state, transcript });
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
  writeFrame(renderFrameLines(deps.appState, deps.transcript));
};

export const handleControlCommand = (line: string, deps: TickDeps): boolean => {
  if (line === "/help") {
    deps.transcript.push({
      kind: "event",
      label: "help",
      detail: "type a goal or /build, /plan, /status, /exit",
    });
    return true;
  }
  if (line === "/clear") {
    deps.transcript.length = 0;
    return true;
  }
  if (line.startsWith("/mode ")) {
    const nextMode = line.slice("/mode ".length).trim();
    if (nextMode !== "standard" && nextMode !== "plan" && nextMode !== "autopilot") {
      stderrWrite("interactive_error: mode must be standard, plan, or autopilot\n");
      return true;
    }
    deps.appState = reduceHost(deps.appState, { type: "set_mode", mode: nextMode });
    deps.transcript.push({ kind: "event", label: "mode", detail: nextMode });
    return true;
  }
  if (line.startsWith("/approve ")) {
    const policy = line.slice("/approve ".length).trim();
    if (policy !== "auto" && policy !== "prompt") {
      stderrWrite("interactive_error: approve must be auto or prompt\n");
      return true;
    }
    // approve policy is now derived from composer mode (autopilot). We still
    // accept the legacy /approve command and map it to /mode autopilot / standard.
    deps.appState = reduceHost(deps.appState, {
      type: "set_mode",
      mode: policy === "auto" ? "autopilot" : "standard",
    });
    deps.transcript.push({ kind: "event", label: "approve", detail: policy });
    return true;
  }
  return false;
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

    if (isExec) {
      deps.transcript.push({
        kind: "assistant",
        text: "Dispatching sandbox attempt.",
        tone: "info",
      });
    }

    const capture = createSilentCapture();
    const code = await withCapturedStdout(capture.writer, async () => exec.dispatch(parsed));
    capture.flush();

    if (isExec) {
      deps.transcript.push({
        kind: "assistant",
        text: code === 0 ? "Worker completed." : "Worker completed with errors.",
        tone: code === 0 ? "info" : "error",
      });
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
