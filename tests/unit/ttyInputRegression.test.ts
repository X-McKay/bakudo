/**
 * Wave 6d PR14 — A6.11 Kitty / IME regression fixtures.
 *
 * Companion doc:
 *   plans/bakudo-ux/phase-6-a611-terminal-compat.md (parent-workspace level)
 *
 * These tests pin the *current* behavior of bakudo's TTY input + ANSI path on
 * the scenarios documented in the A6.11 matrix. Several tests assert KNOWN
 * LIMITATIONS — they pass against today's code and will FAIL (forcing a
 * deliberate matrix update) if raw-key dispatch, bracketed-paste handling, or
 * grapheme-aware width measurement is added later.
 *
 * Scope boundary:
 *   - No TtyBackend render-loop invocation here. Lock-in 10/11 constrains
 *     backend ownership of raw-mode + alt-screen; unit tests exercise only
 *     the width/ANSI/parser/reserved-key paths.
 *   - No reserved-key remapping attempts (lock-in 13).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { displayWidth, fitDisplay, stripAnsi } from "../../src/host/ansi.js";
import { buildDefaultBindings, resolveModeCycleKey } from "../../src/host/keybindings/defaults.js";
import { matchBinding } from "../../src/host/keybindings/match.js";
import {
  encodeBinding,
  parseKeyBinding,
  type KeyStroke,
} from "../../src/host/keybindings/parser.js";
import { isReserved, RESERVED_KEYS } from "../../src/host/keybindings/reserved.js";

const stroke = (raw: string): KeyStroke => {
  const binding = parseKeyBinding(raw);
  const s = binding.strokes[0];
  if (s === undefined) {
    throw new Error("unreachable: parser would have thrown");
  }
  return s;
};

// -----------------------------------------------------------------------------
// 1. Multi-byte UTF-8 preservation
// -----------------------------------------------------------------------------

test("A6.11 / UTF-8: CJK round-trips through stripAnsi without corruption", () => {
  // Japanese "日本語" (nihongo). Three code points, each outside ASCII. Each
  // fits in a single UTF-16 code unit, so length === 3 despite 9 UTF-8 bytes.
  const input = "日本語";
  assert.equal(input.length, 3, "precondition: JS string length is code-unit count");
  assert.equal(stripAnsi(input), input, "stripAnsi must be content-preserving on non-ANSI input");
  // With a real ANSI wrapper, the text survives.
  const wrapped = `\u001B[31m${input}\u001B[0m`;
  assert.equal(stripAnsi(wrapped), input);
});

test("A6.11 / UTF-8: Korean Hangul content-preserving under stripAnsi", () => {
  const input = "한국어"; // ko
  assert.equal(stripAnsi(input), input);
  assert.equal(stripAnsi(`\u001B[1m${input}\u001B[0m`), input);
});

test("A6.11 / UTF-8: emoji content-preserving under stripAnsi (surrogate pair intact)", () => {
  const input = "👍"; // U+1F44D — UTF-16 surrogate pair
  assert.equal(input.length, 2, "precondition: emoji is a UTF-16 surrogate pair");
  assert.equal(stripAnsi(input), input, "stripAnsi must not split surrogates");
});

// -----------------------------------------------------------------------------
// 2. Double-width miscount (KNOWN LIMITATION L1)
// -----------------------------------------------------------------------------

test("A6.11 / width: displayWidth counts CJK as code units (KNOWN LIMITATION L1)", () => {
  // A grapheme-aware implementation would return 6 (3 chars × 2 cols). Today
  // bakudo returns 3. This test pins the limitation so an accidental "fix"
  // without updating fitDisplay / wrapPlain / renderBox callers is visible.
  assert.equal(displayWidth("日本語"), 3);
  assert.equal(displayWidth("한국어"), 3);
});

test("A6.11 / width: displayWidth counts surrogate-pair emoji as 2 (KNOWN LIMITATION L1)", () => {
  // U+1F44D encodes as 2 UTF-16 code units. A column-aware implementation
  // would return 2 (emoji renders ~2 cols) — accidentally agreeing here.
  // The mismatch is observable on VS16 (next test) and ZWJ clusters.
  assert.equal(displayWidth("👍"), 2);
});

test("A6.11 / width: emoji + VS16 compound reports 3 (KNOWN LIMITATION L1)", () => {
  // U+1F44D (thumbs-up, surrogate pair → 2 code units) + U+FE0F (VS16, 1 code
  // unit) = 3 code units in JS, rendered as 2 columns by column-aware
  // terminals. The mismatch is the whole point of this test. Remediation is
  // documented in the matrix (§6 L1).
  const compound = "\u{1F44D}\u{FE0F}";
  assert.equal(compound.length, 3, "precondition: JS code-unit count is 3");
  assert.equal(displayWidth(compound), 3, "bakudo under-measures until wcwidth lands");
});

test("A6.11 / width: ZWJ family emoji reports code-unit count (KNOWN LIMITATION L1)", () => {
  // Family: man ZWJ woman ZWJ girl. Renders as ~2 columns on capable terms.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  // The compound is 8 UTF-16 code units (3 surrogate pairs + 2 ZWJ).
  assert.equal(family.length, 8);
  assert.equal(displayWidth(family), 8);
});

test("A6.11 / width: ASCII-only widths remain correct post-regression", () => {
  // Sanity: box drawing for pure-ASCII panels has always worked; make sure
  // the width path for ASCII is unaffected by any future wcwidth swap.
  assert.equal(displayWidth("hello"), 5);
  assert.equal(displayWidth("\u001B[1mhello\u001B[0m"), 5);
  assert.equal(fitDisplay("hello", 10), "hello     ");
  // width 8 and input longer than width: slice(0, width-3) + "..." → "hello" + "..."
  assert.equal(fitDisplay("hello world", 8), "hello...");
});

// -----------------------------------------------------------------------------
// 3. Bracketed-paste — negative path (KNOWN LIMITATION L6)
// -----------------------------------------------------------------------------

test("A6.11 / bracketed-paste: wrappers are NOT stripped by stripAnsi (KNOWN LIMITATION L6)", () => {
  // stripAnsi targets SGR specifically (`\x1B[...m`). Bracketed-paste
  // wrappers (`\x1B[200~` enter, `\x1B[201~` exit) are a different CSI family
  // and must survive the strip — precisely because bakudo does not consume
  // them yet. If a future PR broadens stripAnsi to cover all CSI, this
  // assertion will fail and the matrix needs updating.
  const pasted = "\u001B[200~hello\nworld\u001B[201~";
  const stripped = stripAnsi(pasted);
  // The SGR-only stripper leaves the bracketed-paste wrappers intact.
  assert.ok(stripped.includes("\u001B[200~"), "bracketed-paste start survives SGR-only strip");
  assert.ok(stripped.includes("\u001B[201~"), "bracketed-paste end survives SGR-only strip");
  assert.ok(stripped.includes("hello\nworld"));
});

test("A6.11 / bracketed-paste: no helper recognizes CSI 200~ / 201~ yet", async () => {
  // Negative assertion: grep for a dedicated bracketed-paste helper in the
  // public ansi module surface. If someone adds one without touching the
  // matrix doc, this test should fail.
  const mod = (await import("../../src/host/ansi.js")) as Record<string, unknown>;
  const names = Object.keys(mod);
  const bracketedExports = names.filter((n) => /bracketed|paste/i.test(n));
  assert.deepEqual(
    bracketedExports,
    [],
    `bakudo does not ship bracketed-paste helpers yet; found: ${bracketedExports.join(",")}`,
  );
});

// -----------------------------------------------------------------------------
// 4. Kitty CSI u — negative path (KNOWN LIMITATION L3)
// -----------------------------------------------------------------------------

test("A6.11 / Kitty CSI u: stripAnsi leaves CSI-u sequences intact (KNOWN LIMITATION L3)", () => {
  // Kitty progressive-keyboard sequences look like `\x1B[27;2u` (Shift+Esc),
  // terminated by `u` not `m`. The SGR-only stripper must leave them alone
  // — bakudo does not negotiate the protocol, so any CSI-u that did arrive
  // should pass through and be visible rather than silently eaten.
  const csiU = "prefix\u001B[27;2usuffix";
  assert.equal(stripAnsi(csiU), csiU, "CSI-u (terminator 'u') must survive SGR-only strip");
});

test("A6.11 / Kitty CSI u: no opt-in query is emitted by the ansi module", async () => {
  // Another negative: no helper with 'kitty' or 'csiU' in the name is
  // exported from ansi.ts today.
  const mod = (await import("../../src/host/ansi.js")) as Record<string, unknown>;
  const names = Object.keys(mod);
  const kittyExports = names.filter((n) => /kitty|csiu/i.test(n));
  assert.deepEqual(kittyExports, [], "no Kitty CSI-u exports in ansi.ts today");
});

// -----------------------------------------------------------------------------
// 5. Reserved keys — lock-in 13 guard
// -----------------------------------------------------------------------------

test("A6.11 / reserved: the six lock-in-13 triggers are all reserved", () => {
  // `Ctrl+C`, `Ctrl+D`, `/`, `Esc`, `Enter`, `Tab` must not be remappable.
  // Assert via the canonical encoded form so aliasing (`Esc` vs `Escape`,
  // `Return` vs `Enter`) doesn't create a false pass.
  const encoded = (raw: string): string => encodeBinding(parseKeyBinding(raw));
  assert.ok(RESERVED_KEYS.has(encoded("ctrl+c")));
  assert.ok(RESERVED_KEYS.has(encoded("ctrl+d")));
  assert.ok(RESERVED_KEYS.has(encoded("/")));
  assert.ok(RESERVED_KEYS.has(encoded("escape")));
  assert.ok(RESERVED_KEYS.has(encoded("enter")));
  assert.ok(RESERVED_KEYS.has(encoded("tab")));
  // And their aliases collapse to the same reserved encoding.
  assert.ok(isReserved("Esc"));
  assert.ok(isReserved("Return"));
});

test("A6.11 / reserved: a non-reserved trigger is NOT reserved (sanity)", () => {
  assert.equal(isReserved("ctrl+k"), false, "Ctrl+K remains user-remappable");
  assert.equal(isReserved("shift+tab"), false, "Shift+Tab is remappable (Tab alone is reserved)");
  assert.equal(isReserved("alt+enter"), false, "Alt+Enter is remappable (Enter alone is reserved)");
});

// -----------------------------------------------------------------------------
// 6. Shift+Tab vs Tab — Windows-console fallback
// -----------------------------------------------------------------------------

test("A6.11 / extended keys: Shift+Tab distinct from Tab in match registry", () => {
  const bindings = {
    "inspect:tabNext": parseKeyBinding("tab"),
    "inspect:tabPrev": parseKeyBinding("shift+tab"),
  };
  // Tab alone selects tabNext.
  assert.deepEqual(matchBinding(stroke("tab"), [], bindings), { action: "inspect:tabNext" });
  // Shift+Tab selects tabPrev — the matcher must not collapse modifier sets.
  assert.deepEqual(matchBinding(stroke("shift+tab"), [], bindings), {
    action: "inspect:tabPrev",
  });
});

test("A6.11 / extended keys: win32 non-VT falls back to meta+m for mode cycle", () => {
  // On Windows Terminal without VT the two bindings are indistinguishable;
  // defaults.ts paves over this with a meta+m fallback. This is the single
  // documented place bakudo code-branches on terminal identity.
  const wtVt = resolveModeCycleKey({ platform: "win32", wtSession: "abc-123" });
  assert.equal(wtVt, "shift+tab");
  const legacyConsole = resolveModeCycleKey({ platform: "win32", wtSession: undefined });
  assert.equal(legacyConsole, "meta+m");
  const unix = resolveModeCycleKey({ platform: "darwin", wtSession: undefined });
  assert.equal(unix, "shift+tab");
});

test("A6.11 / extended keys: default bindings block for Inspect binds Shift+Tab to tabPrev", () => {
  const blocks = buildDefaultBindings({ platform: "linux", wtSession: undefined });
  const inspect = blocks.find((b) => b.context === "Inspect");
  assert.ok(inspect, "Inspect block should exist in defaults");
  // The map entry is keyed by the raw binding string used at authoring time.
  assert.equal(inspect.bindings["shift+tab"], "inspect:tabPrev");
  assert.equal(inspect.bindings["tab"], "inspect:tabNext");
});

// -----------------------------------------------------------------------------
// 7. Ctrl+X Ctrl+K chord — prefix matching under interleaved input
// -----------------------------------------------------------------------------

test("A6.11 / chord: Ctrl+X Ctrl+K fires only on the full chord, not on a near-miss", () => {
  const bindings = {
    "composer:killAgents": parseKeyBinding("ctrl+x ctrl+k"),
  };
  // First stroke: partial.
  assert.deepEqual(matchBinding(stroke("ctrl+x"), [], bindings), { partial: true });
  // Correct completion.
  assert.deepEqual(matchBinding(stroke("ctrl+k"), [stroke("ctrl+x")], bindings), {
    action: "composer:killAgents",
  });
  // Near-miss: `Ctrl+X` then `K` (no Ctrl) — modifier mismatch → no match.
  assert.equal(matchBinding(stroke("k"), [stroke("ctrl+x")], bindings), null);
  // Near-miss: `Ctrl+K` alone (no prefix) — no match.
  assert.equal(matchBinding(stroke("ctrl+k"), [], bindings), null);
});

test("A6.11 / chord: a superficially similar escape-escape sequence is distinct from chord", () => {
  const bindings = {
    "app:timelinePicker": parseKeyBinding("escape escape"),
  };
  // First Esc: partial.
  assert.deepEqual(matchBinding(stroke("escape"), [], bindings), { partial: true });
  // Esc then an unrelated key: no match.
  assert.equal(matchBinding(stroke("a"), [stroke("escape")], bindings), null);
  // Two Escs: fires.
  assert.deepEqual(matchBinding(stroke("escape"), [stroke("escape")], bindings), {
    action: "app:timelinePicker",
  });
});

// -----------------------------------------------------------------------------
// 8. Ctrl+Arrow — negative assertion (not shipped)
// -----------------------------------------------------------------------------

test("A6.11 / extended keys: Ctrl+Arrow word-jump bindings are NOT shipped today", () => {
  const blocks = buildDefaultBindings({ platform: "linux", wtSession: undefined });
  const all = blocks.flatMap((b) => Object.keys(b.bindings));
  // No `ctrl+left`, `ctrl+right`, `ctrl+up`, `ctrl+down` in any context. If a
  // future PR adds one, this test fails and the matrix §4 "Ctrl+Arrow" row
  // must be updated accordingly.
  const ctrlArrow = all.filter((k) => /^ctrl\+(left|right|up|down)$/i.test(k));
  assert.deepEqual(ctrlArrow, [], `no Ctrl+Arrow bindings expected; found: ${ctrlArrow.join(",")}`);
});
