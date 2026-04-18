import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";

/**
 * JSON backend STUB for the RendererBackend interface. Writes a single-line
 * JSON envelope per frame of the form `{ "kind": "frame", "frame": {...} }`
 * followed by a newline (JSONL).
 *
 * TODO(phase5-pr3): PR3 wires this fully and replaces the `{kind:"frame"}`
 * placeholder with richer per-kind event serialization that mirrors
 * `SessionEventEnvelope` conventions. This PR2 stub exists only to satisfy
 * the backend-selection factory and its tests — it is NOT yet plumbed into
 * `hostCli.ts`'s `--json` flag dispatch.
 *
 * @deprecated Use only via {@link selectRendererBackend}; will be expanded in PR3.
 */
export class JsonBackend implements RendererBackend {
  readonly #stdout: RendererStdout;

  constructor(stdout: RendererStdout) {
    this.#stdout = stdout;
  }

  render(frame: RenderFrame): void {
    // TODO(phase5-pr3): richer per-kind event serialization.
    const envelope = JSON.stringify({ kind: "frame", frame });
    void this.#stdout.write(`${envelope}\n`);
  }
}
