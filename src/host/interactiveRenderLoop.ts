import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../protocol.js";
import type { WorkerTaskProgressEvent } from "../workerRuntime.js";
import type { ComposerMode, HostAppState } from "./appState.js";
import type { BakudoConfig } from "./config.js";
import { getBaseStdout, stderrWrite, withCapturedStdout } from "./io.js";
import { getMetricsRecorder } from "./metrics/metricsRecorder.js";
import type { HostCliArgs } from "./parsing.js";
import { createProgressCoalescer } from "./progressCoalescer.js";
import { selectRenderFrame, type TranscriptItem } from "./renderModel.js";
import {
  selectRendererBackend,
  type RendererBackend,
  type RendererStdout,
} from "./rendererBackend.js";
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

const stdoutAsRendererStdout = (): RendererStdout => {
  const output = getBaseStdout() as unknown as RendererStdout;
  return output;
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

/**
 * Factory: build a tick renderer bound to a single {@link RendererBackend}.
 * Call once at the top of the interactive loop, then reuse the returned
 * function for every tick. The backend is chosen by {@link selectRendererBackend}
 * based on the current stdout + optional flag overrides.
 *
 * The non-factory {@link tickRender} below creates a backend per call for
 * backward compatibility with existing callers and to preserve the old
 * per-tick `supportsAnsi()` dispatch behavior (TTY state re-checked each tick).
 */
export const createTickRenderer = (
  options: { useJson?: boolean; forcePlain?: boolean } = {},
): ((deps: TickDeps) => void) => {
  const stdout = stdoutAsRendererStdout();
  const backend = selectRendererBackend({
    stdout,
    ...(options.useJson !== undefined ? { useJson: options.useJson } : {}),
    ...(options.forcePlain !== undefined ? { forcePlain: options.forcePlain } : {}),
  });
  return (deps: TickDeps): void => {
    const frame = selectRenderFrame({
      state: deps.appState,
      transcript: deps.transcript,
      ...(deps.repoLabel !== undefined ? { repoLabel: deps.repoLabel } : {}),
    });
    backend.render(frame);
  };
};

export const tickRender = (deps: TickDeps): void => {
  const frame = selectRenderFrame({
    state: deps.appState,
    transcript: deps.transcript,
    ...(deps.repoLabel !== undefined ? { repoLabel: deps.repoLabel } : {}),
  });
  const stdout = stdoutAsRendererStdout();
  const backend = selectRendererBackend({ stdout });
  backend.render(frame);
};

/**
 * Phase 5 PR5 — build a session-scoped renderer pair: a `tick` function that
 * reuses the same backend for every frame, plus the backend itself so the
 * caller can wire `dispose()` into signal handlers.
 *
 * Using this instead of {@link tickRender} guarantees alt-screen enter/exit
 * fires exactly once per interactive session.
 */
export const createSessionRenderer = (): {
  tick: (deps: TickDeps) => void;
  backend: RendererBackend;
} => {
  const stdout = stdoutAsRendererStdout();
  const backend = selectRendererBackend({ stdout });
  // Wave 6d PR11 review blocker B2: the first paint of the session renderer
  // is the plan's "time-to-first-render" hook point (plan 06 line 437). On
  // the first tick we close the `shell.startup_begin` → `shell.startup_done`
  // pair bootstrap opens at `initHost`, so `bakudo metrics` surfaces real
  // shell-startup latency in the wild instead of always zero.
  let firstPaintRecorded = false;
  const tick = (deps: TickDeps): void => {
    const frame = selectRenderFrame({
      state: deps.appState,
      transcript: deps.transcript,
      ...(deps.repoLabel !== undefined ? { repoLabel: deps.repoLabel } : {}),
    });
    backend.render(frame);
    if (!firstPaintRecorded) {
      firstPaintRecorded = true;
      const recorder = getMetricsRecorder();
      recorder.mark("shell.startup_done");
      recorder.measureBetween("shell.startup_ms", "shell.startup_begin", "shell.startup_done");
    }
  };
  return { tick, backend };
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
      if (capture.lines.length > 0) {
        deps.transcript.push({ kind: "output", text: capture.lines.join("\n") });
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
