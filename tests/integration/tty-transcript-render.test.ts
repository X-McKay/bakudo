import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import { selectRenderFrame, type TranscriptItem } from "../../src/host/renderModel.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";
import { reduceHost } from "../../src/host/reducer.js";
import { formatInspectReview } from "../../src/host/inspectFormatter.js";
import { reviewTaskResult } from "../../src/reviewer.js";

test("opening frame header includes Bakudo and the mode", () => {
  const state = initialHostAppState();
  const transcript: TranscriptItem[] = [];
  const frame = selectRenderFrame({ state, transcript, repoLabel: "my-repo" });
  // Use the plain renderer (no ANSI deps in test env).
  const lines = renderTranscriptFramePlain(frame);
  const header = lines[0] ?? "";
  assert.match(header, /Bakudo/, "header contains Bakudo");
  assert.match(header, /STANDARD/, "header shows default STANDARD mode");
  assert.match(header, /my-repo/, "header shows repo label");
});

test("user prompt creates transcript items (user + assistant lines)", () => {
  const state = initialHostAppState();
  const transcript: TranscriptItem[] = [
    { kind: "user", text: "add a richer review surface" },
    { kind: "assistant", text: "Queued sandbox attempt.", tone: "info" },
  ];
  const frame = selectRenderFrame({ state, transcript });
  const lines = renderTranscriptFramePlain(frame);
  const joined = lines.join("\n");
  assert.match(joined, /You: add a richer review surface/, "user line rendered");
  assert.match(joined, /Bakudo: Queued sandbox attempt\./, "assistant line rendered");
});

test("review transcript item renders outcome and summary", () => {
  const state = initialHostAppState();
  const transcript: TranscriptItem[] = [
    {
      kind: "review",
      outcome: "success",
      summary: "all tests pass",
      nextAction: "accept",
    },
  ];
  const frame = selectRenderFrame({ state, transcript });
  const lines = renderTranscriptFramePlain(frame);
  const joined = lines.join("\n");
  assert.match(joined, /Review: success/, "review outcome rendered");
  assert.match(joined, /all tests pass/, "review summary rendered");
});

test("plan mode shows PLAN in header", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "set_mode", mode: "plan" });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFramePlain(frame);
  assert.match(lines[0] ?? "", /PLAN/, "header shows PLAN mode");
});

test("inspect review produces review section text", () => {
  const session = {
    schemaVersion: 2,
    sessionId: "session-render-1",
    repoRoot: "/tmp/repo",
    title: "inspect render test",
    status: "completed" as const,
    turns: [],
    createdAt: "2026-04-14T12:00:00.000Z",
    updatedAt: "2026-04-14T12:05:00.000Z",
  };
  const attempt = {
    attemptId: "attempt-render",
    status: "succeeded" as const,
    result: {
      schemaVersion: 1 as const,
      taskId: "attempt-render",
      sessionId: "session-render-1",
      status: "succeeded" as const,
      summary: "render test passed",
      finishedAt: "2026-04-14T12:05:00.000Z",
    },
    metadata: { sandboxTaskId: "abox-render-1" },
  };
  const reviewed = reviewTaskResult(attempt.result);
  const lines = formatInspectReview({
    session,
    attempt,
    reviewed,
    artifacts: [],
  });
  const joined = lines.join("\n");
  assert.match(joined, /Review/, "contains Review heading");
  assert.match(joined, /success/, "contains outcome");
  assert.match(joined, /accept/, "contains action");
});

test.skip("PTY golden test: full terminal rendering (requires PTY golden harness -- Phase 6)", () => {
  // Full PTY golden tests are deferred to Phase 6. This placeholder ensures
  // the test file is ready for expansion when the harness lands.
  assert.ok(true);
});
