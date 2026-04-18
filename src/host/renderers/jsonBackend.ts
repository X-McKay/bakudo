import type { SessionEventEnvelope } from "../../protocol.js";
import type { RendererBackend, RendererStdout } from "../rendererBackend.js";
import type { RenderFrame } from "../renderModel.js";

/**
 * Error taxonomy slot codes used by {@link JsonBackend.emitJsonError} when
 * `--output-format=json` is active. The codes are placeholders for the Phase 6
 * error-taxonomy work; they are stable enough for automation callers to match
 * on today and will be refined once the taxonomy lands.
 *
 *  - `user_input` — malformed CLI arguments.
 *  - `approval_denied` — `--no-ask-user` blocked an approval request.
 *  - `policy_denied` — deny-precedence rejected an operation.
 *  - `worker_protocol_mismatch` — abox/worker contract violation.
 *  - `worker_execution` — worker ran but produced a terminal failure.
 */
export type JsonErrorCode =
  | "user_input"
  | "approval_denied"
  | "policy_denied"
  | "worker_protocol_mismatch"
  | "worker_execution";

/**
 * Shape of the single-line error envelope emitted when the `--output-format=json`
 * dispatch path fails. Kept flat (no nested `schemaVersion`/`eventId` shell)
 * because errors are out-of-band relative to the `SessionEventEnvelope` stream
 * — downstream callers disambiguate by `kind !== "..."` on each line.
 */
export type JsonErrorEnvelope = {
  kind: "error";
  code: JsonErrorCode;
  message: string;
  details: Record<string, unknown>;
};

/**
 * Builder for {@link JsonErrorEnvelope}. Kept pure so tests and the one-shot
 * dispatch path can share the same shape without import cycles through the
 * JsonBackend instance.
 */
export const buildJsonErrorEnvelope = (input: {
  code: JsonErrorCode;
  message: string;
  details?: Record<string, unknown>;
}): JsonErrorEnvelope => ({
  kind: "error",
  code: input.code,
  message: input.message,
  details: input.details ?? {},
});

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
 *  2. `emitJsonError(code, message, details?)` — writes a single error line
 *     when dispatch fails. Shape: `{"kind":"error","code":...,...}`.
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
   * a normal terminal `review_completed` line.
   */
  emitJsonError(input: {
    code: JsonErrorCode;
    message: string;
    details?: Record<string, unknown>;
  }): void {
    void this.#stdout.write(`${JSON.stringify(buildJsonErrorEnvelope(input))}\n`);
  }
}
