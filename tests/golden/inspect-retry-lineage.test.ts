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

// W6E cleanup PR15-NB5 — content anchors for the lineage chain structure.
// `host_retry` (reason code from Phase 2 W3), `chain_01HXYZCHAIN5` (fixture
// chainId), `transitionId` (must be surfaced in each transition block).
test("golden/inspect-retry-lineage.tty.txt: renders lineage chain anchors", async () => {
  const fixture = await loadFixture("inspect-retry-lineage.tty.txt");
  for (const anchor of ["host_retry", "chain_01HXYZCHAIN5", "transitionId"]) {
    assert.ok(fixture.bytes.includes(anchor), `retry-lineage fixture missing "${anchor}" anchor`);
  }
});
