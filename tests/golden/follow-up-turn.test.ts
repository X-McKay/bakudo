/**
 * Phase 6 W10 PR15 — golden: follow-up turn (TTY).
 *
 * Scenario (plan line 589, examples/README.md §4): second prompt while a
 * session is active; continues as turn 2 — "Continuing session ...", no new-
 * session creation line.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/follow-up-turn.tty.txt: says 'Continuing session', not 'Starting new'", async () => {
  const fixture = await loadFixture("follow-up-turn.tty.txt");
  const plain = fixture.bytes.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, "");
  assert.ok(plain.includes("Continuing session"), "continuation phrase present");
  assert.ok(!plain.includes("Starting new session"), "must NOT say 'Starting new'");
});

test("golden/follow-up-turn.tty.txt: self-match", async () => {
  const fixture = await loadFixture("follow-up-turn.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
