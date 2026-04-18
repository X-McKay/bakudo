/**
 * Phase 6 W10 PR15 — golden: first prompt / new session (TTY).
 *
 * Scenario (plan line 589, examples/README.md §3): user's first plain-text
 * prompt in a shell with no active session. Creates a session, turn 1, and
 * the first attempt; transcript shows plan → dispatch → start → output →
 * complete → review narration.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  diffAgainstFixture,
  loadFixture,
  normalizeDynamicFields,
  STABLE_SESSION_ID,
} from "../helpers/golden.js";

test("golden/first-prompt-new-session.tty.txt: narration line order", async () => {
  const fixture = await loadFixture("first-prompt-new-session.tty.txt");
  const plain = fixture.bytes.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, "");
  const order = [
    "Starting new session",
    "Planning turn 1",
    "Dispatching sandbox attempt",
    "Sandbox worker started",
    "Worker completed",
    "Accepted.",
  ];
  let cursor = 0;
  for (const marker of order) {
    const at = plain.indexOf(marker, cursor);
    assert.notEqual(at, -1, `missing narration marker: ${marker}`);
    cursor = at + marker.length;
  }
});

test("golden/first-prompt-new-session.tty.txt: normalization collapses dynamic IDs", async () => {
  const fixture = await loadFixture("first-prompt-new-session.tty.txt");
  const normalized = normalizeDynamicFields(fixture.bytes);
  assert.ok(normalized.includes(STABLE_SESSION_ID));
});

test("golden/first-prompt-new-session.tty.txt: self-match", async () => {
  const fixture = await loadFixture("first-prompt-new-session.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
