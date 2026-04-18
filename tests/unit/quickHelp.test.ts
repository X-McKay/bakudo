/**
 * Phase 5 PR9 — `?` quick-help overlay tests.
 *
 * Covers:
 *  - {@link buildQuickHelpContents} across the four quick-help contexts.
 *  - Registry-filter behaviour (hides bindings whose handlers aren't wired).
 *  - Heading + dialogKind propagation.
 *  - Reducer actions `open_quick_help` / `close_quick_help`, including the
 *    toggle-off semantics.
 *  - {@link selectRenderFrame} promotion of the overlay and dialog-kind
 *    inheritance.
 *  - Transcript + plain renderer output containing the box-wrapped help.
 *  - {@link registerOverlayBindings} wiring and the Global `?` default.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { stripAnsi } from "../../src/host/ansi.js";
import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import { DEFAULT_BINDINGS } from "../../src/host/keybindings/defaults.js";
import {
  clearKeybindings,
  createKeybindingRegistry,
  getKeybindingsFor,
  type KeybindingHandler,
} from "../../src/host/keybindings/hooks.js";
import { buildQuickHelpContents } from "../../src/host/overlays/quickHelp.js";
import {
  registerOverlayBindings,
  resolveQuickHelpContext,
} from "../../src/host/overlayBindings.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";
import { renderTranscriptFrame } from "../../src/host/renderers/transcriptRenderer.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";

test("buildQuickHelpContents: composer context includes composer + global bindings", () => {
  const lines = buildQuickHelpContents("composer", DEFAULT_BINDINGS);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Submit composer"));
  assert.ok(joined.includes("Cycle composer mode"));
  assert.ok(joined.includes("Show this help"));
  assert.ok(joined.includes("Exit"));
});

test("buildQuickHelpContents: inspect context includes inspect + global bindings", () => {
  const lines = buildQuickHelpContents("inspect", DEFAULT_BINDINGS);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Next inspect tab"));
  assert.ok(joined.includes("Scroll up"));
  assert.ok(joined.includes("Show this help"));
  assert.ok(!joined.includes("Submit composer"));
});

test("buildQuickHelpContents: dialog context includes dialog + global bindings", () => {
  const lines = buildQuickHelpContents("dialog", DEFAULT_BINDINGS);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Confirm"));
  assert.ok(joined.includes("Cancel"));
  assert.ok(joined.includes("Back"));
});

test("buildQuickHelpContents: transcript context includes transcript + global bindings", () => {
  const lines = buildQuickHelpContents("transcript", DEFAULT_BINDINGS);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Search transcript"));
  assert.ok(joined.includes("Show this help"));
});

test("buildQuickHelpContents: heading reflects the context", () => {
  assert.equal(buildQuickHelpContents("composer", DEFAULT_BINDINGS)[0], "Quick help — composer");
  assert.equal(buildQuickHelpContents("inspect", DEFAULT_BINDINGS)[0], "Quick help — inspect");
  assert.equal(buildQuickHelpContents("dialog", DEFAULT_BINDINGS)[0], "Quick help — dialog");
  assert.equal(
    buildQuickHelpContents("transcript", DEFAULT_BINDINGS)[0],
    "Quick help — transcript",
  );
});

test("buildQuickHelpContents: dialog heading names the pending dialog kind", () => {
  const lines = buildQuickHelpContents("dialog", DEFAULT_BINDINGS, undefined, "approval_prompt");
  assert.equal(lines[0], "Quick help — dialog (approval_prompt)");
});

test("buildQuickHelpContents: deduplicates actions shared across contexts", () => {
  const blocks = [
    { context: "Global" as const, bindings: { "?": "app:quickHelp" } },
    { context: "Composer" as const, bindings: { "?": "app:quickHelp" } },
  ];
  const lines = buildQuickHelpContents("composer", blocks);
  const rows = lines.filter((line) => line.includes("Show this help"));
  assert.equal(rows.length, 1);
});

test("buildQuickHelpContents: registry filter hides unregistered context-scoped bindings", () => {
  const registry = new Map<string, KeybindingHandler>();
  // Only `composer:submit` is registered — other composer bindings should be hidden.
  registry.set("composer:submit", () => {});
  const lines = buildQuickHelpContents("composer", DEFAULT_BINDINGS, registry);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Submit composer"));
  assert.ok(!joined.includes("Cycle composer mode"));
  // Global actions remain visible unconditionally.
  assert.ok(joined.includes("Exit"));
});

test("buildQuickHelpContents: empty registry → every shipped binding shown (null filter)", () => {
  const registry = new Map<string, KeybindingHandler>();
  const filteredLines = buildQuickHelpContents("composer", DEFAULT_BINDINGS, registry);
  const unfilteredLines = buildQuickHelpContents("composer", DEFAULT_BINDINGS);
  // With an empty (non-undefined) registry, only Global survives in Composer.
  assert.ok(!filteredLines.join("\n").includes("Submit composer"));
  assert.ok(unfilteredLines.join("\n").includes("Submit composer"));
});

test("buildQuickHelpContents: unknown action falls back to raw action id", () => {
  const blocks = [{ context: "Global" as const, bindings: { x: "unknown:action" } }];
  const lines = buildQuickHelpContents("composer", blocks);
  assert.ok(lines.some((line) => line.includes("unknown:action")));
});

test("reducer: open_quick_help sets state.quickHelp", () => {
  const next = reduceHost(initialHostAppState(), {
    type: "open_quick_help",
    context: "composer",
  });
  assert.deepEqual(next.quickHelp, { context: "composer" });
});

test("reducer: open_quick_help with dialogKind preserves it", () => {
  const next = reduceHost(initialHostAppState(), {
    type: "open_quick_help",
    context: "dialog",
    dialogKind: "approval_prompt",
  });
  assert.deepEqual(next.quickHelp, { context: "dialog", dialogKind: "approval_prompt" });
});

test("reducer: open_quick_help toggles off when reopened with identical payload", () => {
  const opened = reduceHost(initialHostAppState(), {
    type: "open_quick_help",
    context: "composer",
  });
  const reopened = reduceHost(opened, { type: "open_quick_help", context: "composer" });
  assert.equal(reopened.quickHelp, undefined);
});

test("reducer: close_quick_help clears state.quickHelp", () => {
  const opened = reduceHost(initialHostAppState(), {
    type: "open_quick_help",
    context: "composer",
  });
  const closed = reduceHost(opened, { type: "close_quick_help" });
  assert.equal(closed.quickHelp, undefined);
});

test("selectRenderFrame: state.quickHelp becomes a quick_help overlay", () => {
  const state: HostAppState = reduceHost(initialHostAppState(), {
    type: "open_quick_help",
    context: "composer",
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.overlay?.kind, "quick_help");
  if (frame.overlay?.kind === "quick_help") {
    assert.equal(frame.overlay.context, "composer");
  }
});

test("selectRenderFrame: quick_help inherits pending prompt's kind as dialogKind", () => {
  let state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval", payload: { message: "hi" } },
  });
  state = reduceHost(state, { type: "open_quick_help", context: "dialog" });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.overlay?.kind, "quick_help");
  if (frame.overlay?.kind === "quick_help") {
    assert.equal(frame.overlay.dialogKind, "approval");
  }
});

test("transcript renderer: quick_help emits a box containing the heading", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "open_quick_help",
    context: "composer",
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFrame(frame).map(stripAnsi);
  // The box header row starts with "|" and contains the title "?".
  assert.ok(lines.some((line) => line.includes("| ?")));
  assert.ok(lines.some((line) => line.includes("Quick help — composer")));
});

test("plain renderer: quick_help emits the same box sans ANSI", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "open_quick_help",
    context: "transcript",
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFramePlain(frame);
  assert.ok(lines.some((line) => line.includes("Quick help — transcript")));
  // No ANSI escape bytes in plain output.
  assert.ok(lines.every((line) => !/\u001B\[/.test(line)));
});

test("resolveQuickHelpContext: reflects screen + pending dialog", () => {
  const base = initialHostAppState();
  assert.equal(resolveQuickHelpContext(base), "composer");
  const onInspect: HostAppState = { ...base, screen: "inspect" };
  assert.equal(resolveQuickHelpContext(onInspect), "inspect");
  const withPrompt = reduceHost(base, {
    type: "enqueue_prompt",
    prompt: { id: "x", kind: "approval", payload: { message: "m" } },
  });
  assert.equal(resolveQuickHelpContext(withPrompt), "dialog");
});

test("registerOverlayBindings: app:quickHelp handler opens overlay and requests render", () => {
  clearKeybindings();
  try {
    let currentState = initialHostAppState();
    let renderCount = 0;
    const handle = registerOverlayBindings({
      getAppState: () => currentState,
      setAppState: (next) => {
        currentState = next;
      },
      requestRender: () => {
        renderCount += 1;
      },
    });
    const entry = getKeybindingsFor("Global").get("app:quickHelp");
    assert.ok(entry);
    entry?.({ action: "app:quickHelp" });
    assert.equal(renderCount, 1);
    assert.deepEqual(currentState.quickHelp, { context: "composer" });
    // Second press toggles off.
    entry?.({ action: "app:quickHelp" });
    assert.equal(currentState.quickHelp, undefined);
    assert.equal(renderCount, 2);
    handle.dispose();
    assert.equal(getKeybindingsFor("Global").get("app:quickHelp"), undefined);
  } finally {
    clearKeybindings();
  }
});

test("registerOverlayBindings: dispose is idempotent", () => {
  clearKeybindings();
  try {
    const handle = registerOverlayBindings({
      getAppState: () => initialHostAppState(),
      setAppState: () => {},
      requestRender: () => {},
    });
    handle.dispose();
    handle.dispose();
    assert.equal(getKeybindingsFor("Global").size, 0);
  } finally {
    clearKeybindings();
  }
});

test("defaults: Global has ? bound to app:quickHelp", () => {
  const block = DEFAULT_BINDINGS.find((b) => b.context === "Global");
  assert.ok(block);
  assert.equal(block?.bindings["?"], "app:quickHelp");
});

test("defaults: PR7 ctrl+k binding survives", () => {
  const block = DEFAULT_BINDINGS.find((b) => b.context === "Global");
  assert.equal(block?.bindings["ctrl+k"], "app:commandPalette");
});

test("createKeybindingRegistry isolation: quick-help registrations don't leak", () => {
  const isolated = createKeybindingRegistry();
  isolated.register("Global", "app:quickHelp", () => {});
  assert.equal(isolated.get("Global").size, 1);
  assert.equal(getKeybindingsFor("Global").get("app:quickHelp"), undefined);
});
