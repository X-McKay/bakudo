import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";
import { renderTranscriptFramePlain } from "./plainRenderer.js";

/**
 * Non-TTY backend for pipes, log capture, and `--plain`. Wraps
 * {@link renderTranscriptFramePlain} (ANSI-free by construction) and writes a
 * bare newline after each frame so consecutive frames are separated in
 * streaming output without the `\x1Bc` clear that would corrupt piped logs.
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
}
