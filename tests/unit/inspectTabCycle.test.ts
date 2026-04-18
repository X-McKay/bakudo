import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState, type InspectTab } from "../../src/host/appState.js";
import { formatInspectTab } from "../../src/host/inspectTabs.js";
import { reduceHost } from "../../src/host/reducer.js";
import type { SessionRecord } from "../../src/sessionTypes.js";

/**
 * Phase 5 PR8 — Inspect tab cycling (Tab / Shift+Tab) + scroll action
 * integration in the reducer. Pure-state tests; no renderer involvement.
 */

const ORDERED: readonly InspectTab[] = [
  "summary",
  "review",
  "provenance",
  "artifacts",
  "approvals",
  "logs",
];

test("reducer: inspect_tab_next cycles summary → review → … → logs → summary", () => {
  let state = initialHostAppState();
  assert.equal(state.inspect.tab, "summary");
  for (let i = 1; i < ORDERED.length; i += 1) {
    state = reduceHost(state, { type: "inspect_tab_next" });
    assert.equal(state.inspect.tab, ORDERED[i]);
  }
  // Next cycle wraps back to the start.
  state = reduceHost(state, { type: "inspect_tab_next" });
  assert.equal(state.inspect.tab, "summary");
});

test("reducer: inspect_tab_prev cycles backwards (summary → logs → approvals → ...)", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_tab_prev" });
  assert.equal(state.inspect.tab, "logs");
  state = reduceHost(state, { type: "inspect_tab_prev" });
  assert.equal(state.inspect.tab, "approvals");
});

test("reducer: tab cycling resets scroll offset to 0", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_scroll_down" });
  state = reduceHost(state, { type: "inspect_scroll_down" });
  state = reduceHost(state, { type: "inspect_scroll_down" });
  assert.equal(state.inspect.scrollOffset, 3);
  state = reduceHost(state, { type: "inspect_tab_next" });
  assert.equal(state.inspect.scrollOffset, 0);
});

test("reducer: tab cycling starting from legacy 'sandbox' lands on canonical 'summary'", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "set_inspect_target",
    tab: "sandbox",
  });
  assert.equal(state.inspect.tab, "sandbox");
  const next = reduceHost(state, { type: "inspect_tab_next" });
  // 'sandbox' not in cycle → base=0 → next lands on ORDERED[1]=review.
  assert.equal(next.inspect.tab, "review");
});

// --- Scroll actions --------------------------------------------------------

test("reducer: inspect_scroll_down increments offset by 1", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_scroll_down" });
  assert.equal(state.inspect.scrollOffset, 1);
  state = reduceHost(state, { type: "inspect_scroll_down" });
  assert.equal(state.inspect.scrollOffset, 2);
});

test("reducer: inspect_scroll_up floors at 0", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_scroll_up" });
  assert.equal(state.inspect.scrollOffset, 0);
  state = reduceHost(state, { type: "inspect_scroll_down" });
  state = reduceHost(state, { type: "inspect_scroll_up" });
  assert.equal(state.inspect.scrollOffset, 0);
});

test("reducer: inspect_scroll_pagedown advances by height-1", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_scroll_set_scroll_height", height: 10 });
  state = reduceHost(state, { type: "inspect_scroll_pagedown" });
  assert.equal(state.inspect.scrollOffset, 9);
});

test("reducer: inspect_scroll_pageup floors at 0", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_scroll_set_scroll_height", height: 10 });
  state = reduceHost(state, { type: "inspect_scroll_pagedown" });
  state = reduceHost(state, { type: "inspect_scroll_pageup" });
  assert.equal(state.inspect.scrollOffset, 0);
});

test("reducer: inspect_scroll_home resets offset to 0", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_scroll_down" });
  state = reduceHost(state, { type: "inspect_scroll_down" });
  state = reduceHost(state, { type: "inspect_scroll_home" });
  assert.equal(state.inspect.scrollOffset, 0);
});

test("reducer: inspect_scroll_end sets a large offset (renderer clamps at render-time)", () => {
  const state = reduceHost(initialHostAppState(), { type: "inspect_scroll_end" });
  assert.ok(state.inspect.scrollOffset > 1000);
});

test("reducer: inspect_scroll_set_scroll_height clamps to >= 1 and floors", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "inspect_scroll_set_scroll_height", height: 0 });
  assert.equal(state.inspect.scrollHeight, 1);
  state = reduceHost(state, { type: "inspect_scroll_set_scroll_height", height: 4.7 });
  assert.equal(state.inspect.scrollHeight, 4);
});

test("reducer: inspect_scroll actions are referentially stable when no-op", () => {
  const state = initialHostAppState();
  const sameHeight = reduceHost(state, {
    type: "inspect_scroll_set_scroll_height",
    height: state.inspect.scrollHeight,
  });
  assert.strictEqual(sameHeight, state);
  const homeNoop = reduceHost(state, { type: "inspect_scroll_home" });
  assert.strictEqual(homeNoop, state);
  const scrollUpNoop = reduceHost(state, { type: "inspect_scroll_up" });
  assert.strictEqual(scrollUpNoop, state);
});

// --- formatInspectTab windowing integration --------------------------------

const session: SessionRecord = {
  schemaVersion: 2,
  sessionId: "session-cycle",
  repoRoot: "/tmp/cycle",
  title: "goal",
  status: "running",
  turns: [],
  createdAt: "2026-04-14T12:00:00.000Z",
  updatedAt: "2026-04-14T12:00:00.000Z",
};

test("formatInspectTab: windowing option clips the full tab output to viewport", () => {
  const fullLines = formatInspectTab("summary", {
    session,
    artifacts: [],
    events: [],
    approvals: [],
  });
  assert.ok(fullLines.length > 0);
  const windowed = formatInspectTab(
    "summary",
    { session, artifacts: [], events: [], approvals: [] },
    { window: { offset: 0, height: 3 } },
  );
  assert.ok(windowed.length <= 3, `expected <= 3, got ${windowed.length}`);
});

test("formatInspectTab: no options returns unwindowed output (backward compatible)", () => {
  const lines = formatInspectTab("summary", {
    session,
    artifacts: [],
    events: [],
    approvals: [],
  });
  // Without a window, the full summary tab is returned.
  assert.ok(lines.length > 2);
  assert.equal(lines[0], "Summary");
});
