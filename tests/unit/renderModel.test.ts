import test from "node:test";
import assert from "node:assert/strict";

import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";

test("selectRenderFrame: frame.mode is prompt on transcript screen with no overlay", () => {
  const state = initialHostAppState();
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.mode, "prompt");
});

test("selectRenderFrame: frame.mode is transcript when overlay is set", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "open_overlay",
    overlay: { kind: "command_palette" },
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.mode, "transcript");
});

test("selectRenderFrame: frame.mode is transcript when screen is inspect", () => {
  const state = reduceHost(initialHostAppState(), { type: "set_screen", screen: "inspect" });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.mode, "transcript");
});

test("selectRenderFrame: session label reflects activeSessionId prefix", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "set_active_session",
    sessionId: "abcdef0123456789",
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.header.sessionLabel, "session abcdef01");
});

test("selectRenderFrame: session label is placeholder when no active session", () => {
  const frame = selectRenderFrame({ state: initialHostAppState(), transcript: [] });
  assert.equal(frame.header.sessionLabel, "no active session");
});

test("selectRenderFrame: footer hints differ based on activeSessionId presence", () => {
  const idle = selectRenderFrame({ state: initialHostAppState(), transcript: [] });
  assert.deepEqual(idle.footer.hints, ["[help]"]);
  const active = selectRenderFrame({
    state: reduceHost(initialHostAppState(), {
      type: "set_active_session",
      sessionId: "session-x",
    }),
    transcript: [],
  });
  assert.deepEqual(active.footer.hints, ["[inspect]", "[help]"]);
});

test("selectRenderFrame: composer fields mirror state", () => {
  const state = reduceHost(reduceHost(initialHostAppState(), { type: "set_mode", mode: "plan" }), {
    type: "set_auto_approve",
    value: true,
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.composer.mode, "plan");
  assert.equal(frame.composer.autoApprove, true);
  assert.equal(frame.composer.placeholder, "");
  assert.equal(frame.header.mode, "plan");
});

test("selectRenderFrame: header includes repoLabel when provided", () => {
  const frame = selectRenderFrame({
    state: initialHostAppState(),
    transcript: [],
    repoLabel: "/tmp/repo",
  });
  assert.equal(frame.header.repoLabel, "/tmp/repo");
});

test("selectRenderFrame: transcript echoes input items unchanged", () => {
  const items = [
    { kind: "user" as const, text: "hi" },
    { kind: "assistant" as const, text: "ok", tone: "success" as const },
  ];
  const frame = selectRenderFrame({ state: initialHostAppState(), transcript: items });
  assert.deepEqual(frame.transcript, items);
});

test("selectRenderFrame: inspectPane is undefined in PR2", () => {
  const frame = selectRenderFrame({ state: initialHostAppState(), transcript: [] });
  assert.equal(frame.inspectPane, undefined);
});

test("selectRenderFrame: header title is always Bakudo", () => {
  const frame = selectRenderFrame({ state: initialHostAppState(), transcript: [] });
  assert.equal(frame.header.title, "Bakudo");
});
