import { classifyError, renderErrorPlain, type RenderedError } from "../errors.js";
import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";
import { renderTranscriptFramePlain } from "./plainRenderer.js";

/**
 * Non-TTY backend for pipes, log capture, and `--plain`. Wraps
 * {@link renderTranscriptFramePlain} (ANSI-free by construction) and writes a
 * bare newline after each frame so consecutive frames are separated in
 * streaming output without the `\x1Bc` clear that would corrupt piped logs.
 *
 * Phase 6 W9: also renders {@link RenderedError} records via
 * {@link renderError}. The plain-text error shape matches the hard rule
 * (same class → same exit code → same JSON shape → same plain text):
 *
 *   Error [<code>]: <message>
 *   Hint: <recoveryHint>
 */
export class PlainBackend implements RendererBackend {
  readonly #stdout: RendererStdout;

  constructor(stdout: RendererStdout) {
    this.#stdout = stdout;
  }

  render(frame: RenderFrame): void {
    const lines = renderTranscriptFramePlain(frame);
    void this.#stdout.write(`${lines.join("\n")}\n`);
  }

  /**
   * Render a classified error as ANSI-free plain text. Accepts either a
   * pre-classified {@link RenderedError} (e.g. from a `BakudoError.toRendered()`
   * call) or any thrown value — the backend will run it through
   * {@link classifyError} first so call sites can be terse.
   */
  renderError(error: RenderedError | unknown): void {
    const rendered: RenderedError =
      typeof error === "object" &&
      error !== null &&
      "class" in error &&
      "code" in error &&
      "exitCode" in error
        ? (error as RenderedError)
        : classifyError(error);
    void this.#stdout.write(`${renderErrorPlain(rendered)}\n`);
  }
}
