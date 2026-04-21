/**
 * Tests for the orchestrator slice of the host reducer.
 * Covers all six new actions: orchestrator_start, orchestrator_objective_update,
 * orchestrator_complete, orchestrator_failed, orchestrator_git_mutex,
 * orchestrator_verdict, and toggle_sidebar.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import type { Objective } from "../../src/host/orchestration/objectiveState.js";

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

// ---------------------------------------------------------------------------
// orchestrator_start
// ---------------------------------------------------------------------------

test("orchestrator_start: adds objective to front of list and sets activeCampaignId", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const next = reduceHost(state, { type: "orchestrator_start", objective: obj });

  assert.equal(next.orchestrator.objectives.length, 1);
  assert.equal(next.orchestrator.objectives[0]!.objectiveId, "obj-001");
  assert.equal(next.orchestrator.activeCampaignId, "obj-001");
});

test("orchestrator_start: is idempotent — duplicate objectiveId is ignored", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj });
  const s2 = reduceHost(s1, { type: "orchestrator_start", objective: obj });

  assert.equal(s2.orchestrator.objectives.length, 1);
  assert.strictEqual(s2, s1);
});

test("orchestrator_start: multiple objectives are prepended (newest first)", () => {
  const state = initialHostAppState();
  const obj1 = makeObjective("obj-001", "first goal");
  const obj2 = makeObjective("obj-002", "second goal");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj1 });
  const s2 = reduceHost(s1, { type: "orchestrator_start", objective: obj2 });

  assert.equal(s2.orchestrator.objectives.length, 2);
  assert.equal(s2.orchestrator.objectives[0]!.objectiveId, "obj-002");
  assert.equal(s2.orchestrator.objectives[1]!.objectiveId, "obj-001");
  assert.equal(s2.orchestrator.activeCampaignId, "obj-002");
});

// ---------------------------------------------------------------------------
// orchestrator_objective_update
// ---------------------------------------------------------------------------

test("orchestrator_objective_update: replaces matching objective in list", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj });

  const updated: Objective = { ...obj, status: "completed" };
  const s2 = reduceHost(s1, { type: "orchestrator_objective_update", objective: updated });

  assert.equal(s2.orchestrator.objectives[0]!.status, "completed");
  assert.equal(s2.orchestrator.objectives.length, 1);
});

test("orchestrator_objective_update: unknown objectiveId leaves list unchanged", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj });

  const ghost = makeObjective("obj-999", "ghost");
  const s2 = reduceHost(s1, { type: "orchestrator_objective_update", objective: ghost });

  // The ghost is not in the list — the original is unchanged.
  assert.equal(s2.orchestrator.objectives.length, 1);
  assert.equal(s2.orchestrator.objectives[0]!.objectiveId, "obj-001");
});

// ---------------------------------------------------------------------------
// orchestrator_complete
// ---------------------------------------------------------------------------

test("orchestrator_complete: clears activeCampaignId when it matches", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj });

  assert.equal(s1.orchestrator.activeCampaignId, "obj-001");
  const s2 = reduceHost(s1, { type: "orchestrator_complete", objectiveId: "obj-001" });
  assert.equal(s2.orchestrator.activeCampaignId, undefined);
});

test("orchestrator_complete: leaves activeCampaignId when it does not match", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj });

  const s2 = reduceHost(s1, { type: "orchestrator_complete", objectiveId: "obj-999" });
  assert.equal(s2.orchestrator.activeCampaignId, "obj-001");
});

// ---------------------------------------------------------------------------
// orchestrator_failed
// ---------------------------------------------------------------------------

test("orchestrator_failed: clears activeCampaignId when it matches", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj });

  const s2 = reduceHost(s1, {
    type: "orchestrator_failed",
    objectiveId: "obj-001",
    reason: "all campaigns exhausted",
  });
  assert.equal(s2.orchestrator.activeCampaignId, undefined);
});

test("orchestrator_failed: leaves activeCampaignId when it does not match", () => {
  const state = initialHostAppState();
  const obj = makeObjective("obj-001", "refactor the reducer");
  const s1 = reduceHost(state, { type: "orchestrator_start", objective: obj });

  const s2 = reduceHost(s1, {
    type: "orchestrator_failed",
    objectiveId: "obj-999",
    reason: "irrelevant",
  });
  assert.equal(s2.orchestrator.activeCampaignId, "obj-001");
});

// ---------------------------------------------------------------------------
// orchestrator_git_mutex
// ---------------------------------------------------------------------------

test("orchestrator_git_mutex: sets locked=true", () => {
  const state = initialHostAppState();
  assert.equal(state.orchestrator.gitMutexLocked, false);
  const next = reduceHost(state, { type: "orchestrator_git_mutex", locked: true });
  assert.equal(next.orchestrator.gitMutexLocked, true);
});

test("orchestrator_git_mutex: sets locked=false", () => {
  const state = initialHostAppState();
  const s1 = reduceHost(state, { type: "orchestrator_git_mutex", locked: true });
  const s2 = reduceHost(s1, { type: "orchestrator_git_mutex", locked: false });
  assert.equal(s2.orchestrator.gitMutexLocked, false);
});

// ---------------------------------------------------------------------------
// orchestrator_verdict
// ---------------------------------------------------------------------------

test("orchestrator_verdict: stores the verdict string", () => {
  const state = initialHostAppState();
  assert.equal(state.orchestrator.lastVerdict, undefined);
  const next = reduceHost(state, {
    type: "orchestrator_verdict",
    verdict: "Synthesizer: merged candidate obj-001-c2",
  });
  assert.equal(next.orchestrator.lastVerdict, "Synthesizer: merged candidate obj-001-c2");
});

test("orchestrator_verdict: overwrites a previous verdict", () => {
  const state = initialHostAppState();
  const s1 = reduceHost(state, { type: "orchestrator_verdict", verdict: "first" });
  const s2 = reduceHost(s1, { type: "orchestrator_verdict", verdict: "second" });
  assert.equal(s2.orchestrator.lastVerdict, "second");
});

// ---------------------------------------------------------------------------
// toggle_sidebar
// ---------------------------------------------------------------------------

test("toggle_sidebar: starts false, toggles to true", () => {
  const state = initialHostAppState();
  assert.equal(state.orchestrator.sidebarVisible, false);
  const next = reduceHost(state, { type: "toggle_sidebar" });
  assert.equal(next.orchestrator.sidebarVisible, true);
});

test("toggle_sidebar: toggles back to false on second dispatch", () => {
  const state = initialHostAppState();
  const s1 = reduceHost(state, { type: "toggle_sidebar" });
  const s2 = reduceHost(s1, { type: "toggle_sidebar" });
  assert.equal(s2.orchestrator.sidebarVisible, false);
});

test("toggle_sidebar: does not mutate other state slices", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "toggle_sidebar" });
  assert.equal(next.screen, state.screen);
  assert.equal(next.composer.mode, state.composer.mode);
  assert.deepEqual(next.transcript, state.transcript);
});

// ---------------------------------------------------------------------------
// Initial state shape
// ---------------------------------------------------------------------------

test("initialHostAppState: orchestrator slice has correct defaults", () => {
  const state = initialHostAppState();
  assert.deepEqual(state.orchestrator, {
    objectives: [],
    sidebarVisible: false,
    activeCampaignId: undefined,
    gitMutexLocked: false,
    lastVerdict: undefined,
    sessionMemory: [],
    pendingClarification: undefined,
  });
});

// ---------------------------------------------------------------------------
// orchestrator_memory_record
// ---------------------------------------------------------------------------

test("orchestrator_memory_record: prepends entry to sessionMemory", () => {
  const state = initialHostAppState();
  const entry = {
    objectiveId: "obj-001",
    goal: "refactor the reducer",
    status: "completed" as const,
    finishedAt: "2026-01-01T00:00:00.000Z",
    succeededCampaigns: 2,
    totalCampaigns: 2,
    verdict: "all done",
  };
  const next = reduceHost(state, { type: "orchestrator_memory_record", entry });
  assert.equal(next.orchestrator.sessionMemory.length, 1);
  assert.deepEqual(next.orchestrator.sessionMemory[0], entry);
});

test("orchestrator_memory_record: newest entry is at index 0", () => {
  const state = initialHostAppState();
  const entry1 = {
    objectiveId: "obj-001",
    goal: "first goal",
    status: "completed" as const,
    finishedAt: "2026-01-01T00:00:00.000Z",
    succeededCampaigns: 1,
    totalCampaigns: 1,
    verdict: undefined,
  };
  const entry2 = {
    objectiveId: "obj-002",
    goal: "second goal",
    status: "failed" as const,
    finishedAt: "2026-01-01T01:00:00.000Z",
    succeededCampaigns: 0,
    totalCampaigns: 1,
    verdict: "all campaigns exhausted",
  };
  const s1 = reduceHost(state, { type: "orchestrator_memory_record", entry: entry1 });
  const s2 = reduceHost(s1, { type: "orchestrator_memory_record", entry: entry2 });
  assert.equal(s2.orchestrator.sessionMemory[0]!.objectiveId, "obj-002");
  assert.equal(s2.orchestrator.sessionMemory[1]!.objectiveId, "obj-001");
});

test("orchestrator_memory_record: caps at 20 entries, dropping oldest", () => {
  let state = initialHostAppState();
  for (let i = 0; i < 22; i++) {
    const entry = {
      objectiveId: `obj-${String(i).padStart(3, "0")}`,
      goal: `goal ${i}`,
      status: "completed" as const,
      finishedAt: new Date().toISOString(),
      succeededCampaigns: 1,
      totalCampaigns: 1,
      verdict: undefined,
    };
    state = reduceHost(state, { type: "orchestrator_memory_record", entry });
  }
  assert.equal(state.orchestrator.sessionMemory.length, 20);
  // Newest (obj-021) should be at index 0.
  assert.equal(state.orchestrator.sessionMemory[0]!.objectiveId, "obj-021");
});

// ---------------------------------------------------------------------------
// orchestrator_clarification_pending
// ---------------------------------------------------------------------------

test("orchestrator_clarification_pending: sets pendingClarification", () => {
  const state = initialHostAppState();
  assert.equal(state.orchestrator.pendingClarification, undefined);
  const next = reduceHost(state, {
    type: "orchestrator_clarification_pending",
    goal: "refactor the auth module",
    question: "Should I preserve the existing session tokens?",
  });
  assert.deepEqual(next.orchestrator.pendingClarification, {
    goal: "refactor the auth module",
    question: "Should I preserve the existing session tokens?",
  });
});

test("orchestrator_clarification_pending: overwrites any existing pending clarification", () => {
  const state = initialHostAppState();
  const s1 = reduceHost(state, {
    type: "orchestrator_clarification_pending",
    goal: "first goal",
    question: "first question",
  });
  const s2 = reduceHost(s1, {
    type: "orchestrator_clarification_pending",
    goal: "second goal",
    question: "second question",
  });
  assert.equal(s2.orchestrator.pendingClarification!.goal, "second goal");
});

// ---------------------------------------------------------------------------
// orchestrator_clarification_resolved
// ---------------------------------------------------------------------------

test("orchestrator_clarification_resolved: clears pendingClarification", () => {
  const state = initialHostAppState();
  const s1 = reduceHost(state, {
    type: "orchestrator_clarification_pending",
    goal: "refactor the auth module",
    question: "Should I preserve the existing session tokens?",
  });
  assert.notEqual(s1.orchestrator.pendingClarification, undefined);
  const s2 = reduceHost(s1, { type: "orchestrator_clarification_resolved" });
  assert.equal(s2.orchestrator.pendingClarification, undefined);
});

test("orchestrator_clarification_resolved: is idempotent when already undefined", () => {
  const state = initialHostAppState();
  assert.equal(state.orchestrator.pendingClarification, undefined);
  const next = reduceHost(state, { type: "orchestrator_clarification_resolved" });
  // Should not throw and pendingClarification should remain undefined.
  assert.equal(next.orchestrator.pendingClarification, undefined);
});
