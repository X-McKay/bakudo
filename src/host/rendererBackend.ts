import type { RenderFrame } from "./renderModel.js";
import { JsonBackend } from "./renderers/jsonBackend.js";
import { PlainBackend } from "./renderers/plainBackend.js";
import { TtyBackend } from "./renderers/ttyBackend.js";

/**
 * Framework-agnostic contract for a renderer that consumes {@link RenderFrame}
 * values and writes them to some sink. Phase 5 Workstream 1: this interface
 * is identical under either Option A (stay custom ANSI) or Option B (Ink).
 *
 * Implementations MUST NOT depend on host app state or the reducer directly;
 * the frame is the sole input. See the hard rule at
 * `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md:101-104`.
 */
export type RendererBackend = {
  render(frame: RenderFrame): void;
  /**
   * Release any terminal state held by the backend (alt-screen exit, raw-mode
   * restore, cursor show). Phase 5 PR2 backends do not yet hold any terminal
   * state; alt-screen logic lands in PR5 (`TtyBackend.dispose`).
   */
  dispose?(): void;
};

/**
 * Minimal writable-stream shape the factory needs. We avoid importing
 * `NodeJS.WriteStream` directly so tests can pass a plain object with
 * `{ isTTY, write }` without constructing a real tty.
 */
export type RendererStdout = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

export type SelectRendererBackendArgs = {
  useJson?: boolean;
  forcePlain?: boolean;
  stdout: RendererStdout;
};

/**
 * Pick the appropriate backend for the current invocation. Selection rules:
 *
 * 1. `useJson === true` → {@link JsonBackend} (takes precedence over `forcePlain`
 *    because `--json` is a strictly stronger output contract).
 * 2. `forcePlain === true` OR non-TTY stdout OR `NO_COLOR` set → {@link PlainBackend}.
 * 3. Otherwise → {@link TtyBackend}.
 *
 * The factory is pure: no global `process.stdout` probing beyond `NO_COLOR`.
 * Callers pass the exact stream the chosen backend will write to.
 */
export const selectRendererBackend = (args: SelectRendererBackendArgs): RendererBackend => {
  if (args.useJson === true) {
    return new JsonBackend(args.stdout);
  }
  const noColor =
    (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.NO_COLOR !== undefined;
  if (args.forcePlain === true || args.stdout.isTTY !== true || noColor) {
    return new PlainBackend(args.stdout);
  }
  return new TtyBackend(args.stdout);
};
