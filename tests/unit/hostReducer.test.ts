import test from "node:test";
import assert from "node:assert/strict";

import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";

test("reducer: set_mode updates composer.mode and preserves rest of state", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "set_mode", mode: "plan" });
  assert.equal(next.composer.mode, "plan");
  assert.equal(next.composer.autoApprove, false);
  assert.equal(next.screen, "transcript");
  assert.notStrictEqual(next, state);
});

test("reducer: set_mode returns same reference when mode already matches", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "set_mode", mode: "standard" });
  assert.strictEqual(next, state);
});

test("reducer: set_mode autopilot derives autoApprove=true", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "set_mode", mode: "autopilot" });
  assert.equal(next.composer.mode, "autopilot");
  assert.equal(next.composer.autoApprove, true);
});

test("reducer: cycle_mode cycles standard -> plan -> autopilot -> standard", () => {
  const s0 = initialHostAppState();
  assert.equal(s0.composer.mode, "standard");
  const s1 = reduceHost(s0, { type: "cycle_mode" });
  assert.equal(s1.composer.mode, "plan");
  const s2 = reduceHost(s1, { type: "cycle_mode" });
  assert.equal(s2.composer.mode, "autopilot");
  assert.equal(s2.composer.autoApprove, true);
  const s3 = reduceHost(s2, { type: "cycle_mode" });
  assert.equal(s3.composer.mode, "standard");
  assert.equal(s3.composer.autoApprove, false);
});

test("reducer: set_auto_approve is a no-op (derived from mode) but emits a notice", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "set_auto_approve", value: true });
  assert.equal(next.composer.autoApprove, false);
  assert.equal(next.notices.length, 1);
  assert.match(next.notices[0]!, /set_auto_approve ignored/);
});

test("reducer: set_composer_text and clear_composer_text mutate only composer.text", () => {
  const state = initialHostAppState();
  const typed = reduceHost(state, { type: "set_composer_text", text: "hello" });
  assert.equal(typed.composer.text, "hello");
  const cleared = reduceHost(typed, { type: "clear_composer_text" });
  assert.equal(cleared.composer.text, "");
  assert.equal(cleared.composer.mode, "standard");
});

test("reducer: set_active_session assigns id and turn", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, {
    type: "set_active_session",
    sessionId: "session-abc",
    turnId: "turn-1",
  });
  assert.equal(next.activeSessionId, "session-abc");
  assert.equal(next.activeTurnId, "turn-1");
});

test("reducer: set_active_session with undefined sessionId clears both id and turn", () => {
  const seeded = reduceHost(initialHostAppState(), {
    type: "set_active_session",
    sessionId: "session-abc",
    turnId: "turn-1",
  });
  const cleared = reduceHost(seeded, { type: "set_active_session", sessionId: undefined });
  assert.equal(cleared.activeSessionId, undefined);
  assert.equal(cleared.activeTurnId, undefined);
});

test("reducer: set_screen changes screen only", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "set_screen", screen: "inspect" });
  assert.equal(next.screen, "inspect");
  assert.equal(next.composer.mode, state.composer.mode);
});

test("reducer: set_inspect_target updates provided fields and preserves tab when omitted", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, {
    type: "set_inspect_target",
    sessionId: "s1",
    turnId: "t1",
    attemptId: "a1",
  });
  assert.equal(next.inspect.sessionId, "s1");
  assert.equal(next.inspect.turnId, "t1");
  assert.equal(next.inspect.attemptId, "a1");
  assert.equal(next.inspect.tab, "summary");
  const tabbed = reduceHost(next, { type: "set_inspect_target", tab: "logs" });
  assert.equal(tabbed.inspect.tab, "logs");
  assert.equal(tabbed.inspect.sessionId, "s1");
});

test("reducer: open_overlay and close_overlay set and clear overlay", () => {
  const state = initialHostAppState();
  const opened = reduceHost(state, {
    type: "open_overlay",
    overlay: { kind: "approval", message: "go?" },
  });
  assert.deepEqual(opened.overlay, { kind: "approval", message: "go?" });
  const reopen = reduceHost(opened, { type: "open_overlay", overlay: { kind: "command_palette" } });
  assert.deepEqual(reopen.overlay, { kind: "command_palette" });
  const closed = reduceHost(reopen, { type: "close_overlay" });
  assert.equal(closed.overlay, undefined);
});

test("reducer: push_notice appends and clear_notices empties", () => {
  const state = initialHostAppState();
  const a = reduceHost(state, { type: "push_notice", notice: "one" });
  const b = reduceHost(a, { type: "push_notice", notice: "two" });
  assert.deepEqual(b.notices, ["one", "two"]);
  const cleared = reduceHost(b, { type: "clear_notices" });
  assert.deepEqual(cleared.notices, []);
});

test("reducer: does not mutate a frozen input state", () => {
  const state = initialHostAppState();
  Object.freeze(state);
  Object.freeze(state.composer);
  Object.freeze(state.inspect);
  Object.freeze(state.notices);
  const next = reduceHost(state, { type: "set_mode", mode: "plan" });
  assert.equal(state.composer.mode, "standard");
  assert.equal(next.composer.mode, "plan");
});

test("reducer: unrelated action leaves seeded session fields intact", () => {
  const base = initialHostAppState();
  const seeded: HostAppState = reduceHost(base, {
    type: "set_active_session",
    sessionId: "s42",
    turnId: "t42",
  });
  const next = reduceHost(seeded, { type: "push_notice", notice: "hey" });
  assert.equal(next.activeSessionId, "s42");
  assert.equal(next.activeTurnId, "t42");
  assert.deepEqual(next.notices, ["hey"]);
});

test("reducer: clear_notices on empty list returns same reference", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "clear_notices" });
  assert.strictEqual(next, state);
});
