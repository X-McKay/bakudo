/**
 * Registration API for keybinding handlers.
 *
 * Keybinding *bindings* (trigger → action ID) come from defaults + user
 * overrides (see `defaults.ts`, `userBindings.ts`). This module tracks the
 * *handlers* side — the functions invoked when an action ID fires in a given
 * context. Because dispatch does not run in this PR, the registry is write-
 * only from an external perspective; it will be consumed by the W3 advanced-
 * interactions PR that wires input events to the reducer.
 *
 * Registry shape: `Map<KeybindingContext, Map<ActionId, Handler>>` — Map of
 * Maps so inner handlers can be replaced without rebuilding the outer shape.
 *
 * Public API:
 *  - `registerKeybinding(context, action, handler)` → disposer
 *  - `getKeybindingsFor(context)` → readonly snapshot of `action → handler`
 *  - `clearKeybindings()` — test helper; wipes the registry
 *
 * The default registry is a module-level singleton (consistent with
 * `reducer.ts`'s ambient-dispatch pattern). `createKeybindingRegistry()` is
 * exported for isolation in tests.
 */
import type { KeybindingContext, ActionId } from "./defaults.js";

export type KeybindingHandler = (event: { action: ActionId }) => void;

export type KeybindingRegistry = {
  register: (
    context: KeybindingContext,
    action: ActionId,
    handler: KeybindingHandler,
  ) => () => void;
  get: (context: KeybindingContext) => ReadonlyMap<ActionId, KeybindingHandler>;
  clear: () => void;
};

export const createKeybindingRegistry = (): KeybindingRegistry => {
  const byContext = new Map<KeybindingContext, Map<ActionId, KeybindingHandler>>();

  return {
    register: (context, action, handler) => {
      let inner = byContext.get(context);
      if (inner === undefined) {
        inner = new Map<ActionId, KeybindingHandler>();
        byContext.set(context, inner);
      }
      inner.set(action, handler);
      return () => {
        const current = byContext.get(context);
        if (current === undefined) {
          return;
        }
        const found = current.get(action);
        // Only remove if still the same handler (idempotent + safe for
        // overlapping registrations).
        if (found === handler) {
          current.delete(action);
          if (current.size === 0) {
            byContext.delete(context);
          }
        }
      };
    },
    get: (context) => {
      const inner = byContext.get(context);
      if (inner === undefined) {
        return new Map<ActionId, KeybindingHandler>();
      }
      return inner;
    },
    clear: () => {
      byContext.clear();
    },
  };
};

/**
 * Module-level singleton registry. Imported by command modules in the W3 PR
 * to declare per-context handlers.
 */
const defaultRegistry = createKeybindingRegistry();

export const registerKeybinding = (
  context: KeybindingContext,
  action: ActionId,
  handler: KeybindingHandler,
): (() => void) => defaultRegistry.register(context, action, handler);

export const getKeybindingsFor = (
  context: KeybindingContext,
): ReadonlyMap<ActionId, KeybindingHandler> => defaultRegistry.get(context);

export const clearKeybindings = (): void => defaultRegistry.clear();
