/**
 * Match a live keyboard event (plus any chord prefix state) against a set of
 * bindings. Caller is responsible for keeping the chord buffer (see
 * `chord.ts`) and invoking `matchBinding` on every keystroke.
 *
 * Returns one of:
 *  - `{ action: string }` — a binding fully matched; caller dispatches action
 *    and resets the chord buffer.
 *  - `{ partial: true }` — event extends a prefix of at least one binding;
 *    caller retains the chord buffer and starts/extends the timeout.
 *  - `null` — no binding matches any prefix; caller resets the chord buffer.
 *
 * The binding set is `Record<encodedKey, KeyBinding>` where the keys are for
 * the caller's convenience (the matcher only walks values).
 */
import { strokesEqual, type KeyBinding, type KeyStroke } from "./parser.js";

export type KeyboardEvent = KeyStroke;

export type MatchResult = { action: string } | { partial: true } | null;

/**
 * Match an event against the binding set given the chord prefix already
 * captured (which does NOT include `event`).
 *
 * @param event - The keystroke just received.
 * @param chord - Strokes previously captured that have not yet completed a
 *                match (the chord buffer). Empty for a fresh dispatch.
 * @param bindings - The active binding registry, mapping action ID (or any
 *                   opaque string) to a KeyBinding.
 */
const matchesPrefix = (prefix: KeyStroke[], binding: KeyBinding): boolean =>
  prefix.every((s, i) => {
    const bStroke = binding.strokes[i];
    return bStroke !== undefined && strokesEqual(s, bStroke);
  });

export const matchBinding = (
  event: KeyStroke,
  chord: KeyStroke[],
  bindings: Record<string, KeyBinding>,
): MatchResult => {
  const prefix = [...chord, event];
  let foundPartial = false;

  for (const [action, binding] of Object.entries(bindings)) {
    // Full match: binding has exactly the same length and every stroke
    // equals in order.
    if (binding.strokes.length === prefix.length && matchesPrefix(prefix, binding)) {
      return { action };
    }
    // Partial match: binding is longer than the current prefix AND the
    // binding's first `prefix.length` strokes match the prefix.
    if (binding.strokes.length > prefix.length && matchesPrefix(prefix, binding)) {
      foundPartial = true;
    }
  }

  if (foundPartial) {
    return { partial: true };
  }
  return null;
};
