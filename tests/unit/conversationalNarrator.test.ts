/**
 * Unit tests for the ConversationalNarrator module.
 *
 * Since `checkClarification` and `answerStatusQuery` now delegate to a
 * `MacroOrchestrationSession`, all tests that exercise those functions use a
 * `MockMacroSession` that returns pre-configured responses without spawning a
 * real process.
 *
 * The pure narration helpers (narrateObjectiveStart, narrateDecomposition,
 * narrateCampaignComplete, etc.) are synchronous and do not need a session —
 * they are tested directly against the store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkClarification,
  emitClarification,
  narrateObjectiveStart,
  narrateDecomposition,
  narrateCampaignComplete,
  narrateCampaignFailed,
  narrateObjectiveComplete,
  narrateObjectiveFailed,
  acknowledgeSteeringCommand,
  answerStatusQuery,
} from "../../src/host/orchestration/conversationalNarrator.js";
import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { createHostStore } from "../../src/host/store/index.js";
import type { Campaign, Objective } from "../../src/host/orchestration/objectiveState.js";
import type { MacroOrchestrationSession } from "../../src/host/orchestration/macroOrchestrationSession.js";
import type { MacroTask } from "../../src/host/orchestration/macroOrchestrationSession.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeStore = () => createHostStore(reduceHost, initialHostAppState());

const makeCampaign = (
  campaignId: string,
  status: Campaign["status"] = "completed",
): Campaign => ({
  campaignId,
  description: `Campaign ${campaignId}`,
  status,
  candidateSet: [],
  winnerCandidateId: undefined,
  synthesisRecord: undefined,
});

const makeObjective = (
  objectiveId: string,
  goal: string,
  campaigns: Campaign[] = [],
  status: Objective["status"] = "completed",
): Objective => ({
  objectiveId,
  goal,
  status,
  campaigns,
  createdAt: "2026-01-01T00:00:00.000Z",
});

// ---------------------------------------------------------------------------
// Mock session factory
// ---------------------------------------------------------------------------

/**
 * Build a mock `MacroOrchestrationSession` that resolves `send()` with a
 * pre-configured result object. Optionally throws to test error paths.
 */
const makeMockSession = (
  result: Record<string, unknown>,
  shouldThrow = false,
): MacroOrchestrationSession =>
  ({
    start() {},
    dispose() {},
    async send<T>(_task: MacroTask): Promise<T> {
      if (shouldThrow) throw new Error("mock session error");
      return result as T;
    },
  }) as unknown as MacroOrchestrationSession;

// ---------------------------------------------------------------------------
// checkClarification — session-backed
// ---------------------------------------------------------------------------

test("checkClarification: returns needsClarification=false when session says so", async () => {
  const session = makeMockSession({ needsClarification: false });
  const result = await checkClarification("refactor the reducer into smaller files", session);
  assert.equal(result.needsClarification, false);
});

test("checkClarification: returns needsClarification=true with question when session says so", async () => {
  const session = makeMockSession({
    needsClarification: true,
    question: "Which part of the auth module should I focus on?",
  });
  const result = await checkClarification("fix the auth stuff", session);
  assert.equal(result.needsClarification, true);
  if (result.needsClarification) {
    assert.equal(result.question, "Which part of the auth module should I focus on?");
  }
});

test("checkClarification: defaults to needsClarification=false when session throws", async () => {
  const session = makeMockSession({}, true /* shouldThrow */);
  const result = await checkClarification("do something", session);
  assert.equal(result.needsClarification, false);
});

test("checkClarification: defaults to needsClarification=false when session returns malformed response", async () => {
  const session = makeMockSession({ needsClarification: true /* missing question */ });
  const result = await checkClarification("do something", session);
  assert.equal(result.needsClarification, false);
});

test("checkClarification: defaults to needsClarification=false when session returns empty question", async () => {
  const session = makeMockSession({ needsClarification: true, question: "" });
  const result = await checkClarification("do something", session);
  assert.equal(result.needsClarification, false);
});

// ---------------------------------------------------------------------------
// emitClarification — synchronous, no session needed
// ---------------------------------------------------------------------------

test("emitClarification: dispatches an assistant message with the question", () => {
  const store = makeStore();
  emitClarification(store, "Should I preserve existing session tokens?");
  const transcript = store.getSnapshot().transcript;
  assert.ok(transcript.length > 0);
  const last = transcript[transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.ok(
      last.text.includes("Should I preserve existing session tokens?"),
      `expected question in text, got: ${last.text}`,
    );
  }
});

// ---------------------------------------------------------------------------
// narrateObjectiveStart — synchronous
// ---------------------------------------------------------------------------

test("narrateObjectiveStart: dispatches an assistant message mentioning the goal", () => {
  const store = makeStore();
  narrateObjectiveStart(store, "refactor the auth module");
  const transcript = store.getSnapshot().transcript;
  const last = transcript[transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.ok(
      last.text.toLowerCase().includes("refactor the auth module"),
      `expected goal in narration, got: ${last.text}`,
    );
  }
});

// ---------------------------------------------------------------------------
// narrateDecomposition — synchronous
// ---------------------------------------------------------------------------

