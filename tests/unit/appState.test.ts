import assert from "node:assert/strict";
import test from "node:test";
import { initialHostAppState } from "../../src/host/appState.js";

test("initialHostAppState: transcript starts empty", () => {
  const state = initialHostAppState();
  assert.deepEqual(state.transcript, []);
});

test("initialHostAppState: composer defaults include metadata fields", () => {
  const state = initialHostAppState();
  assert.equal(state.composer.model, "");
  assert.equal(state.composer.agent, "");
  assert.equal(state.composer.provider, "");
});

test("initialHostAppState: dispatch starts idle", () => {
  const state = initialHostAppState();
  assert.deepEqual(state.dispatch, { inFlight: false });
});

test("initialHostAppState: pendingSubmit and shouldExit are unset", () => {
  const state = initialHostAppState();
  assert.equal(state.pendingSubmit, undefined);
  assert.equal(state.shouldExit, undefined);
});
