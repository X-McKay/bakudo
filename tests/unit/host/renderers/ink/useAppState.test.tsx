import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { useAppState } from "../../../../../src/host/renderers/ink/hooks/useAppState.js";

test("useAppState: reads initial state slice", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const Probe = () => <Text>{useAppState((s) => s.screen)}</Text>;
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Probe />
    </StoreProvider>,
  );
  assert.equal(lastFrame(), "transcript");
});

test("useAppState: re-renders on dispatch", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const Probe = () => <Text>{useAppState((s) => s.transcript.length.toString())}</Text>;
  const { lastFrame, rerender } = render(
    <StoreProvider store={store}>
      <Probe />
    </StoreProvider>,
  );
  assert.equal(lastFrame(), "0");
  store.dispatch({ type: "append_user", text: "hi" });
  // Give react a microtask to flush.
  rerender(
    <StoreProvider store={store}>
      <Probe />
    </StoreProvider>,
  );
  assert.equal(lastFrame(), "1");
});
