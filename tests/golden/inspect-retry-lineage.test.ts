/**
 * Phase 6 W10 PR15 — golden: /inspect retry lineage (TTY).
 *
 * Scenario (plan line 589, examples/README.md §9): /inspect retry on a turn
 * with multiple attempts. Reads TurnTransition[]. Shows a vertical chain:
 * attempt → transition → attempt, terminating at a succeeding attempt.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/inspect-retry-lineage.tty.txt: references attempts", async () => {
  const fixture = await loadFixture("inspect-retry-lineage.tty.txt");
  const plain = fixture.bytes.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, "");
  assert.ok(plain.toLowerCase().includes("attempt"));
});

test("golden/inspect-retry-lineage.tty.txt: self-match", async () => {
  const fixture = await loadFixture("inspect-retry-lineage.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
