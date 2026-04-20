import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Composer } from "../../../../../src/host/renderers/ink/Composer.js";

test("Composer: typed chars appear in the rendered frame", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin, lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("hello");
  // Ink's render commit is async; one microtask is enough to flush the frame.
  await new Promise((r) => setTimeout(r, 10));
  assert.match(lastFrame() ?? "", /hello/);
});

test("Composer: Enter dispatches submit with typed text", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("/version");
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getSnapshot().pendingSubmit?.text, "/version");
});

test("Composer: empty Enter does NOT dispatch submit", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getSnapshot().pendingSubmit, undefined);
});

test("Composer: dispatch_inflight disables text entry and shows label", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "dispatch_started", label: "Routing", startedAt: 1000 });
  const { stdin, lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("ignored");
  assert.doesNotMatch(lastFrame() ?? "", /ignored/);
  assert.match(lastFrame() ?? "", /Routing/);
});
