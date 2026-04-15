import { supportsAnsi } from "./ansi.js";
import type { HostAppState } from "./appState.js";
import { getBaseStdout, stderrWrite, withCapturedStdout } from "./io.js";
import type { HostCliArgs } from "./parsing.js";
import { reduceHost, type HostAction } from "./reducer.js";
import { selectRenderFrame, type TranscriptItem } from "./renderModel.js";
import { renderTranscriptFramePlain } from "./renderers/plainRenderer.js";
import { renderTranscriptFrame } from "./renderers/transcriptRenderer.js";
import type { TextWriter } from "./io.js";

export type InteractiveShellState = {
  currentMode: "build" | "plan";
  autoApprove: boolean;
  lastSessionId?: string;
  lastTaskId?: string;
};

export type InteractiveResolution = {
  argv: string[];
  sessionId?: string;
  taskId?: string;
};

export type TickDeps = {
  shellState: InteractiveShellState;
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

const reduce = (deps: TickDeps, action: HostAction): void => {
  deps.appState = reduceHost(deps.appState, action);
};

const syncComposerFromShell = (deps: TickDeps): void => {
  // Legacy sync: translate worker TaskMode → ComposerMode. Scheduled for deletion
  // in PR3 commit 4 once appState is the sole source of truth for composer state.
  const composerMode =
    deps.appState.composer.mode !== "standard" || deps.shellState.currentMode === "plan"
      ? deps.shellState.currentMode === "plan"
        ? "plan"
        : deps.appState.composer.mode
      : "standard";
  reduce(deps, { type: "set_mode", mode: composerMode });
  if (deps.shellState.lastSessionId) {
    reduce(deps, {
      type: "set_active_session",
      sessionId: deps.shellState.lastSessionId,
      ...(deps.shellState.lastTaskId ? { turnId: deps.shellState.lastTaskId } : {}),
    });
  }
};

export const tickRender = (deps: TickDeps): void => {
  syncComposerFromShell(deps);
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
    if (nextMode !== "build" && nextMode !== "plan") {
      stderrWrite("interactive_error: mode must be build or plan\n");
      return true;
    }
    deps.shellState.currentMode = nextMode;
    deps.transcript.push({ kind: "event", label: "mode", detail: nextMode });
    return true;
  }
  if (line.startsWith("/approve ")) {
    const policy = line.slice("/approve ".length).trim();
    if (policy !== "auto" && policy !== "prompt") {
      stderrWrite("interactive_error: approve must be auto or prompt\n");
      return true;
    }
    deps.shellState.autoApprove = policy === "auto";
    deps.transcript.push({ kind: "event", label: "approve", detail: policy });
    return true;
  }
  return false;
};

export type ExecuteDeps = {
  resolveInput: (line: string, state: InteractiveShellState) => InteractiveResolution;
  parse: (argv: string[]) => HostCliArgs;
  dispatch: (args: HostCliArgs) => Promise<number>;
  remember: (
    state: InteractiveShellState,
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
    const resolution = exec.resolveInput(line, deps.shellState);
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
      exec.remember(deps.shellState, parsed, resolution);
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
