import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Footer } from "../../../../../src/host/renderers/ink/Footer.js";

test("Footer: default hints include /-commands, ? help, Ctrl+C exit", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\[\/\] commands/);
  assert.match(frame, /\[\?\] help/);
  assert.match(frame, /\[Ctrl\+C\] exit/);
});

test("Footer: shows /-commands + ? + Ctrl+C hints in idle state", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\[\/\] commands/);
  assert.match(frame, /\[\?\] help/);
  assert.match(frame, /\[Ctrl\+C\] exit/);
});

test("Footer: shows context placeholder", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /context —%/);
});
