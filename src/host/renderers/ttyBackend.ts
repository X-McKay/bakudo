import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";
import { renderTranscriptFrame } from "./transcriptRenderer.js";

/**
 * ANSI-aware backend for interactive terminals. Wraps {@link renderTranscriptFrame}
 * and writes its output to stdout.
 *
 * Phase 5 PR5 scope: alt-screen entry/exit and cursor show/hide land here.
 * Each tick uses the targeted cursor-home + clear-screen (`\x1B[H\x1B[2J`)
 * sequence rather than the older per-render `\x1Bc` so the alt-screen buffer
 * stays coherent across redraws.
 *
 * Lifecycle:
 *  - Construction (or first `render()`): emit enter-alt-screen + hide-cursor.
 *  - `dispose()`: emit show-cursor + exit-alt-screen. Idempotent — calling
 *    twice is a no-op on the second call.
 *
 * Raw mode: NOT toggled here. Phase 5 experimented with owning raw-mode
 * lifecycle in this backend, but the interactive shell (`interactive.ts`)
 * still reads input through `readline.question()` — which silently drops
 * line events when stdin is in raw mode. The result was a frozen TUI under
 * the default alt-screen path (only `BAKUDO_NO_ALT_SCREEN=1` worked). Raw
 * mode returns here the day raw-key dispatch replaces readline (phase-5
 * handoff lock-in 11); until then the shell stays cooked.
 *
 * Opt-out: `BAKUDO_NO_ALT_SCREEN=1` forces the backend to skip alt-screen
 * (useful for debugging and for terminals that misbehave under mode 1049).
 * The backend still renders normally; it just doesn't toggle the alt buffer.
 *
 * See `plans/bakudo-ux/phase-5-renderer-decision.md` §4.2.1 and
 * `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md:410-417` (Copilot
 * changelog entries v1.0.8, v1.0.12, v1.0.23, v1.0.24).
 */

export const ENTER_ALT_SCREEN = "\x1B[?1049h";
export const EXIT_ALT_SCREEN = "\x1B[?1049l";
export const HIDE_CURSOR = "\x1B[?25l";
export const SHOW_CURSOR = "\x1B[?25h";
export const CLEAR_TARGETED = "\x1B[H\x1B[2J";

export type TtyBackendStdin = {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  isRaw?: boolean;
};

export type TtyBackendEnv = {
  BAKUDO_NO_ALT_SCREEN?: string | undefined;
  [key: string]: string | undefined;
};

export type TtyBackendOptions = {
  /** Optional stdin handle. If it is a TTY, raw mode is toggled on enter/exit. */
  stdin?: TtyBackendStdin;
  /**
   * Environment lookup. Defaults to `process.env`. Injected for deterministic
   * tests. Only `BAKUDO_NO_ALT_SCREEN` is read currently.
   */
  env?: TtyBackendEnv;
};

const readEnv = (): TtyBackendEnv => {
  const proc = (globalThis as unknown as { process?: { env?: TtyBackendEnv } }).process;
  return proc?.env ?? {};
};

const readStdin = (): TtyBackendStdin | undefined => {
  const proc = (globalThis as unknown as { process?: { stdin?: TtyBackendStdin } }).process;
  return proc?.stdin;
};

export class TtyBackend implements RendererBackend {
  readonly #stdout: RendererStdout;
  readonly #altScreenEnabled: boolean;
  #entered = false;
  #disposed = false;

  constructor(stdout: RendererStdout, options: TtyBackendOptions = {}) {
    this.#stdout = stdout;
    // `options.stdin` / `readStdin()` intentionally ignored: TtyBackend no
    // longer owns raw-mode (see class doc). The field on the options type is
    // kept so tests that want to assert absence can still pass a stub stdin.
    void options.stdin;
    const env = options.env ?? readEnv();
    this.#altScreenEnabled = env.BAKUDO_NO_ALT_SCREEN !== "1";
  }

  render(frame: RenderFrame): void {
    if (this.#disposed) {
      // Defensive: if a caller renders after dispose, fall through to a plain
      // write without re-entering alt-screen. Avoids zombie cursor state.
      const lines = renderTranscriptFrame(frame);
      void this.#stdout.write(`${lines.join("\n")}\n`);
      return;
    }
    this.#enterIfNeeded();
    const lines = renderTranscriptFrame(frame);
    if (this.#altScreenEnabled) {
      void this.#stdout.write(CLEAR_TARGETED);
    } else {
      // Opt-out path still needs a clear so consecutive frames don't stack.
      // Use the same targeted sequence; without alt-screen it still clears
      // visible viewport without wiping scrollback permanently on most emulators.
      void this.#stdout.write(CLEAR_TARGETED);
    }
    void this.#stdout.write(`${lines.join("\n")}\n`);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (!this.#entered) {
      return;
    }
    if (this.#altScreenEnabled) {
      void this.#stdout.write(SHOW_CURSOR);
      void this.#stdout.write(EXIT_ALT_SCREEN);
    } else {
      void this.#stdout.write(SHOW_CURSOR);
    }
  }

  /** Test-only hook: has enter() run? */
  hasEntered(): boolean {
    return this.#entered;
  }

  /** Test-only hook: has dispose() run? */
  isDisposed(): boolean {
    return this.#disposed;
  }

  #enterIfNeeded(): void {
    if (this.#entered) {
      return;
    }
    this.#entered = true;
    if (this.#altScreenEnabled) {
      void this.#stdout.write(ENTER_ALT_SCREEN);
      void this.#stdout.write(HIDE_CURSOR);
    } else {
      // Even in opt-out mode, hide cursor during active rendering — exiting
      // still restores it. This matches Copilot v1.0.24's behavior.
      void this.#stdout.write(HIDE_CURSOR);
    }
  }
}
