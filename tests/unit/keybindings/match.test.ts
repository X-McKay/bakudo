import assert from "node:assert/strict";
import test from "node:test";

import { matchBinding } from "../../../src/host/keybindings/match.js";
import { parseKeyBinding, type KeyStroke } from "../../../src/host/keybindings/parser.js";

const stroke = (raw: string): KeyStroke => {
  const b = parseKeyBinding(raw);
  const s = b.strokes[0];
  if (s === undefined) {
    throw new Error("unreachable: parser would have thrown");
  }
  return s;
};

test("matchBinding: single-stroke exact match returns action", () => {
  const bindings = {
    "app:redraw": parseKeyBinding("ctrl+l"),
    "composer:submit": parseKeyBinding("enter"),
  };
  const result = matchBinding(stroke("ctrl+l"), [], bindings);
  assert.deepEqual(result, { action: "app:redraw" });
});

test("matchBinding: no match returns null", () => {
  const bindings = { "app:redraw": parseKeyBinding("ctrl+l") };
  const result = matchBinding(stroke("a"), [], bindings);
  assert.equal(result, null);
});

test("matchBinding: chord partial-prefix returns { partial: true }", () => {
  const bindings = { "composer:killAgents": parseKeyBinding("ctrl+x ctrl+k") };
  const result = matchBinding(stroke("ctrl+x"), [], bindings);
  assert.deepEqual(result, { partial: true });
});

test("matchBinding: chord completion with prefix returns action", () => {
  const bindings = { "composer:killAgents": parseKeyBinding("ctrl+x ctrl+k") };
  const result = matchBinding(stroke("ctrl+k"), [stroke("ctrl+x")], bindings);
  assert.deepEqual(result, { action: "composer:killAgents" });
});

test("matchBinding: wrong second stroke breaks the chord (null)", () => {
  const bindings = { "composer:killAgents": parseKeyBinding("ctrl+x ctrl+k") };
  const result = matchBinding(stroke("ctrl+y"), [stroke("ctrl+x")], bindings);
  assert.equal(result, null);
});

test("matchBinding: modifier mismatch does not match", () => {
  const bindings = { "app:interrupt": parseKeyBinding("ctrl+c") };
  const result = matchBinding(stroke("c"), [], bindings); // no modifier
  assert.equal(result, null);
});

test("matchBinding: tab vs shift+tab are distinct", () => {
  const bindings = {
    "inspect:tabNext": parseKeyBinding("tab"),
    "dialog:back": parseKeyBinding("shift+tab"),
  };
  const result = matchBinding(stroke("shift+tab"), [], bindings);
  assert.deepEqual(result, { action: "dialog:back" });
});

test("matchBinding: two actions bound to chords sharing a prefix — partial stays partial", () => {
  const bindings = {
    "composer:killAgents": parseKeyBinding("ctrl+x ctrl+k"),
    "composer:formatBuffer": parseKeyBinding("ctrl+x ctrl+f"),
  };
  const result = matchBinding(stroke("ctrl+x"), [], bindings);
  assert.deepEqual(result, { partial: true });
});

test("matchBinding: exact-length match wins over partial match on longer chord", () => {
  // Exact match should win over partial.
  const bindings = {
    "composer:lone": parseKeyBinding("ctrl+x"),
    "composer:chord": parseKeyBinding("ctrl+x ctrl+k"),
  };
  const result = matchBinding(stroke("ctrl+x"), [], bindings);
  // Exact-length match wins over partial match on longer binding.
  assert.deepEqual(result, { action: "composer:lone" });
});
