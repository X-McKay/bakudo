/**
 * Phase 5 PR7 — session-picker launcher tests. Uses a stubbed index reader
 * so no filesystem is touched; mirrors the shape of `commandPalette.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import type { DialogDispatcher } from "../../src/host/dialogLauncher.js";
import {
  answerSessionPickerDialog,
  buildSessionPickerItems,
  formatSessionPickerLabel,
  launchSessionPickerDialog,
  type SessionIndexReader,
} from "../../src/host/launchSessionPickerDialog.js";
import type { SessionSummaryView } from "../../src/host/sessionIndex.js";
import { cancelPrompt, resetPromptResolvers } from "../../src/host/promptResolvers.js";
import { reduceHost } from "../../src/host/reducer.js";

const makeDispatcher = (): DialogDispatcher => {
  let state: HostAppState = initialHostAppState();
  return {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
};

const summary = (overrides: Partial<SessionSummaryView>): SessionSummaryView => ({
  schemaVersion: 2,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  title: "demo",
  repoRoot: "/tmp/repo",
  status: "completed",
  lastMode: "standard",
  updatedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

const stubReader = (summaries: SessionSummaryView[]): SessionIndexReader => ({
  listSessionSummaries: async () => summaries,
});

test("formatSessionPickerLabel: packs session fields in expected order", () => {
  const label = formatSessionPickerLabel(
    summary({
      sessionId: "12345678-0000-0000-0000-000000000000",
      title: "my task",
      status: "running",
      lastMode: "plan",
      updatedAt: "2025-06-01T12:00:00.000Z",
    }),
  );
  assert.ok(label.startsWith("session-12345678"));
  assert.ok(label.includes("running"));
  assert.ok(label.includes("plan"));
  assert.ok(label.includes("my task"));
  assert.ok(label.includes("2025-06-01T12:00:00.000Z"));
});

test("buildSessionPickerItems: preserves newest-first ordering", () => {
  const items = buildSessionPickerItems([
    summary({ sessionId: "aaaaaaaa11111111", updatedAt: "2025-06-02T00:00:00.000Z" }),
    summary({ sessionId: "bbbbbbbb22222222", updatedAt: "2025-06-01T00:00:00.000Z" }),
  ]);
  assert.equal(items[0]?.sessionId, "aaaaaaaa11111111");
  assert.equal(items[1]?.sessionId, "bbbbbbbb22222222");
});

test("launchSessionPickerDialog: resolves with sessionId when answered", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const summaries = [
    summary({ sessionId: "11111111-0000-0000-0000-000000000000" }),
    summary({ sessionId: "22222222-0000-0000-0000-000000000000" }),
  ];
  const pending = launchSessionPickerDialog(dispatcher, stubReader(summaries));
  // The launcher is async (awaits listSessionSummaries); give microtasks a
  // tick before answering so the queue is populated.
  await Promise.resolve();
  await Promise.resolve();
  const id = answerSessionPickerDialog(dispatcher, "22222222-0000-0000-0000-000000000000");
  assert.ok(id !== null);
  const choice = await pending;
  assert.notEqual(choice, "cancel");
  if (choice !== "cancel") {
    assert.equal(choice.sessionId, "22222222-0000-0000-0000-000000000000");
  }
  assert.equal(dispatcher.getState().promptQueue.length, 0);
});

test("launchSessionPickerDialog: empty index resolves immediately with cancel", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const choice = await launchSessionPickerDialog(dispatcher, stubReader([]));
  assert.equal(choice, "cancel");
  assert.equal(dispatcher.getState().promptQueue.length, 0);
});

test("launchSessionPickerDialog: cancelPrompt resolves with cancel", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const pending = launchSessionPickerDialog(
    dispatcher,
    stubReader([summary({ sessionId: "11111111" })]),
  );
  await Promise.resolve();
  await Promise.resolve();
  const head = dispatcher.getState().promptQueue[0];
  assert.ok(head !== undefined);
  if (head !== undefined) {
    cancelPrompt(head.id);
  }
  const choice = await pending;
  assert.equal(choice, "cancel");
});

test("launchSessionPickerDialog: enqueues session_picker entry with items", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const summaries = [summary({ sessionId: "abcdef01-0000-0000-0000-000000000000" })];
  const pending = launchSessionPickerDialog(dispatcher, stubReader(summaries));
  await Promise.resolve();
  await Promise.resolve();
  const head = dispatcher.getState().promptQueue[0];
  assert.equal(head?.kind, "session_picker");
  const payload = head?.payload as {
    items: Array<{ sessionId: string; label: string }>;
    input: string;
    selectedIndex: number;
  };
  assert.equal(payload.input, "");
  assert.equal(payload.selectedIndex, 0);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0]?.sessionId, "abcdef01-0000-0000-0000-000000000000");
  answerSessionPickerDialog(dispatcher, "abcdef01-0000-0000-0000-000000000000");
  await pending;
});

test("reducer: session_picker_input_change updates input and resets selection", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "session_picker",
      payload: {
        items: [
          { sessionId: "s1", label: "alpha" },
          { sessionId: "s2", label: "beta" },
        ],
        input: "",
        selectedIndex: 1,
      },
    },
  });
  const updated = reduceHost(enqueued, {
    type: "session_picker_input_change",
    id: "p1",
    input: "al",
  });
  const payload = updated.promptQueue[0]?.payload as { input: string; selectedIndex: number };
  assert.equal(payload.input, "al");
  assert.equal(payload.selectedIndex, 0);
});

test("reducer: session_picker_select_next wraps at the end", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "session_picker",
      payload: {
        items: [
          { sessionId: "s1", label: "alpha" },
          { sessionId: "s2", label: "beta" },
        ],
        input: "",
        selectedIndex: 1,
      },
    },
  });
  const next = reduceHost(enqueued, { type: "session_picker_select_next", id: "p1" });
  const payload = next.promptQueue[0]?.payload as { selectedIndex: number };
  assert.equal(payload.selectedIndex, 0);
});

test("reducer: session_picker_select_prev wraps at the start", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "session_picker",
      payload: {
        items: [
          { sessionId: "s1", label: "alpha" },
          { sessionId: "s2", label: "beta" },
          { sessionId: "s3", label: "charlie" },
        ],
        input: "",
        selectedIndex: 0,
      },
    },
  });
  const prev = reduceHost(enqueued, { type: "session_picker_select_prev", id: "p1" });
  const payload = prev.promptQueue[0]?.payload as { selectedIndex: number };
  assert.equal(payload.selectedIndex, 2);
});

test("reducer: session_picker actions are no-ops for non-matching ids", () => {
  const state = initialHostAppState();
  const enqueued = reduceHost(state, {
    type: "enqueue_prompt",
    prompt: {
      id: "p1",
      kind: "session_picker",
      payload: {
        items: [{ sessionId: "s1", label: "alpha" }],
        input: "",
        selectedIndex: 0,
      },
    },
  });
  const next = reduceHost(enqueued, {
    type: "session_picker_input_change",
    id: "other",
    input: "x",
  });
  assert.equal(next, enqueued);
});