test("narrateDecomposition: dispatches one assistant message listing the campaigns", () => {
  const store = makeStore();
  const campaigns = [
    makeCampaign("c1", "pending"),
    makeCampaign("c2", "pending"),
    makeCampaign("c3", "pending"),
  ];
  const before = store.getSnapshot().transcript.length;
  narrateDecomposition(store, campaigns);
  const after = store.getSnapshot().transcript.length;
  assert.ok(after > before, "should have added at least one transcript item");
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
});

test("narrateDecomposition: message mentions the campaign count", () => {
  const store = makeStore();
  const campaigns = [makeCampaign("c1", "pending"), makeCampaign("c2", "pending")];
  narrateDecomposition(store, campaigns);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  if (last.kind === "assistant") {
    assert.ok(
      last.text.includes("2") || last.text.toLowerCase().includes("two"),
      `expected campaign count in narration, got: ${last.text}`,
    );
  }
});

// ---------------------------------------------------------------------------
// narrateCampaignComplete — synchronous
// ---------------------------------------------------------------------------

test("narrateCampaignComplete: dispatches a success-toned assistant message", () => {
  const store = makeStore();
  const campaign = makeCampaign("c1", "completed");
  narrateCampaignComplete(store, campaign, 1);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.equal(last.tone, "success");
  }
});

test("narrateCampaignComplete: message mentions the campaign id", () => {
  const store = makeStore();
  const campaign = makeCampaign("c1", "completed");
  narrateCampaignComplete(store, campaign, 0);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  if (last.kind === "assistant") {
    assert.ok(
      last.text.includes("c1"),
      `expected campaign id in narration, got: ${last.text}`,
    );
  }
});

// ---------------------------------------------------------------------------
// narrateCampaignFailed — synchronous
// ---------------------------------------------------------------------------

test("narrateCampaignFailed: dispatches a warning-toned assistant message", () => {
  const store = makeStore();
  const campaign = makeCampaign("c2", "failed");
  narrateCampaignFailed(store, campaign, 2);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.equal(last.tone, "warning");
  }
});

// ---------------------------------------------------------------------------
// narrateObjectiveComplete — synchronous
// ---------------------------------------------------------------------------

test("narrateObjectiveComplete: dispatches a success-toned assistant message", () => {
  const store = makeStore();
  const objective = makeObjective("obj-001", "refactor the reducer", [
    makeCampaign("c1", "completed"),
    makeCampaign("c2", "completed"),
  ]);
  narrateObjectiveComplete(store, objective);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.equal(last.tone, "success");
  }
});

// ---------------------------------------------------------------------------
// narrateObjectiveFailed — synchronous
// ---------------------------------------------------------------------------

test("narrateObjectiveFailed: dispatches an error-toned assistant message", () => {
  const store = makeStore();
  narrateObjectiveFailed(store, "all campaigns exhausted");
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.equal(last.tone, "error");
  }
});

// ---------------------------------------------------------------------------
// acknowledgeSteeringCommand — synchronous
// ---------------------------------------------------------------------------

test("acknowledgeSteeringCommand: dispatches an info-toned assistant message", () => {
  const store = makeStore();
  acknowledgeSteeringCommand(store, "skip campaign 2");
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.equal(last.tone, "info");
    assert.ok(
      last.text.toLowerCase().includes("skip campaign 2"),
      `expected command in acknowledgement, got: ${last.text}`,
    );
  }
});

// ---------------------------------------------------------------------------
// answerStatusQuery — session-backed
// ---------------------------------------------------------------------------

test("answerStatusQuery: emits the session's summary as an info-toned assistant message", async () => {
  const store = makeStore();
  const session = makeMockSession({ summary: "Nothing is running right now." });
  await answerStatusQuery(store, session);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.equal(last.tone, "info");
    assert.ok(
      last.text.includes("Nothing is running right now."),
      `expected session summary in message, got: ${last.text}`,
    );
  }
});

test("answerStatusQuery: emits a warning message when session throws", async () => {
  const store = makeStore();
  const session = makeMockSession({}, true /* shouldThrow */);
  await answerStatusQuery(store, session);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.equal(last.tone, "warning");
  }
});

test("answerStatusQuery: forwards orchestrator state to session", async () => {
  const store = makeStore();
  let capturedPayload: Record<string, unknown> | undefined;
  const session = {
    start() {},
    dispose() {},
    async send<T>(task: MacroTask): Promise<T> {
      capturedPayload = task.payload as Record<string, unknown>;
      return { summary: "ok" } as T;
    },
  } as unknown as MacroOrchestrationSession;

  await answerStatusQuery(store, session);
  assert.ok(capturedPayload !== undefined, "session should have been called");
  assert.ok(
    "orchestratorState" in capturedPayload,
    "payload should contain orchestratorState",
  );
});

test("answerStatusQuery: emits fallback message when session returns empty summary", async () => {
  const store = makeStore();
  const session = makeMockSession({ summary: "" });
  await answerStatusQuery(store, session);
  const last = store.getSnapshot().transcript[store.getSnapshot().transcript.length - 1]!;
  assert.equal(last.kind, "assistant");
  if (last.kind === "assistant") {
    assert.ok(last.text.length > 0, "should emit a non-empty fallback message");
  }
});
