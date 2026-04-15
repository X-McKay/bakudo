import type { HostAppState } from "./appState.js";
import type { InteractiveResolution, TickDeps } from "./interactiveRenderLoop.js";

/**
 * A command handler can:
 *  - return null / undefined, signalling that the command was handled in-place
 *    (side effects already applied: transcript, appState, host state, etc.)
 *  - return an {@link InteractiveResolution}, signalling that the caller should
 *    fall through to the legacy exec path (parse + dispatch) with the provided argv.
 */
export type HostCommandHandlerResult =
  | void
  | null
  | undefined
  | InteractiveResolution
  | Promise<void | null | undefined | InteractiveResolution>;

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
    return { kind: "fallthrough", resolution: outcome };
  };

  return { register, get, list, dispatch };
};
