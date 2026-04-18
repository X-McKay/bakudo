import type { HostAppState } from "./appState.js";
import { classifyError, type RenderedError } from "./errors.js";
import type { InteractiveResolution, TickDeps } from "./interactiveRenderLoop.js";

/**
 * Sentinel returned by handlers that request shell termination. The shell
 * loop recognizes this and cleanly exits with `code`.
 */
export type ExitResolution = { kind: "exit"; code: number };

export const isExitResolution = (value: unknown): value is ExitResolution =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "exit" &&
  typeof (value as { code?: unknown }).code === "number";

/**
 * Phase 6 W9: dispatch outcome when a handler surfaces a typed error. The
 * shell would consume this to print a plain-text error and exit with the
 * stable exit code from the error taxonomy (`host/errors.ts`). Kept thin —
 * classification happens in `classifyError` (A6.3 entry point).
 *
 * Reserved for Wave 11 (interactive command-dispatch wiring). No live call
 * sites today; several subcommand modules (`chronicle.ts`, `usage.ts`,
 * `cleanupSupport.ts`, `chronicleSupport.ts`) already name this type in
 * their jsdoc as the anticipated typed-error return shape, so it stays
 * exported but is otherwise dormant. See phase-6-mid handoff carryover #5.
 *
 * @deprecated-unused — remove or consume in Wave 11 when interactive
 *   dispatch grows a typed-error path; dead code today.
 */
export type ErrorResolution = { kind: "error"; rendered: RenderedError };

/**
 * Wrap any thrown value as an {@link ErrorResolution}. Reserved for Wave 11
 * — no live call sites today. See the note on {@link ErrorResolution}.
 * @deprecated-unused
 */
export const errorResolutionFor = (error: unknown): ErrorResolution => ({
  kind: "error",
  rendered: classifyError(error),
});

/**
 * A command handler can:
 *  - return null / undefined, signalling that the command was handled in-place
 *    (side effects already applied: transcript, appState, host state, etc.)
 *  - return an {@link InteractiveResolution}, signalling that the caller should
 *    fall through to the legacy exec path (parse + dispatch) with the provided argv.
 *  - return an {@link ExitResolution}, signalling that the shell should
 *    terminate with the supplied exit code (e.g. /exit, /quit).
 */
export type HostCommandHandlerResult =
  | void
  | null
  | undefined
  | InteractiveResolution
  | ExitResolution
  | Promise<void | null | undefined | InteractiveResolution | ExitResolution>;

export type HostCommandContext = {
  args: string[];
  line: string;
  deps: TickDeps;
  // Read-only snapshot for visibility decisions.
  state: HostAppState;
};

export type HostCommandSpec = {
  name: string;
  aliases?: readonly string[];
  description: string;
  group?: "session" | "inspect" | "composer" | "system" | "legacy";
  handler: (ctx: HostCommandContext) => HostCommandHandlerResult;
  // When true, omitted from /help listings unless requested.
  hidden?: boolean;
  // Visibility predicate, e.g. hide /resume when no saved session.
  visible?: (state: HostAppState) => boolean;
};

export type HostCommandRegistry = {
  register: (spec: HostCommandSpec) => void;
  get: (name: string) => HostCommandSpec | undefined;
  list: (state?: HostAppState) => HostCommandSpec[];
  dispatch: (
    line: string,
    deps: TickDeps,
  ) => Promise<
    | { kind: "handled" }
    | { kind: "fallthrough"; resolution: InteractiveResolution }
    | { kind: "unknown" }
    | { kind: "exit"; code: number }
  >;
};

export const createCommandRegistry = (): HostCommandRegistry => {
  const byName = new Map<string, HostCommandSpec>();
  const aliasToName = new Map<string, string>();

  const register = (spec: HostCommandSpec): void => {
    if (byName.has(spec.name)) {
      throw new Error(`command already registered: /${spec.name}`);
    }
    if (aliasToName.has(spec.name)) {
      throw new Error(`command name collides with existing alias: /${spec.name}`);
    }
    byName.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) {
      if (byName.has(alias)) {
        throw new Error(`alias collides with existing command: /${alias}`);
      }
      if (aliasToName.has(alias)) {
        throw new Error(`alias already registered: /${alias}`);
      }
      aliasToName.set(alias, spec.name);
    }
  };

  const get = (name: string): HostCommandSpec | undefined => {
    const canonical = byName.get(name);
    if (canonical !== undefined) {
      return canonical;
    }
    const aliased = aliasToName.get(name);
    return aliased === undefined ? undefined : byName.get(aliased);
  };

  const list = (state?: HostAppState): HostCommandSpec[] => {
    const all = Array.from(byName.values());
    if (state === undefined) {
      return all;
    }
    return all.filter((spec) => spec.visible === undefined || spec.visible(state));
  };

  const dispatch: HostCommandRegistry["dispatch"] = async (line, deps) => {
    if (!line.startsWith("/")) {
      return { kind: "unknown" };
    }
    const body = line.slice(1).trim();
    if (body.length === 0) {
      return { kind: "unknown" };
    }
    const [name = "", ...args] = body.split(/\s+/).filter(Boolean);
    const spec = get(name);
    if (spec === undefined) {
      return { kind: "unknown" };
    }
    const outcome = await spec.handler({ args, line, deps, state: deps.appState });
    if (outcome === undefined || outcome === null) {
      return { kind: "handled" };
    }
    if (isExitResolution(outcome)) {
      return { kind: "exit", code: outcome.code };
    }
    return { kind: "fallthrough", resolution: outcome };
  };

  return { register, get, list, dispatch };
};
