import assert from "node:assert/strict";
import test from "node:test";

import { createChordTracker } from "../../../src/host/keybindings/chord.js";
import { parseKeyBinding, type KeyStroke } from "../../../src/host/keybindings/parser.js";

const stroke = (raw: string): KeyStroke => {
  const s = parseKeyBinding(raw).strokes[0];
  if (s === undefined) {
    throw new Error("unreachable");
  }
  return s;
};

test("createChordTracker: starts empty", () => {
  const t = createChordTracker();
  assert.deepEqual(t.current(), []);
  t.reset();
});

test("createChordTracker: push accumulates strokes", () => {
  const t = createChordTracker({ timeoutMs: 10_000 });
  try {
    t.push(stroke("ctrl+x"));
    t.push(stroke("ctrl+k"));
    const cur = t.current();
    assert.equal(cur.length, 2);
    assert.equal(cur[0]?.key, "x");
    assert.equal(cur[1]?.key, "k");
  } finally {
    t.reset();
  }
});

test("createChordTracker: reset clears strokes", () => {
  const t = createChordTracker({ timeoutMs: 10_000 });
  t.push(stroke("ctrl+x"));
  t.reset();
  assert.deepEqual(t.current(), []);
});

test("createChordTracker: timeout auto-resets and fires onTimeout", async () => {
  let firedCount = 0;
  const t = createChordTracker({
    timeoutMs: 20,
    onTimeout: () => {
      firedCount += 1;
    },
  });
  t.push(stroke("ctrl+x"));
  // Wait past the timeout.
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(firedCount, 1);
  assert.deepEqual(t.current(), []);
  t.reset();
});

test("createChordTracker: push resets the timeout window", async () => {
  let firedCount = 0;
  const t = createChordTracker({
    timeoutMs: 30,
    onTimeout: () => {
      firedCount += 1;
    },
  });
  t.push(stroke("ctrl+x"));
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  t.push(stroke("ctrl+k")); // rearms timer
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  // Total elapsed ~30ms, but each push rearmed — should not have fired yet.
  assert.equal(firedCount, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(firedCount, 1);
  t.reset();
});

test("createChordTracker: current() returns a snapshot, not the live array", () => {
  const t = createChordTracker({ timeoutMs: 10_000 });
  try {
    t.push(stroke("ctrl+x"));
    const snap = t.current();
    t.push(stroke("ctrl+k"));
    assert.equal(snap.length, 1, "snapshot must not reflect later pushes");
  } finally {
    t.reset();
  }
});
