import assert from "node:assert/strict";
import test from "node:test";

import { validateBindings } from "../../../src/host/keybindings/validate.js";

test("validateBindings: accepts empty object", () => {
  const result = validateBindings({});
  assert.deepEqual(result, { ok: true });
});

test("validateBindings: accepts a valid single-context override", () => {
  const result = validateBindings({
    Composer: {
      "ctrl+k": "composer:modelPicker",
    },
  });
  assert.deepEqual(result, { ok: true });
});

test("validateBindings: accepts chord bindings", () => {
  const result = validateBindings({
    Composer: {
      "ctrl+x ctrl+f": "composer:formatBuffer",
    },
  });
  assert.deepEqual(result, { ok: true });
});

test("validateBindings: rejects collision with reserved Ctrl+C", () => {
  const result = validateBindings({
    Global: {
      "ctrl+c": "custom:dance",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes("reserved")));
});

test("validateBindings: rejects collision with reserved Esc", () => {
  const result = validateBindings({
    Composer: {
      escape: "custom:wipe",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes("reserved")));
});

test("validateBindings: rejects chord starting with reserved trigger", () => {
  const result = validateBindings({
    Composer: {
      "ctrl+c ctrl+k": "custom:evil",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes("reserved")));
});

test("validateBindings: rejects malformed key string", () => {
  const result = validateBindings({
    Composer: {
      "ctrl+": "custom:borked",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes("unparseable")));
});

test("validateBindings: rejects duplicate action within one context", () => {
  const result = validateBindings({
    Composer: {
      "ctrl+k": "composer:submit",
      "meta+k": "composer:submit",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes("duplicate")));
});

test("validateBindings: rejects empty action ID", () => {
  const result = validateBindings({
    Composer: {
      "ctrl+k": "",
    },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
});

test("validateBindings: rejects unknown context names (strict shape)", () => {
  const result = validateBindings({
    NotAContext: { "ctrl+k": "x:y" },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
});

test("validateBindings: rejects non-object root", () => {
  assert.equal(validateBindings("nope").ok, false);
  assert.equal(validateBindings(null).ok, false);
  assert.equal(validateBindings([]).ok, false);
});

test("validateBindings: same action ID across different contexts is fine", () => {
  const result = validateBindings({
    Composer: { "ctrl+k": "generic:action" },
    Inspect: { "ctrl+k": "generic:action" },
  });
  assert.deepEqual(result, { ok: true });
});
