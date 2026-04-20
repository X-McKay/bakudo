import assert from "node:assert/strict";
import test from "node:test";
import { initialHostAppState } from "../../../src/host/appState.js";
import { reduceHost } from "../../../src/host/reducer.js";
import { createHostStore } from "../../../src/host/store/index.js";
import { buildTranscriptFacade } from "../../../src/host/transcriptFacade.js";

test("transcriptFacade: push user dispatches append_user", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const facade = buildTranscriptFacade(store);
  facade.push({ kind: "user", text: "hi" });
  assert.deepEqual(store.getSnapshot().transcript, [{ kind: "user", text: "hi" }]);
});

test("transcriptFacade: length = 0 dispatches clear_transcript", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const facade = buildTranscriptFacade(store);
  facade.push({ kind: "user", text: "hi" });
  assert.equal(facade.length, 1);
  facade.length = 0;
  assert.equal(facade.length, 0);
  assert.deepEqual(store.getSnapshot().transcript, []);
});

test("transcriptFacade: length = non-zero throws", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const facade = buildTranscriptFacade(store);
  assert.throws(() => {
    (facade as { length: number }).length = 5;
  }, /can only be set to 0/);
});

test("transcriptFacade: push preserves optional fields (assistant tone)", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const facade = buildTranscriptFacade(store);
  facade.push({ kind: "assistant", text: "ok", tone: "success" });
  assert.deepEqual(store.getSnapshot().transcript, [
    { kind: "assistant", text: "ok", tone: "success" },
  ]);
});

test("transcriptFacade: push omits optional when undefined", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const facade = buildTranscriptFacade(store);
  facade.push({ kind: "event", label: "version" });
  const item = store.getSnapshot().transcript[0];
  assert.equal("detail" in (item ?? {}), false);
});

test("transcriptFacade: iterates in insertion order", () => {
  const store = createHostStore(reduceHost, initialHostAppState());
  const facade = buildTranscriptFacade(store);
  facade.push({ kind: "user", text: "a" });
  facade.push({ kind: "user", text: "b" });
  const collected: string[] = [];
  for (const item of facade as unknown as Iterable<{ kind: string; text: string }>) {
    collected.push(item.text);
  }
  assert.deepEqual(collected, ["a", "b"]);
});
