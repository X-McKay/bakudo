import {
  buildJsonErrorEnvelope as buildJsonErrorEnvelopeBase,
  type BakudoErrorCode,
  type JsonErrorEnvelope,
} from "../errors.js";
import type { SessionEventEnvelope } from "../../protocol.js";
import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";

/**
 * Phase 6 W9: all error codes are drawn from the taxonomy in `../errors.ts`.
 * Re-exported here so existing callers (`oneShotRun`, `printers`, tests) can
 * keep importing `JsonErrorCode`/`JsonErrorEnvelope` from this module without
 * a churn-only rewrite; the authoritative type is {@link BakudoErrorCode}.
 */
export type JsonErrorCode = BakudoErrorCode;

export type { JsonErrorEnvelope };

/**
 * Builder for {@link JsonErrorEnvelope}. Re-exported so tests and the
 * one-shot dispatch path share the same shape without import cycles through
 * the JsonBackend instance. Delegates to the canonical builder in
 * `../errors.ts`.
 */
export const buildJsonErrorEnvelope = (input: {
  code: JsonErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
}): JsonErrorEnvelope => buildJsonErrorEnvelopeBase(input);

/**
 * JSON backend for the RendererBackend interface. Unlike the TTY/plain
 * backends, this does NOT serialize the render frame — frames carry overlay
 * state, scroll offsets, and composer hints that are meaningless to
 * automation consumers.
 *
 * Instead, JsonBackend acts as an out-of-band sink for two event channels:
 *
 *  1. `emitJsonEnvelope(envelope)` — writes one JSONL line per
 *     {@link SessionEventEnvelope}. The session controller tees writes
 *     through here when `--output-format=json` is active (Phase 5 PR3).
 *  2. `emitJsonError(code, message, details?)` — writes a single terminal
 *     error line when dispatch fails. Shape follows
 *     {@link JsonErrorEnvelope}: `{ok:false, kind:"error", error:{...}}`.
 *
 * Phase 6 W9 hard rule: the envelope is the single source of truth for
 * `{kind:"error"}` oneShot emissions. Every dispatch-failure code path
 * funnels through `emitJsonError` (or the pure `buildJsonErrorEnvelope`),
 * which in turn delegates to the taxonomy in `../errors.ts`.
 *
 * Hard rule (see `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md`
 * lines 214-215): JsonBackend MUST NOT depend on TTY, Ink, ANSI, or terminal
 * width. Pure string → stdout, per the non-TTY parity matrix.
 *
 * `render(frame)` is intentionally a no-op so that the renderer-factory
 * contract is still satisfied when a `--json` invocation accidentally routes
 * through the interactive render loop. Production uses
 * `emitJsonEnvelope`/`emitJsonError` directly.
 */
export class JsonBackend implements RendererBackend {
  readonly #stdout: RendererStdout;

  constructor(stdout: RendererStdout) {
    this.#stdout = stdout;
  }

  /**
   * Intentional no-op. The JSON output contract is event-driven
   * (`emitJsonEnvelope` / `emitJsonError`), not frame-driven. Render frames
   * contain TTY-oriented state (overlays, scroll offsets) that carries no
   * signal for automation consumers. The `_frame` prefix silences the
   * unused-arg lint while keeping the RendererBackend structural contract.
   */
  render(_frame: RenderFrame): void {
    // no-op by contract; see class docstring.
  }

  /**
   * Write one JSONL line for a session event envelope. Callers are typically
   * the session controller's event log writer (teed through here) or the
   * one-shot dispatch path when it finalizes.
   */
  emitJsonEnvelope(envelope: SessionEventEnvelope): void {
    void this.#stdout.write(`${JSON.stringify(envelope)}\n`);
  }

  /**
   * Write one JSONL error envelope. Used on dispatch failures so `jq`-pipe
   * consumers of `--output-format=json` can discriminate a failed run from
   * a normal terminal `review_completed` line. Delegates to the W9 builder
   * in `../errors.ts`.
   */
  emitJsonError(input: {
    code: JsonErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  }): void {
    void this.#stdout.write(`${JSON.stringify(buildJsonErrorEnvelope(input))}\n`);
  }
}
