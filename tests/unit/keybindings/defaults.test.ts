import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDefaultBindings,
  DEFAULT_BINDINGS,
  resolveModeCycleKey,
  type KeybindingBlock,
  type KeybindingContext,
} from "../../../src/host/keybindings/defaults.js";

const findBlock = (
  blocks: readonly KeybindingBlock[],
  context: KeybindingContext,
): KeybindingBlock => {
  const block = blocks.find((b) => b.context === context);
  if (block === undefined) {
    throw new Error(`missing block: ${context}`);
  }
  return block;
};

test("DEFAULT_BINDINGS: every context is present", () => {
  const contexts = new Set(DEFAULT_BINDINGS.map((b) => b.context));
  for (const required of ["Global", "Composer", "Inspect", "Dialog", "Transcript"] as const) {
    assert.ok(contexts.has(required), `missing context: ${required}`);
  }
});

test("DEFAULT_BINDINGS: Global has app:interrupt, app:exit, app:redraw, history:search", () => {
  const block = findBlock(DEFAULT_BINDINGS, "Global");
  assert.equal(block.bindings["ctrl+c"], "app:interrupt");
  assert.equal(block.bindings["ctrl+d"], "app:exit");
  assert.equal(block.bindings["ctrl+l"], "app:redraw");
  assert.equal(block.bindings["ctrl+r"], "history:search");
});

test("DEFAULT_BINDINGS: Composer has cancel, submit, killAgents chord", () => {
  const block = findBlock(DEFAULT_BINDINGS, "Composer");
  assert.equal(block.bindings["escape"], "composer:cancel");
  assert.equal(block.bindings["enter"], "composer:submit");
  assert.equal(block.bindings["ctrl+x ctrl+k"], "composer:killAgents");
});

test("DEFAULT_BINDINGS: Inspect has tabNext, scrollUp, scrollDown", () => {
  const block = findBlock(DEFAULT_BINDINGS, "Inspect");
  assert.equal(block.bindings["tab"], "inspect:tabNext");
  assert.equal(block.bindings["pageup"], "inspect:scrollUp");
  assert.equal(block.bindings["pagedown"], "inspect:scrollDown");
});

test("DEFAULT_BINDINGS: Dialog has back, confirm, cancel", () => {
  const block = findBlock(DEFAULT_BINDINGS, "Dialog");
  assert.equal(block.bindings["shift+tab"], "dialog:back");
  assert.equal(block.bindings["enter"], "dialog:confirm");
  assert.equal(block.bindings["escape"], "dialog:cancel");
});

test("DEFAULT_BINDINGS: Transcript has search", () => {
  const block = findBlock(DEFAULT_BINDINGS, "Transcript");
  assert.equal(block.bindings["ctrl+s"], "transcript:search");
});

test("resolveModeCycleKey: non-windows returns shift+tab", () => {
  assert.equal(resolveModeCycleKey({ platform: "linux", wtSession: undefined }), "shift+tab");
  assert.equal(resolveModeCycleKey({ platform: "darwin", wtSession: undefined }), "shift+tab");
});

test("resolveModeCycleKey: windows without WT_SESSION returns meta+m", () => {
  assert.equal(resolveModeCycleKey({ platform: "win32", wtSession: undefined }), "meta+m");
  assert.equal(resolveModeCycleKey({ platform: "win32", wtSession: "" }), "meta+m");
});

test("resolveModeCycleKey: windows with WT_SESSION returns shift+tab", () => {
  assert.equal(resolveModeCycleKey({ platform: "win32", wtSession: "abc-123" }), "shift+tab");
});

test("buildDefaultBindings: Composer mode-cycle uses platform-aware key", () => {
  const winNoVt = buildDefaultBindings({ platform: "win32", wtSession: undefined });
  const composerWin = findBlock(winNoVt, "Composer");
  assert.equal(composerWin.bindings["meta+m"], "composer:cycleMode");
  assert.equal(composerWin.bindings["shift+tab"], undefined);

  const linux = buildDefaultBindings({ platform: "linux", wtSession: undefined });
  const composerLinux = findBlock(linux, "Composer");
  assert.equal(composerLinux.bindings["shift+tab"], "composer:cycleMode");
  assert.equal(composerLinux.bindings["meta+m"], undefined);
});
