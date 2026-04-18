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
