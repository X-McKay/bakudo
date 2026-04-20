import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Footer } from "../../../../../src/host/renderers/ink/Footer.js";

test("Footer: default hints include new, resume, help", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\[new\]/);
  assert.match(frame, /\[resume\]/);
  assert.match(frame, /\[help\]/);
});
