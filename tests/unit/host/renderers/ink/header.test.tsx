import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Header } from "../../../../../src/host/renderers/ink/Header.js";

test("Header: shows title, mode chip, session label", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Header repoLabel="bakudo" />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /Bakudo/);
  assert.match(frame, /STD/);
  assert.match(frame, /new session/);
  assert.match(frame, /bakudo/);
});

test("Header: mode chip reflects composer.mode", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "set_mode", mode: "plan" });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Header />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /PLAN/);
});
