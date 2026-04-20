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

test("reducer: enqueue_prompt / dequeue_prompt / cancel_prompt manage promptQueue", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval", payload: { message: "go?" } },
  });
  assert.equal(enqueued.promptQueue.length, 1);
  assert.equal(enqueued.promptQueue[0]?.kind, "approval");

  const second = reduceHost(enqueued, {
    type: "enqueue_prompt",
    prompt: { id: "p2", kind: "resume_confirm", payload: { message: "swap?" } },
  });
  assert.equal(second.promptQueue.length, 2);

  const cancelled = reduceHost(second, { type: "cancel_prompt" });
  assert.equal(cancelled.promptQueue.length, 1);
  assert.equal(cancelled.promptQueue[0]?.id, "p2");

  const dequeued = reduceHost(cancelled, { type: "dequeue_prompt", id: "p2" });
  assert.equal(dequeued.promptQueue.length, 0);
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

test("reducer: append_user adds a user transcript item", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_user", text: "hi" });
  assert.deepEqual(s1.transcript, [{ kind: "user", text: "hi" }]);
});

test("reducer: append_assistant adds an assistant item with tone", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_assistant", text: "done", tone: "success" });
  assert.deepEqual(s1.transcript, [{ kind: "assistant", text: "done", tone: "success" }]);
});

test("reducer: append_event adds an event item", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_event", label: "version", detail: "bakudo 0.2.0" });
  assert.deepEqual(s1.transcript, [{ kind: "event", label: "version", detail: "bakudo 0.2.0" }]);
});

test("reducer: append_output adds an output block", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_output", text: "line1\nline2" });
  assert.deepEqual(s1.transcript, [{ kind: "output", text: "line1\nline2" }]);
});

test("reducer: append_review adds a review card", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, {
    type: "append_review",
    outcome: "success",
    summary: "ok",
    nextAction: "continue",
  });
  assert.deepEqual(s1.transcript, [
    { kind: "review", outcome: "success", summary: "ok", nextAction: "continue" },
  ]);
});

test("reducer: clear_transcript empties the transcript", () => {
  const s0 = reduceHost(initialHostAppState(), { type: "append_user", text: "hi" });
  const s1 = reduceHost(s0, { type: "clear_transcript" });
  assert.deepEqual(s1.transcript, []);
});

test("reducer: clear_transcript is referentially stable when already empty", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "clear_transcript" });
  assert.strictEqual(s1, s0);
});

test("reducer: dispatch_started sets inflight with label", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "dispatch_started", label: "Routing", startedAt: 1000 });
  assert.equal(s1.dispatch.inFlight, true);
  if (s1.dispatch.inFlight) {
    assert.equal(s1.dispatch.label, "Routing");
    assert.equal(s1.dispatch.startedAt, 1000);
  }
});

test("reducer: dispatch_progress updates detail without clearing", () => {
  const s0 = reduceHost(initialHostAppState(), {
    type: "dispatch_started",
    label: "Working",
    startedAt: 1000,
  });
  const s1 = reduceHost(s0, { type: "dispatch_progress", detail: "compiling" });
  assert.equal(s1.dispatch.inFlight, true);
  if (s1.dispatch.inFlight) {
    assert.equal(s1.dispatch.detail, "compiling");
    assert.equal(s1.dispatch.label, "Working");
  }
});

test("reducer: dispatch_finished resets to idle", () => {
  const s0 = reduceHost(initialHostAppState(), {
    type: "dispatch_started",
    label: "Routing",
    startedAt: 1000,
  });
  const s1 = reduceHost(s0, { type: "dispatch_finished" });
  assert.deepEqual(s1.dispatch, { inFlight: false });
});

test("reducer: submit sets pendingSubmit with monotonic seq", () => {
  const s0 = initialHostAppState();
  assert.equal(s0.submitSeq, 0);
  const s1 = reduceHost(s0, { type: "submit", text: "hello" });
  assert.equal(s1.submitSeq, 1);
  assert.equal(s1.pendingSubmit?.text, "hello");
  assert.equal(s1.pendingSubmit?.seq, 1);
  const s2 = reduceHost(s1, { type: "submit", text: "again" });
  assert.equal(s2.submitSeq, 2);
  assert.equal(s2.pendingSubmit?.seq, 2);
});

test("reducer: clear_pending_submit unsets pendingSubmit", () => {
  const s0 = reduceHost(initialHostAppState(), { type: "submit", text: "x" });
  const s1 = reduceHost(s0, { type: "clear_pending_submit" });
  assert.equal(s1.pendingSubmit, undefined);
});

test("reducer: clear_pending_submit is referentially stable when already clear", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "clear_pending_submit" });
  assert.strictEqual(s1, s0);
});

test("reducer: request_exit sets shouldExit", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "request_exit", code: 0 });
  assert.deepEqual(s1.shouldExit, { code: 0 });
});

test("reducer: set_composer_metadata updates model/agent/provider", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, {
    type: "set_composer_metadata",
    model: "sonnet-4.6",
    agent: "default",
    provider: "claude",
  });
  assert.equal(s1.composer.model, "sonnet-4.6");
  assert.equal(s1.composer.agent, "default");
  assert.equal(s1.composer.provider, "claude");
});

test("reducer: replace_state swaps the full state", () => {
  const s0 = initialHostAppState();
  const s1 = reduceHost(s0, { type: "append_user", text: "x" });
  const sReplaced = reduceHost(s0, { type: "replace_state", state: s1 });
  assert.strictEqual(sReplaced, s1); // same reference
});
