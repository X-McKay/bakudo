/**
 * Phase 6 W10 PR15 — golden: empty-shell (plain).
 *
 * Scenario (plan line 589, examples/README.md §2): same empty-shell state
 * under `--plain` / non-TTY / `NO_COLOR=1`; ANSI stripped, semantic content
 * identical to the TTY variant.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/empty-shell.plain.txt: contains no ANSI bytes", async () => {
  const fixture = await loadFixture("empty-shell.plain.txt");
  assert.ok(fixture.raw.includes("empty-shell-plain"), "scenario header present");
  assert.equal(fixture.bytes.includes("\u001B"), false, "plain fixture has no ESC");
  assert.ok(fixture.bytes.includes("Bakudo"), "brand text present");
});

test("golden/empty-shell.plain.txt: comparator self-match is equal", async () => {
  const fixture = await loadFixture("empty-shell.plain.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
