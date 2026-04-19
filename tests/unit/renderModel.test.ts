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

test("selectRenderFrame: frame.mode is transcript when promptQueue is non-empty", () => {
  // Phase 5 PR7 — palette overlay carries a structured payload (items,
  // input, selectedIndex) instead of being a shape-less sentinel. Use the
  // minimal well-formed request so the renderModel projection stays a pure
  // pass-through of the payload fields.
  const state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "command_palette",
      payload: { items: [], input: "", selectedIndex: 0 },
    },
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.mode, "transcript");
  assert.deepEqual(frame.overlay, {
    kind: "command_palette",
    request: { items: [], input: "", selectedIndex: 0 },
  });
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

test("selectRenderFrame: footer hints always include core navigation hints", () => {
  const idle = selectRenderFrame({ state: initialHostAppState(), transcript: [] });
  // Core hints always present
  assert.ok(idle.footer.hints.includes("[Tab] mode"));
  assert.ok(idle.footer.hints.includes("[?] help"));
  assert.ok(idle.footer.hints.includes("[Ctrl+C] exit"));
  // No session-specific hints when idle
  assert.ok(!idle.footer.hints.some((h) => h.includes("inspect")));
  const active = selectRenderFrame({
    state: reduceHost(initialHostAppState(), {
      type: "set_active_session",
      sessionId: "session-x",
    }),
    transcript: [],
  });
  // Session-specific hints appear when a session is active
  assert.ok(active.footer.hints.some((h) => h.includes("inspect")));
  assert.ok(active.footer.hints.some((h) => h.includes("review")));
  // Core hints still present
  assert.ok(active.footer.hints.includes("[Tab] mode"));
});

test("selectRenderFrame: composer fields mirror state", () => {
  const planned = reduceHost(initialHostAppState(), { type: "set_mode", mode: "plan" });
  const frame = selectRenderFrame({ state: planned, transcript: [] });
  assert.equal(frame.composer.mode, "plan");
  assert.equal(frame.composer.autoApprove, false);
  assert.equal(frame.composer.placeholder, "");
  assert.equal(frame.header.mode, "plan");
});

test("selectRenderFrame: composer.autoApprove reflects autopilot mode", () => {
  const auto = reduceHost(initialHostAppState(), { type: "set_mode", mode: "autopilot" });
  const frame = selectRenderFrame({ state: auto, transcript: [] });
  assert.equal(frame.composer.mode, "autopilot");
  assert.equal(frame.composer.autoApprove, true);
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
    { kind: "output" as const, text: "alpha\nbeta" },
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
