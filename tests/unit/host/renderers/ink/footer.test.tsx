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

test("Footer: shows em-dash when no provider is set", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  // composer.provider is "" in the initial state, so the footer shows an em-dash.
  assert.match(lastFrame() ?? "", /—/);
});

test("Footer: shows provider ID when composer.provider is set", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "set_composer_metadata", provider: "claude-code" });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /claude-code/);
});

test("Footer: shows recovery_dialog hints when overlay is active", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({
    type: "enqueue_prompt",
    prompt: {
      id: "p-1",
      kind: "recovery_dialog",
      payload: { sessionId: "s1", turnId: "t1", reason: "chaos monkey rejected" },
    },
  });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Footer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\[r\] retry/);
  assert.match(frame, /\[h\] halt/);
  assert.match(frame, /\[e\] edit/);
});
