import assert from "node:assert/strict";
import test from "node:test";

import { deriveAutoApprove, initialHostAppState } from "../../src/host/appState.js";
import { composerModeToTaskMode } from "../../src/host/orchestration.js";
import { reduceHost } from "../../src/host/reducer.js";

test("composer default mode is 'standard'", () => {
  const state = initialHostAppState();
  assert.equal(state.composer.mode, "standard");
  assert.equal(state.composer.autoApprove, false);
});

test("deriveAutoApprove: only true when mode === 'autopilot'", () => {
  assert.equal(deriveAutoApprove("standard"), false);
  assert.equal(deriveAutoApprove("plan"), false);
  assert.equal(deriveAutoApprove("autopilot"), true);
});

test("composerModeToTaskMode: plan stays plan, standard/autopilot → build", () => {
  assert.equal(composerModeToTaskMode("plan"), "plan");
  assert.equal(composerModeToTaskMode("standard"), "build");
  assert.equal(composerModeToTaskMode("autopilot"), "build");
  // legacy values pass through safely
  assert.equal(composerModeToTaskMode("build"), "build");
});

test("set_mode autopilot flips autoApprove to true; back to standard flips it false", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "set_mode", mode: "autopilot" });
  assert.equal(s1.composer.autoApprove, true);
  const s2 = reduceHost(s1, { type: "set_mode", mode: "standard" });
  assert.equal(s2.composer.autoApprove, false);
});
