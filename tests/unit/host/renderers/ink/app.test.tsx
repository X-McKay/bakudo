import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { App } from "../../../../../src/host/renderers/ink/App.js";

test("App: mounts without throwing, shows Bakudo + prompt", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = render(<App store={store} repoLabel="tmp" />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /Bakudo/);
  assert.match(frame, /┃/);
});

test("App: transcript updates on dispatch", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame, rerender } = render(<App store={store} repoLabel="tmp" />);
  assert.doesNotMatch(lastFrame() ?? "", /hello/);
  store.dispatch({ type: "append_user", text: "hello" });
  rerender(<App store={store} repoLabel="tmp" />);
  assert.match(lastFrame() ?? "", /hello/);
});
