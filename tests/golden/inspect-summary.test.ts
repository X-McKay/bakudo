/**
 * Phase 6 W10 PR15 — golden: /inspect summary tab (TTY).
 *
 * Scenario (plan line 589, examples/README.md §7): /inspect default summary
 * tab for an active session turn. Fields rendered in priority order.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/inspect-summary.tty.txt: marks summary tab as selected", async () => {
  const fixture = await loadFixture("inspect-summary.tty.txt");
  assert.ok(fixture.bytes.includes("[summary]"));
});

test("golden/inspect-summary.tty.txt: self-match", async () => {
  const fixture = await loadFixture("inspect-summary.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});

// W6E cleanup PR15-NB5 — content-level anchors guard against fixture drift
// regenerating past a tab-layout change without a human noticing. The
// priority-order label set comes from Phase 1 W5 / Phase 4 W4.
test("golden/inspect-summary.tty.txt: renders priority-order section anchors", async () => {
  const fixture = await loadFixture("inspect-summary.tty.txt");
  for (const anchor of ["Prompt:", "Outcome:", "Attempt:", "Artifacts:"]) {
    assert.ok(fixture.bytes.includes(anchor), `summary fixture missing "${anchor}" anchor`);
  }
});
