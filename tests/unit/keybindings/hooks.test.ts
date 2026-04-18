import assert from "node:assert/strict";
import test from "node:test";

import {
  clearKeybindings,
  createKeybindingRegistry,
  getKeybindingsFor,
  registerKeybinding,
} from "../../../src/host/keybindings/hooks.js";

test("createKeybindingRegistry: isolated registries do not share state", () => {
  const a = createKeybindingRegistry();
  const b = createKeybindingRegistry();
  a.register("Composer", "x:action", () => {});
  assert.equal(a.get("Composer").size, 1);
  assert.equal(b.get("Composer").size, 0);
});

test("createKeybindingRegistry: register + get round-trip", () => {
  const r = createKeybindingRegistry();
  const handler = (): void => {};
  r.register("Composer", "composer:submit", handler);
  const map = r.get("Composer");
  assert.equal(map.get("composer:submit"), handler);
});

test("createKeybindingRegistry: register returns working disposer", () => {
  const r = createKeybindingRegistry();
  const handler = (): void => {};
  const dispose = r.register("Inspect", "inspect:tabNext", handler);
  assert.equal(r.get("Inspect").size, 1);
  dispose();
  assert.equal(r.get("Inspect").size, 0);
});

test("createKeybindingRegistry: disposer is idempotent", () => {
  const r = createKeybindingRegistry();
  const dispose = r.register("Dialog", "dialog:confirm", () => {});
  dispose();
  dispose();
  assert.equal(r.get("Dialog").size, 0);
});

test("createKeybindingRegistry: disposer does not remove a replacement handler", () => {
  const r = createKeybindingRegistry();
  const h1 = (): void => {};
  const h2 = (): void => {};
  const dispose = r.register("Composer", "composer:submit", h1);
  r.register("Composer", "composer:submit", h2); // replaces h1
  dispose(); // should no-op since current handler is h2, not h1
  assert.equal(r.get("Composer").get("composer:submit"), h2);
});

test("createKeybindingRegistry: get on empty context returns empty map", () => {
  const r = createKeybindingRegistry();
  const map = r.get("Transcript");
  assert.equal(map.size, 0);
});

test("createKeybindingRegistry: clear wipes everything", () => {
  const r = createKeybindingRegistry();
  r.register("Global", "app:redraw", () => {});
  r.register("Composer", "composer:submit", () => {});
  r.clear();
  assert.equal(r.get("Global").size, 0);
  assert.equal(r.get("Composer").size, 0);
});

test("module-level registerKeybinding/getKeybindingsFor use the singleton", () => {
  clearKeybindings();
  try {
    const handler = (): void => {};
    const dispose = registerKeybinding("Global", "app:redraw", handler);
    assert.equal(getKeybindingsFor("Global").get("app:redraw"), handler);
    dispose();
    assert.equal(getKeybindingsFor("Global").size, 0);
  } finally {
    clearKeybindings();
  }
});
