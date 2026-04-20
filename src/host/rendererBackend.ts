import type { RenderFrame } from "./renderModel.js";
import { InkBackend } from "./renderers/inkBackend.js";
import { JsonBackend } from "./renderers/jsonBackend.js";
import { PlainBackend } from "./renderers/plainBackend.js";
import type { HostStore } from "./store/index.js";

/**
 * Framework-agnostic contract for a renderer that consumes {@link RenderFrame}
 * values and writes them to some sink.
 *
 * Phase 5-W2 (Ink migration): `render` accepts an optional frame because the
 * Ink backend is state-driven — the store subscribers trigger re-renders and
 * the backend's `render()` is a no-op shim for Plain/Json compatibility. The
 * `mount`/`waitUntilExit` hooks are optional: only {@link InkBackend} uses
 * them to boot/unblock the React render loop.
 *
 * Implementations MUST NOT depend on host app state directly apart from the
 * store handed to the Ink backend factory.
 */
export type RendererBackend = {
  render(frame?: RenderFrame): void;
  dispose?(): void;
  mount?(): void;
  waitUntilExit?(): Promise<void>;
};

/**
 * Minimal writable-stream shape the factory needs. `write` returns `unknown`
 * so existing Node writable streams and plain `{ write: () => true }` test
 * doubles both satisfy the contract.
 */
export type RendererStdout = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

export type SelectRendererBackendArgs = {
  useJson?: boolean;
  forcePlain?: boolean;
  stdout: RendererStdout;
  /**
   * Host store used by the Ink backend. Optional because the Plain/Json
   * backends ignore it; required in practice whenever the TTY path can be
   * reached (i.e. for interactive sessions).
   */
  store?: HostStore;
  /** Short repo basename displayed in the Ink frame header. */
  repoLabel?: string;
};

/**
 * Pick the appropriate backend for the current invocation. Selection rules:
 *
 * 1. `useJson === true` → {@link JsonBackend} (takes precedence over `forcePlain`
 *    because `--json` is a strictly stronger output contract).
 * 2. `forcePlain === true` OR non-TTY stdout OR `NO_COLOR` set → {@link PlainBackend}.
 * 3. Otherwise → {@link InkBackend}.
 *
 * Callers pass the exact stream the chosen backend will write to. The Ink
 * path requires `store`; callers that only hit the Plain/Json paths in tests
 * may omit it.
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
  if (args.store === undefined) {
    throw new Error(
      "selectRendererBackend: `store` is required when the interactive Ink backend is selected",
    );
  }
  return new InkBackend(args.store, args.repoLabel);
};
