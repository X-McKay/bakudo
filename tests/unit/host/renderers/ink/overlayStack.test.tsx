import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { clearKeybindings, registerKeybinding } from "../../../../../src/host/keybindings/hooks.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { OverlayStack } from "../../../../../src/host/renderers/ink/OverlayStack.js";

test("OverlayStack: renders nothing when no overlay", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <OverlayStack />
    </StoreProvider>,
  );
  assert.equal((lastFrame() ?? "").trim(), "");
});

test("OverlayStack: renders quick_help overlay when set", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "open_quick_help", context: "composer" });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <OverlayStack />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /help|\?/i);
});

test("OverlayStack: quick_help respects registered composer bindings", () => {
  clearKeybindings();
  try {
    registerKeybinding("Composer", "composer:submit", () => {});
    const store = createHostStore(reduceHost, initialHostAppState());
    store.dispatch({ type: "open_quick_help", context: "composer" });
    const { lastFrame } = render(
      <StoreProvider store={store}>
        <OverlayStack />
      </StoreProvider>,
    );
    const frame = lastFrame() ?? "";
    assert.match(frame, /Submit composer/);
    assert.match(frame, /Exit/);
    assert.doesNotMatch(frame, /Cycle composer mode/);
  } finally {
    clearKeybindings();
  }
});
test("OverlayStack: renders recovery_dialog overlay with turn ID, reason, and keybinding hints", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({
    type: "enqueue_prompt",
    prompt: {
      id: "rec-overlay-1",
      kind: "recovery_dialog",
      payload: {
        sessionId: "session-abc",
        turnId: "turn-xyz",
        reason: "Chaos monkey rejected: missing test coverage",
      },
    },
  });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <OverlayStack />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  // Title and turn ID
  assert.match(frame, /Attempt failed/i);
  assert.match(frame, /turn-xyz/);
  // Failure reason
  assert.match(frame, /Chaos monkey rejected/);
  // Keybinding hints
  assert.match(frame, /\[r\] retry/);
  assert.match(frame, /\[h\] halt/);
  assert.match(frame, /\[e\] edit/);
});

test("OverlayStack: recovery_dialog overlay shows Ctrl+C exit hint", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({
    type: "enqueue_prompt",
    prompt: {
      id: "rec-overlay-2",
      kind: "recovery_dialog",
      payload: {
        sessionId: "session-abc",
        turnId: "turn-xyz",
        reason: "Worker timed out",
      },
    },
  });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <OverlayStack />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /Ctrl\+C/);
});
