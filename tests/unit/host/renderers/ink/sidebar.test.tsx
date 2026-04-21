import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Sidebar } from "../../../../../src/host/renderers/ink/Sidebar.js";
import type { Objective } from "../../../../../src/host/orchestration/objectiveState.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeObjective = (objectiveId: string, goal: string): Objective => ({
  objectiveId,
  goal,
  status: "active",
  campaigns: [],
  createdAt: "2026-01-01T00:00:00.000Z",
});

const renderSidebar = (store: ReturnType<typeof createHostStore>) =>
  render(
    <StoreProvider store={store}>
      <Sidebar />
    </StoreProvider>,
  );

// ---------------------------------------------------------------------------
// Hidden state
// ---------------------------------------------------------------------------

test("Sidebar: renders nothing when sidebarVisible is false (default)", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { lastFrame } = renderSidebar(store);
  // When hidden, the Sidebar returns null — the frame should be empty or
  // contain only whitespace.
  const frame = lastFrame() ?? "";
  assert.doesNotMatch(frame, /Orchestrator/);
});

// ---------------------------------------------------------------------------
// Visible state
// ---------------------------------------------------------------------------

test("Sidebar: renders header when toggled visible", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  const frame = lastFrame() ?? "";
  assert.match(frame, /Orchestrator/);
});

test("Sidebar: shows '(no active objective)' when objectives list is empty", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.match(lastFrame() ?? "", /no active objective/);
});

test("Sidebar: shows objective goal text when an objective is started", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const obj = makeObjective("obj-001", "refactor the reducer");
  store.dispatch({ type: "orchestrator_start", objective: obj });
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.match(lastFrame() ?? "", /refactor the reducer/);
});

test("Sidebar: shows objective status badge", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const obj = makeObjective("obj-001", "refactor the reducer");
  store.dispatch({ type: "orchestrator_start", objective: obj });
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.match(lastFrame() ?? "", /active/);
});

test("Sidebar: shows '(decomposing…)' when objective has no campaigns yet", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const obj = makeObjective("obj-001", "refactor the reducer");
  store.dispatch({ type: "orchestrator_start", objective: obj });
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.match(lastFrame() ?? "", /decomposing/);
});

test("Sidebar: shows campaign description when campaigns are present", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const obj: Objective = {
    ...makeObjective("obj-001", "refactor the reducer"),
    campaigns: [
      {
        campaignId: "c1",
        description: "extract approval logic",
        status: "running",
        candidateSet: null,
        needsManualReview: false,
      },
    ],
  };
  store.dispatch({ type: "orchestrator_start", objective: obj });
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.match(lastFrame() ?? "", /extract approval logic/);
});

test("Sidebar: shows git mutex as free by default", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.match(lastFrame() ?? "", /git mutex free/);
});

test("Sidebar: shows git mutex as locked when orchestrator_git_mutex locked=true", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "toggle_sidebar" });
  store.dispatch({ type: "orchestrator_git_mutex", locked: true });
  const { lastFrame, rerender } = renderSidebar(store);
  rerender(
    <StoreProvider store={store}>
      <Sidebar />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /git mutex locked/);
});

test("Sidebar: shows last verdict when orchestrator_verdict is dispatched", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "toggle_sidebar" });
  store.dispatch({ type: "orchestrator_verdict", verdict: "Synthesizer: merged c2" });
  const { lastFrame, rerender } = renderSidebar(store);
  rerender(
    <StoreProvider store={store}>
      <Sidebar />
    </StoreProvider>,
  );
  assert.match(lastFrame() ?? "", /Synthesizer: merged c2/);
});

test("Sidebar: shows toggle hint at the bottom", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.match(lastFrame() ?? "", /\[Tab\] toggle sidebar/);
});

// ---------------------------------------------------------------------------
// Toggle back to hidden
// ---------------------------------------------------------------------------

test("Sidebar: hides again after second toggle_sidebar dispatch", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "toggle_sidebar" });
  store.dispatch({ type: "toggle_sidebar" });
  const { lastFrame } = renderSidebar(store);
  assert.doesNotMatch(lastFrame() ?? "", /Orchestrator/);
});
