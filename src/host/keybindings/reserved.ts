/**
 * Reserved key strings that must NOT be remapped by user configuration.
 *
 * Rationale (per `05-…hardening.md:382`):
 *  - `Ctrl+C`, `Ctrl+D` — Claude Code reference behaviour (interrupt / exit).
 *  - `/`               — bakudo slash-command entrypoint.
 *  - `Esc`, `Enter`, `Tab` — cross-context navigation primitives.
 *
 * `validate.ts` rejects any user binding whose *trigger* (encoded stroke
 * string) appears in this set. Action IDs are free to remain overridable; it
 * is the *trigger* that is reserved.
 *
 * All entries are already in the canonical encoded form produced by
 * `encodeStroke()` in `parser.ts`: modifier set sorted alphabetically, key
 * lowercased.
 */
import { encodeBinding, parseKeyBinding } from "./parser.js";

const RAW_RESERVED: readonly string[] = ["ctrl+c", "ctrl+d", "/", "escape", "enter", "tab"];

/**
 * The canonical encoded form of every reserved stroke. Use this for
 * membership checks; it is the set consumers should compare against.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(
  RAW_RESERVED.map((raw) => encodeBinding(parseKeyBinding(raw))),
);

/**
 * True iff `raw` (as user-provided, unparsed) would, after canonical
 * encoding, collide with a reserved trigger. Wraps parsing so callers can
 * pass untrusted strings without try/catch boilerplate; malformed input
 * returns `false` (the caller will surface a parse error separately via
 * `validate.ts`).
 */
export const isReserved = (raw: string): boolean => {
  try {
    return RESERVED_KEYS.has(encodeBinding(parseKeyBinding(raw)));
  } catch {
    return false;
  }
};
