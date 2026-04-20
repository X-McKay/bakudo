import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { TurnDriver } from "../../../../../src/host/renderers/ink/TurnDriver.js";

test("TurnDriver: on pendingSubmit, runs handler and clears submit", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const seen: string[] = [];
  const runTurn = async (text: string) => {
    seen.push(text);
  };
  render(
    <StoreProvider store={store}>
      <TurnDriver runTurn={runTurn} />
    </StoreProvider>,
  );
  store.dispatch({ type: "submit", text: "hello" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ["hello"]);
  assert.equal(store.getSnapshot().pendingSubmit, undefined);
});

test("TurnDriver: runTurn error appends an assistant error message", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const runTurn = async () => {
    throw new Error("boom");
  };
  render(
    <StoreProvider store={store}>
      <TurnDriver runTurn={runTurn} />
    </StoreProvider>,
  );
  store.dispatch({ type: "submit", text: "oops" });
  await new Promise((r) => setTimeout(r, 20));
  const last = store.getSnapshot().transcript.at(-1);
  assert.equal(last?.kind, "assistant");
  if (last?.kind === "assistant") assert.match(last.text, /Error: boom/);
});

test("TurnDriver: AbortError does not append an assistant error message", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const runTurn = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  render(
    <StoreProvider store={store}>
      <TurnDriver runTurn={runTurn} />
    </StoreProvider>,
  );
  store.dispatch({ type: "submit", text: "oops" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getSnapshot().transcript.length, 0);
  assert.equal(store.getSnapshot().pendingSubmit, undefined);
});
