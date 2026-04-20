import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_DIALOG_CURSOR_COUNT,
  initialHostAppState,
  type ApprovalPromptRequest,
} from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";
import {
  renderApprovalPromptLines,
  renderTranscriptFramePlain,
} from "../../src/host/renderers/plainRenderer.js";
import { stripAnsi } from "../../src/host/ansi.js";

/**
 * Phase 5 PR8 — Approval-dialog cursor + Shift+Tab cycling.
 */

const request: ApprovalPromptRequest = {
  sessionId: "s",
  turnId: "t",
  attemptId: "a",
  tool: "shell",
  argument: "git push origin main",
  policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
};

const expectCursorRow = (lines: string[], expected: 0 | 1 | 2 | 3): void => {
  // The cursor renders as a leading "  ❯ " on exactly one of the four rows.
  const rowIndices = lines
    .map((line, idx) => (line.includes("\u276F") ? idx : -1))
    .filter((idx) => idx >= 0);
  assert.equal(rowIndices.length, 1, `expected exactly one cursor row, got ${rowIndices.length}`);
  const cursorLine = lines[rowIndices[0]!]!;
  // Rows 0..3 map to "[1]..[4]" in the rendered copy.
  const match = cursorLine.match(/\[(\d)\]/);
  assert.ok(match);
  assert.equal(Number(match![1]), expected + 1);
};

test("APPROVAL_DIALOG_CURSOR_COUNT: exported as 4", () => {
  assert.equal(APPROVAL_DIALOG_CURSOR_COUNT, 4);
});

test("reducer: approval_dialog_cursor_down advances 0 → 1 → 2 → 3 → 0 (wrap)", () => {
  let state = initialHostAppState();
  assert.equal(state.approvalDialogCursor, 0);
  for (let i = 1; i < APPROVAL_DIALOG_CURSOR_COUNT; i += 1) {
    state = reduceHost(state, { type: "approval_dialog_cursor_down" });
    assert.equal(state.approvalDialogCursor, i);
  }
  // Wrap-around.
  state = reduceHost(state, { type: "approval_dialog_cursor_down" });
  assert.equal(state.approvalDialogCursor, 0);
});

test("reducer: approval_dialog_cursor_up from 0 wraps to COUNT-1", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "approval_dialog_cursor_up" });
  assert.equal(next.approvalDialogCursor, APPROVAL_DIALOG_CURSOR_COUNT - 1);
});

test("reducer: approval_dialog_cursor_reset forces 0", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "approval_dialog_cursor_down" });
  state = reduceHost(state, { type: "approval_dialog_cursor_down" });
  assert.equal(state.approvalDialogCursor, 2);
  state = reduceHost(state, { type: "approval_dialog_cursor_reset" });
  assert.equal(state.approvalDialogCursor, 0);
});

test("reducer: approval_dialog_cursor_reset is referentially stable at 0", () => {
  const state = initialHostAppState();
  const next = reduceHost(state, { type: "approval_dialog_cursor_reset" });
  assert.strictEqual(next, state);
});

test("renderApprovalPromptLines: default cursorIndex renders ❯ on [1]", () => {
  const lines = renderApprovalPromptLines(request);
  expectCursorRow(lines, 0);
});

test("renderApprovalPromptLines: cursorIndex=1 renders ❯ on [2]", () => {
  const lines = renderApprovalPromptLines(request, 1);
  expectCursorRow(lines, 1);
});

test("renderApprovalPromptLines: cursorIndex=3 renders ❯ on [4]", () => {
  const lines = renderApprovalPromptLines(request, 3);
  expectCursorRow(lines, 3);
});

test("renderApprovalPromptLines: out-of-range cursorIndex is clamped", () => {
  // Too large → clamps to last.
  const big = renderApprovalPromptLines(request, 99);
  expectCursorRow(big, 3);
  // Negative → clamps to first.
  const negative = renderApprovalPromptLines(request, -4);
  expectCursorRow(negative, 0);
  // NaN / non-finite → defaults to 0.
  const nan = renderApprovalPromptLines(request, Number.NaN);
  expectCursorRow(nan, 0);
});

test("selectRenderFrame: approval_prompt overlay carries state.approvalDialogCursor", () => {
  let state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval_prompt", payload: request },
  });
  state = reduceHost(state, { type: "approval_dialog_cursor_down" });
  state = reduceHost(state, { type: "approval_dialog_cursor_down" });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.equal(frame.overlay?.kind, "approval_prompt");
  if (frame.overlay?.kind === "approval_prompt") {
    assert.equal(frame.overlay.cursorIndex, 2);
  }
});

test("plain renderer: Shift+Tab cycle reflected in overlay output", () => {
  let state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval_prompt", payload: request },
  });
  state = reduceHost(state, { type: "approval_dialog_cursor_down" });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFramePlain(frame).map(stripAnsi);
  expectCursorRow(lines, 1);
});
