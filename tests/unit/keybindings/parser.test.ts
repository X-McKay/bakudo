import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeBinding,
  encodeStroke,
  parseKeyBinding,
  strokesEqual,
} from "../../../src/host/keybindings/parser.js";

test("parseKeyBinding: single key", () => {
  const b = parseKeyBinding("a");
  assert.equal(b.strokes.length, 1);
  const stroke = b.strokes[0];
  assert.ok(stroke);
  assert.equal(stroke.key, "a");
  assert.equal(stroke.modifiers.size, 0);
});

test("parseKeyBinding: Ctrl+K (case-insensitive modifier)", () => {
  const b = parseKeyBinding("Ctrl+K");
  const stroke = b.strokes[0];
  assert.ok(stroke);
  assert.equal(stroke.key, "k");
  assert.ok(stroke.modifiers.has("ctrl"));
});

test("parseKeyBinding: Meta+P", () => {
  const b = parseKeyBinding("Meta+P");
  const stroke = b.strokes[0];
  assert.ok(stroke);
  assert.equal(stroke.key, "p");
  assert.ok(stroke.modifiers.has("meta"));
});

test("parseKeyBinding: Shift+Tab normalizes key", () => {
  const b = parseKeyBinding("Shift+Tab");
  const stroke = b.strokes[0];
  assert.ok(stroke);
  assert.equal(stroke.key, "tab");
  assert.ok(stroke.modifiers.has("shift"));
});

test("parseKeyBinding: multi-modifier ctrl+shift+f", () => {
  const b = parseKeyBinding("ctrl+shift+f");
  const stroke = b.strokes[0];
  assert.ok(stroke);
  assert.equal(stroke.key, "f");
  assert.equal(stroke.modifiers.size, 2);
  assert.ok(stroke.modifiers.has("ctrl"));
  assert.ok(stroke.modifiers.has("shift"));
});

test("parseKeyBinding: chord 'ctrl+x ctrl+k'", () => {
  const b = parseKeyBinding("ctrl+x ctrl+k");
  assert.equal(b.strokes.length, 2);
  const [first, second] = b.strokes;
  assert.ok(first && second);
  assert.equal(first.key, "x");
  assert.ok(first.modifiers.has("ctrl"));
  assert.equal(second.key, "k");
  assert.ok(second.modifiers.has("ctrl"));
});

test("parseKeyBinding: normalizes 'esc' and 'return' aliases", () => {
  const esc = parseKeyBinding("esc");
  assert.equal(esc.strokes[0]?.key, "escape");
  const ret = parseKeyBinding("return");
  assert.equal(ret.strokes[0]?.key, "enter");
});

test("parseKeyBinding: empty string throws", () => {
  assert.throws(() => parseKeyBinding(""));
  assert.throws(() => parseKeyBinding("   "));
});

test("parseKeyBinding: trailing modifier throws", () => {
  assert.throws(() => parseKeyBinding("ctrl+"));
});

test("parseKeyBinding: leading modifier-only throws", () => {
  assert.throws(() => parseKeyBinding("+a"));
});

test("parseKeyBinding: modifier-only stroke throws (e.g. 'ctrl')", () => {
  assert.throws(() => parseKeyBinding("ctrl"));
});

test("parseKeyBinding: non-string input throws", () => {
  assert.throws(() => parseKeyBinding(42 as unknown as string));
});

test("parseKeyBinding: defaults list — every shipped key parses", () => {
  const cases = [
    "ctrl+c",
    "ctrl+d",
    "ctrl+l",
    "ctrl+r",
    "escape",
    "shift+tab",
    "meta+m",
    "enter",
    "ctrl+x ctrl+k",
    "tab",
    "pageup",
    "ctrl+u",
    "pagedown",
    "ctrl+s",
  ];
  for (const raw of cases) {
    assert.doesNotThrow(() => parseKeyBinding(raw), `should parse: ${raw}`);
  }
});

test("encodeStroke + strokesEqual round-trip via re-parse", () => {
  const raw = "Ctrl+Shift+F";
  const b = parseKeyBinding(raw);
  const first = b.strokes[0];
  assert.ok(first);
  const encoded = encodeStroke(first);
  // Modifiers come out sorted alphabetically: ctrl, shift.
  assert.equal(encoded, "ctrl+shift+f");
  const reparsed = parseKeyBinding(encoded);
  const reStroke = reparsed.strokes[0];
  assert.ok(reStroke);
  assert.ok(strokesEqual(first, reStroke));
});

test("encodeBinding: chord encoding is whitespace-joined", () => {
  const b = parseKeyBinding("Ctrl+X Ctrl+K");
  assert.equal(encodeBinding(b), "ctrl+x ctrl+k");
});
