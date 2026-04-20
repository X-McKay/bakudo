import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Transcript } from "../../../../../src/host/renderers/ink/Transcript.js";

const renderWithStore = (dispatches: Parameters<ReturnType<typeof createHostStore>["dispatch"]>[0][]) => {
  const store = createHostStore(reduceHost, initialHostAppState());
  for (const a of dispatches) store.dispatch(a);
  return render(
    <StoreProvider store={store}>
      <Transcript />
    </StoreProvider>,
  ).lastFrame() ?? "";
};

test("Transcript: user message renders with '›' gutter", () => {
  const frame = renderWithStore([{ type: "append_user", text: "hello" }]);
  assert.match(frame, /›.*hello/);
});

test("Transcript: assistant message renders with '•' gutter", () => {
  const frame = renderWithStore([{ type: "append_assistant", text: "ok", tone: "success" }]);
  assert.match(frame, /•.*ok/);
});

test("Transcript: event line renders kind icon + detail, no '· kind' prefix", () => {
  const frame = renderWithStore([{ type: "append_event", label: "version", detail: "bakudo 0.2.0" }]);
  assert.doesNotMatch(frame, /· version/);
  assert.match(frame, /bakudo 0\.2\.0/);
});

test("Transcript: output block renders multiline, indented", () => {
  const frame = renderWithStore([{ type: "append_output", text: "a\nb" }]);
  assert.match(frame, /  a/);
  assert.match(frame, /  b/);
});

test("Transcript: review card renders outcome + next action", () => {
  const frame = renderWithStore([
    { type: "append_review", outcome: "success", summary: "done", nextAction: "ship it" },
  ]);
  assert.match(frame, /success/);
  assert.match(frame, /done/);
  assert.match(frame, /ship it/);
});
