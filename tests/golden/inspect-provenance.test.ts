/**
 * Phase 6 W10 PR15 — golden: /inspect provenance tab (TTY).
 *
 * Scenario (plan line 589, examples/README.md §8): /inspect provenance tab.
 * Renders agent profile, compiled attempt spec, dispatch command, sandbox
 * task ID, permission matches, approval timeline, env snapshot, exit info.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/inspect-provenance.tty.txt: marks provenance tab as selected", async () => {
  const fixture = await loadFixture("inspect-provenance.tty.txt");
  assert.ok(fixture.bytes.includes("[provenance]"));
});

test("golden/inspect-provenance.tty.txt: self-match", async () => {
  const fixture = await loadFixture("inspect-provenance.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});

// W6E cleanup PR15-NB5 — content anchors for Phase 4 W4 "Provenance Tab
// Layout" section order. A fixture regen that dropped one of these would
// otherwise only be caught by human review.
test("golden/inspect-provenance.tty.txt: renders provenance section anchors", async () => {
  const fixture = await loadFixture("inspect-provenance.tty.txt");
  for (const anchor of ["Agent profile", "Attempt spec", "abox dispatch command"]) {
    assert.ok(fixture.bytes.includes(anchor), `provenance fixture missing "${anchor}" anchor`);
  }
});
