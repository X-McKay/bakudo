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
