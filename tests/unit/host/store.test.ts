import assert from "node:assert/strict";
import test from "node:test";
import { initialHostAppState } from "../../../src/host/appState.js";
import { reduceHost } from "../../../src/host/reducer.js";
import { createHostStore } from "../../../src/host/store/index.js";

test("createHostStore: getSnapshot returns initial state", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  assert.equal(store.getSnapshot().screen, "transcript");
});

test("createHostStore: dispatch advances state via reducer", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "append_user", text: "hi" });
  assert.deepEqual(store.getSnapshot().transcript, [{ kind: "user", text: "hi" }]);
});

test("createHostStore: subscribe fires on state change", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });
  store.dispatch({ type: "append_user", text: "hi" });
  store.dispatch({ type: "append_user", text: "bye" });
  assert.equal(calls, 2);
  unsubscribe();
  store.dispatch({ type: "append_user", text: "ignored" });
  assert.equal(calls, 2);
});

test("createHostStore: getSnapshot returns same reference when no change", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const first = store.getSnapshot();
  // Dispatch an action that doesn't change state (unknown-but-typed path).
  // `clear_notices` on empty notices yields an equal-shape but new object;
  // use a no-op: dispatch_progress with no inflight returns state unchanged.
  store.dispatch({ type: "dispatch_progress", detail: "x" });
  assert.strictEqual(store.getSnapshot(), first);
});
