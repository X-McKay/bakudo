/**
 * Phase 5 PR7 — command-palette launcher round-trip, cancel, and fuzzy
 * filter coverage. Mirrors the shape of `dialogLauncher.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import { createCommandRegistry } from "../../src/host/commandRegistry.js";
import {
  answerCommandPaletteDialog,
  buildCommandPaletteItems,
  launchCommandPaletteDialog,
} from "../../src/host/launchCommandPaletteDialog.js";
import type { DialogDispatcher } from "../../src/host/dialogLauncher.js";
import {
  cancelPrompt,
  pendingPromptIds,
  resetPromptResolvers,
} from "../../src/host/promptResolvers.js";
import { reduceHost } from "../../src/host/reducer.js";

const makeDispatcher = (): DialogDispatcher => {
  let state: HostAppState = initialHostAppState();
  return {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
};

const buildRegistry = () => {
  const registry = createCommandRegistry();
  registry.register({
    name: "alpha",
    description: "first command",
    handler: () => {},
  });
  registry.register({
    name: "beta",
    description: "second command",
    handler: () => {},
  });
  registry.register({
    name: "charlie",
    description: "third command",
    handler: () => {},
  });
  registry.register({
    name: "hidden",
    description: "not shown",
    hidden: true,
    handler: () => {},
  });
  return registry;
};

test("buildCommandPaletteItems: alphabetical + hidden entries excluded", () => {
  const registry = buildRegistry();
  const items = buildCommandPaletteItems(registry, initialHostAppState());
  assert.deepEqual(
    items.map((item) => item.name),
    ["alpha", "beta", "charlie"],
  );
});

test("launchCommandPaletteDialog: resolves with commandName when answered", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const registry = buildRegistry();
  const pending = launchCommandPaletteDialog(dispatcher, registry);
  await Promise.resolve();
  const id = answerCommandPaletteDialog(dispatcher, "beta");
  assert.ok(id !== null);
  const choice = await pending;
  assert.notEqual(choice, "cancel");
  if (choice !== "cancel") {
    assert.equal(choice.commandName, "beta");
  }
  assert.equal(dispatcher.getState().promptQueue.length, 0);
});

test("launchCommandPaletteDialog: resolves with cancel when the prompt is cancelled", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const registry = buildRegistry();
  const pending = launchCommandPaletteDialog(dispatcher, registry);
  await Promise.resolve();
  const head = dispatcher.getState().promptQueue[0];
  assert.ok(head !== undefined);
  if (head !== undefined) {
    cancelPrompt(head.id);
  }
  const choice = await pending;
  assert.equal(choice, "cancel");
  assert.equal(dispatcher.getState().promptQueue.length, 0);
});

test("launchCommandPaletteDialog: empty answer treated as cancel", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const registry = buildRegistry();
  const pending = launchCommandPaletteDialog(dispatcher, registry);
  await Promise.resolve();
  answerCommandPaletteDialog(dispatcher, "");
  const choice = await pending;
  assert.equal(choice, "cancel");
});

test("launchCommandPaletteDialog: enqueues command_palette entry with items", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const registry = buildRegistry();
  const pending = launchCommandPaletteDialog(dispatcher, registry);
  await Promise.resolve();
  const head = dispatcher.getState().promptQueue[0];
  assert.equal(head?.kind, "command_palette");
  const payload = head?.payload as { items: Array<{ name: string }>; input: string };
  assert.equal(payload.input, "");
  assert.deepEqual(
    payload.items.map((item) => item.name),
    ["alpha", "beta", "charlie"],
  );
  answerCommandPaletteDialog(dispatcher, "alpha");
  await pending;
});

test("reducer: palette_input_change updates input and resets selection", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: {
        items: [
          { name: "alpha", description: "" },
          { name: "beta", description: "" },
          { name: "charlie", description: "" },
        ],
        input: "",
        selectedIndex: 2,
      },
    },
  });
  const updated = reduceHost(enqueued, {
    type: "palette_input_change",
    id: "p1",
    input: "be",
  });
  const head = updated.promptQueue[0];
  const payload = head?.payload as { input: string; selectedIndex: number };
  assert.equal(payload.input, "be");
  assert.equal(payload.selectedIndex, 0);
});

test("reducer: palette_select_next wraps past the last filtered row", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: {
        items: [
          { name: "alpha", description: "" },
          { name: "beta", description: "" },
        ],
        input: "",
        selectedIndex: 1,
      },
    },
  });
  const next = reduceHost(enqueued, { type: "palette_select_next", id: "p1" });
  const head = next.promptQueue[0];
  const payload = head?.payload as { selectedIndex: number };
  assert.equal(payload.selectedIndex, 0);
});

test("reducer: palette_select_prev wraps to the last filtered row", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: {
        items: [
          { name: "alpha", description: "" },
          { name: "beta", description: "" },
          { name: "charlie", description: "" },
        ],
        input: "",
        selectedIndex: 0,
      },
    },
  });
  const prev = reduceHost(enqueued, { type: "palette_select_prev", id: "p1" });
  const payload = prev.promptQueue[0]?.payload as { selectedIndex: number };
  assert.equal(payload.selectedIndex, 2);
});

test("reducer: palette_select_next respects filter (no-op when filter yields zero rows)", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: {
        items: [{ name: "alpha", description: "" }],
        input: "zzz",
        selectedIndex: 0,
      },
    },
  });
  const next = reduceHost(enqueued, { type: "palette_select_next", id: "p1" });
  const payload = next.promptQueue[0]?.payload as { selectedIndex: number };
  assert.equal(payload.selectedIndex, 0);
});

test("reducer: palette actions are no-ops for non-matching ids", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: {
        items: [{ name: "alpha", description: "" }],
        input: "",
        selectedIndex: 0,
      },
    },
  });
  const next = reduceHost(enqueued, {
    type: "palette_input_change",
    id: "other",
    input: "x",
  });
  // Should return the original state (strict equality by reference when
  // nothing changed).
  assert.equal(next, enqueued);
});

test("launchCommandPaletteDialog: leaves no resolver behind after resolve", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const registry = buildRegistry();
  const pending = launchCommandPaletteDialog(dispatcher, registry);
  await Promise.resolve();
  answerCommandPaletteDialog(dispatcher, "alpha");
  await pending;
  assert.deepEqual(pendingPromptIds(), []);
});
