import assert from "node:assert/strict";
import test from "node:test";

import { isReserved, RESERVED_KEYS } from "../../../src/host/keybindings/reserved.js";

test("RESERVED_KEYS: contains the expected canonical strokes", () => {
  assert.ok(RESERVED_KEYS.has("ctrl+c"));
  assert.ok(RESERVED_KEYS.has("ctrl+d"));
  assert.ok(RESERVED_KEYS.has("/"));
  assert.ok(RESERVED_KEYS.has("escape"));
  assert.ok(RESERVED_KEYS.has("enter"));
  assert.ok(RESERVED_KEYS.has("tab"));
});

test("RESERVED_KEYS: does not contain unreserved keys", () => {
  assert.equal(RESERVED_KEYS.has("ctrl+k"), false);
  assert.equal(RESERVED_KEYS.has("ctrl+s"), false);
  assert.equal(RESERVED_KEYS.has("shift+tab"), false);
});

test("isReserved: detects reserved strings regardless of case", () => {
  assert.equal(isReserved("Ctrl+C"), true);
  assert.equal(isReserved("ctrl+c"), true);
  assert.equal(isReserved("CTRL+D"), true);
  assert.equal(isReserved("Esc"), true);
  assert.equal(isReserved("Enter"), true);
  assert.equal(isReserved("Tab"), true);
  assert.equal(isReserved("/"), true);
});

test("isReserved: non-reserved strings return false", () => {
  assert.equal(isReserved("ctrl+k"), false);
  assert.equal(isReserved("meta+p"), false);
  assert.equal(isReserved("shift+tab"), false);
});

test("isReserved: malformed input returns false (does not throw)", () => {
  assert.equal(isReserved(""), false);
  assert.equal(isReserved("ctrl+"), false);
});
