import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { initialHostAppState } from "../../../../../src/host/appState.js";
import { awaitPrompt, resetPromptResolvers } from "../../../../../src/host/promptResolvers.js";
import { reduceHost } from "../../../../../src/host/reducer.js";
import { createHostStore } from "../../../../../src/host/store/index.js";
import { StoreProvider } from "../../../../../src/host/renderers/ink/StoreProvider.js";
import { Composer } from "../../../../../src/host/renderers/ink/Composer.js";

test("Composer: typed chars appear in the rendered frame", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin, lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("hello");
  // Ink's render commit is async; one microtask is enough to flush the frame.
  await new Promise((r) => setTimeout(r, 10));
  assert.match(lastFrame() ?? "", /hello/);
});

test("Composer: Enter dispatches submit with typed text", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("/version");
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getSnapshot().pendingSubmit?.text, "/version");
});

test("Composer: empty Enter does NOT dispatch submit", async () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const { stdin } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.getSnapshot().pendingSubmit, undefined);
});

test("Composer: dispatch_inflight disables text entry and shows label", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "dispatch_started", label: "Routing", startedAt: 1000 });
  const { stdin, lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  stdin.write("ignored");
  assert.doesNotMatch(lastFrame() ?? "", /ignored/);
  assert.match(lastFrame() ?? "", /Routing/);
});

test("Composer: shows left rail + metadata row when idle", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "set_composer_metadata", model: "sonnet-4.6", agent: "default", provider: "claude" });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /┃/);
  assert.match(frame, /standard/);
  assert.match(frame, /sonnet-4\.6/);
  assert.match(frame, /claude/);
});

test("Composer: dispatch_inflight shows spinner glyph alongside label", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  store.dispatch({ type: "dispatch_started", label: "Dispatching", startedAt: 1000 });
  const { lastFrame } = render(
    <StoreProvider store={store}>
      <Composer />
    </StoreProvider>,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.match(frame, /Dispatching/);
});

test("Composer: approval prompt digits resolve the queued prompt", async () => {
  resetPromptResolvers();
  try {
    const store = createHostStore(reduceHost, initialHostAppState());
    const pending = awaitPrompt("approval-1");
    store.dispatch({ type: "dispatch_started", label: "Waiting", startedAt: 1000 });
    store.dispatch({
      type: "enqueue_prompt",
      prompt: {
        id: "approval-1",
        kind: "approval_prompt",
        payload: {
          sessionId: "session-1",
          turnId: "turn-1",
          tool: "shell",
          argument: "git push origin main",
          policySnapshot: { agent: "default", composerMode: "standard", autopilot: false },
        },
      },
    });
    const { stdin } = render(
      <StoreProvider store={store}>
        <Composer />
      </StoreProvider>,
    );
    stdin.write("2");
    const resolution = await pending;
    assert.deepEqual(resolution, { kind: "answered", value: "2" });
  } finally {
    resetPromptResolvers();
  }
});

test("Composer: command palette input filters and Enter resolves the selected command", async () => {
  resetPromptResolvers();
  try {
    const store = createHostStore(reduceHost, initialHostAppState());
    const pending = awaitPrompt("palette-1");
    store.dispatch({
      type: "enqueue_prompt",
      prompt: {
        id: "palette-1",
        kind: "command_palette",
        payload: {
          items: [
            { name: "alpha", description: "first" },
            { name: "beta", description: "second" },
          ],
          input: "",
          selectedIndex: 0,
        },
      },
    });
    const { stdin } = render(
      <StoreProvider store={store}>
        <Composer />
      </StoreProvider>,
    );
    stdin.write("be");
    await new Promise((r) => setTimeout(r, 10));
    const payload = store.getSnapshot().promptQueue[0]?.payload as { input: string };
    assert.equal(payload.input, "be");
    stdin.write("\r");
    const resolution = await pending;
    assert.deepEqual(resolution, { kind: "answered", value: "beta" });
  } finally {
    resetPromptResolvers();
  }
});

test("Composer: session picker input filters and Enter resolves the selected session", async () => {
  resetPromptResolvers();
  try {
    const store = createHostStore(reduceHost, initialHostAppState());
    const pending = awaitPrompt("session-1");
    store.dispatch({
      type: "enqueue_prompt",
      prompt: {
        id: "session-1",
        kind: "session_picker",
        payload: {
          items: [
            { sessionId: "session-alpha", label: "alpha session" },
            { sessionId: "session-beta", label: "beta session" },
          ],
          input: "",
          selectedIndex: 0,
        },
      },
    });
    const { stdin } = render(
      <StoreProvider store={store}>
        <Composer />
      </StoreProvider>,
    );
    stdin.write("be");
    await new Promise((r) => setTimeout(r, 10));
    const payload = store.getSnapshot().promptQueue[0]?.payload as { input: string };
    assert.equal(payload.input, "be");
    stdin.write("\r");
    const resolution = await pending;
    assert.deepEqual(resolution, { kind: "answered", value: "session-beta" });
  } finally {
    resetPromptResolvers();
  }
});
