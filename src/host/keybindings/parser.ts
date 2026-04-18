/**
 * Keybinding string parser.
 *
 * Accepts strings like `"Ctrl+K"`, `"Meta+P"`, `"Shift+Tab"`, and multi-stroke
 * chords like `"ctrl+x ctrl+k"`. A chord is two or more whitespace-separated
 * single-stroke expressions. Each stroke is a `+`-joined list of modifiers
 * ending in a key name.
 *
 * Matches the reference-informed design in
 * `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md:531-567`.
 *
 * Rules:
 *  - Modifiers: `ctrl`, `alt`, `meta`, `shift` (case-insensitive).
 *  - Key names are lowercased. Special names (`tab`, `enter`, `escape`, `esc`,
 *    `space`, `pageup`, `pagedown`, arrow keys) are normalized below.
 *  - Parsing throws on malformed input. `validate.ts` converts the throw into
 *    a structured error for user-config validation.
 */
export type KeyModifier = "ctrl" | "alt" | "meta" | "shift";

export type KeyStroke = {
  modifiers: ReadonlySet<KeyModifier>;
  key: string;
};

export type KeyBinding = { strokes: KeyStroke[] };

const MODIFIERS: ReadonlySet<string> = new Set(["ctrl", "alt", "meta", "shift"]);

/**
 * Canonical key-name aliases. Always lowercased. Missing entries pass through
 * unchanged (after lowercasing).
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  tab: "tab",
  space: "space",
  spacebar: "space",
  pgup: "pageup",
  pgdn: "pagedown",
  pageup: "pageup",
  pagedown: "pagedown",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  insert: "insert",
  delete: "delete",
  backspace: "backspace",
};

const normalizeKey = (raw: string): string => {
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES[lower];
  return alias ?? lower;
};

const parseStroke = (raw: string, context: string): KeyStroke => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`empty stroke in "${context}"`);
  }
  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) {
    throw new Error(`empty segment in stroke "${raw}" (context: "${context}")`);
  }
  const modifiers = new Set<KeyModifier>();
  let key: string | undefined;
  const lastIndex = parts.length - 1;
  parts.forEach((part, i) => {
    const lower = part.toLowerCase();
    const isLast = i === lastIndex;
    if (MODIFIERS.has(lower) && !isLast) {
      modifiers.add(lower as KeyModifier);
    } else if (isLast) {
      // Last token is the key; modifiers-as-key not allowed (e.g. "ctrl+").
      if (MODIFIERS.has(lower)) {
        throw new Error(`stroke "${raw}" ends with a modifier (missing key)`);
      }
      key = normalizeKey(part);
    } else {
      throw new Error(`unexpected non-modifier "${part}" before key in "${raw}"`);
    }
  });
  if (key === undefined || key.length === 0) {
    throw new Error(`stroke "${raw}" has no key`);
  }
  return { modifiers, key };
};

/**
 * Parse a keybinding string into structured strokes.
 * Throws on malformed input (empty, trailing modifier, bad segments).
 */
export const parseKeyBinding = (raw: string): KeyBinding => {
  if (typeof raw !== "string") {
    throw new Error(`keybinding must be a string, got ${typeof raw}`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("keybinding string is empty");
  }
  const strokeStrings = trimmed.split(/\s+/);
  const strokes = strokeStrings.map((s) => parseStroke(s, raw));
  return { strokes };
};

/**
 * Stable string encoding of a single stroke. Used for registry keys and
 * collision detection. Modifiers sorted; key lowercased.
 */
export const encodeStroke = (stroke: KeyStroke): string => {
  const mods = Array.from(stroke.modifiers).sort();
  return [...mods, stroke.key].join("+");
};

/**
 * Stable string encoding of a full binding (chord or single stroke).
 */
export const encodeBinding = (binding: KeyBinding): string =>
  binding.strokes.map(encodeStroke).join(" ");

/**
 * Compare two strokes for exact equality (modifier set + key).
 */
export const strokesEqual = (a: KeyStroke, b: KeyStroke): boolean => {
  if (a.key !== b.key) {
    return false;
  }
  if (a.modifiers.size !== b.modifiers.size) {
    return false;
  }
  for (const m of a.modifiers) {
    if (!b.modifiers.has(m)) {
      return false;
    }
  }
  return true;
};
