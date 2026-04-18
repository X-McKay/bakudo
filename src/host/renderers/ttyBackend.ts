import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";
import { renderTranscriptFrame } from "./transcriptRenderer.js";

/**
 * ANSI-aware backend for interactive terminals. Wraps {@link renderTranscriptFrame}
 * and writes its output to stdout, prefixed with a full-screen clear
 * (`\x1Bc`) so each frame reprint is a clean slate.
 *
 * Phase 5 PR2 scope: clear + write only. Alt-screen entry/exit, signal-handler
 * wiring, and raw-mode toggling are deliberately deferred to PR5 — see
 * `plans/bakudo-ux/phase-5-renderer-decision.md` section 4.2.1.
 */
export class TtyBackend implements RendererBackend {
  readonly #stdout: RendererStdout;

  constructor(stdout: RendererStdout) {
    this.#stdout = stdout;
  }

  render(frame: RenderFrame): void {
    const lines = renderTranscriptFrame(frame);
    void this.#stdout.write("\x1Bc");
    void this.#stdout.write(`${lines.join("\n")}\n`);
  }
}
