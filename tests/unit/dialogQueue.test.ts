import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import {
  answerPrompt,
  awaitPrompt,
  cancelPrompt,
  newPromptId,
  pendingPromptIds,
  resetPromptResolvers,
} from "../../src/host/promptResolvers.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";

test("dialog queue: enqueue adds to queue and selectRenderFrame derives overlay from head", () => {
  const state = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval", payload: { message: "proceed?" } },
  });
  const frame = selectRenderFrame({ state, transcript: [] });
  assert.deepEqual(frame.overlay, { kind: "approval", message: "proceed?" });
  assert.equal(frame.mode, "transcript");
});

test("dialog queue: multiple prompts project only the head into overlay", () => {
  const s1 = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "resume_confirm", payload: { message: "first?" } },
  });
  const s2 = reduceHost(s1, {
    type: "enqueue_prompt",
    prompt: { id: "p2", kind: "approval", payload: { message: "second?" } },
  });
  const frame = selectRenderFrame({ state: s2, transcript: [] });
  assert.equal((frame.overlay as { message: string }).message, "first?");
  assert.equal(frame.overlay?.kind, "resume_confirm");
});

test("dialog queue: dequeue by id removes the matching prompt", () => {
  const s1 = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval", payload: {} },
  });
  const s2 = reduceHost(s1, {
    type: "enqueue_prompt",
    prompt: { id: "p2", kind: "approval", payload: {} },
  });
  const dequeued = reduceHost(s2, { type: "dequeue_prompt", id: "p1" });
  assert.equal(dequeued.promptQueue.length, 1);
  assert.equal(dequeued.promptQueue[0]?.id, "p2");
});

test("dialog queue: cancel_prompt without id drops the head", () => {
  const s1 = reduceHost(initialHostAppState(), {
    type: "enqueue_prompt",
    prompt: { id: "p1", kind: "approval", payload: {} },
  });
  const s2 = reduceHost(s1, {
    type: "enqueue_prompt",
    prompt: { id: "p2", kind: "approval", payload: {} },
  });
  const cancelled = reduceHost(s2, { type: "cancel_prompt" });
  assert.equal(cancelled.promptQueue.length, 1);
  assert.equal(cancelled.promptQueue[0]?.id, "p2");
});

test("prompt resolvers: answerPrompt resolves awaitPrompt with answered value", async () => {
  resetPromptResolvers();
  const id = newPromptId();
  const pending = awaitPrompt(id);
  assert.equal(pendingPromptIds().length, 1);
  const ok = answerPrompt(id, "yes");
  assert.equal(ok, true);
  const outcome = await pending;
  assert.equal(outcome.kind, "answered");
  if (outcome.kind === "answered") {
    assert.equal(outcome.value, "yes");
  }
  assert.equal(pendingPromptIds().length, 0);
});

test("prompt resolvers: cancelPrompt resolves awaitPrompt with cancelled", async () => {
  resetPromptResolvers();
  const id = newPromptId();
  const pending = awaitPrompt(id);
  const ok = cancelPrompt(id);
  assert.equal(ok, true);
  const outcome = await pending;
  assert.equal(outcome.kind, "cancelled");
});
