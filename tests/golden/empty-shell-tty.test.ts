/**
 * Phase 6 W10 PR15 — golden: empty-shell (TTY).
 *
 * Scenario (plan line 589, examples/README.md §1): opening `bakudo` with no
 * active session on a TTY; transcript-first empty state with minimal ANSI.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  diffAgainstFixture,
  loadFixture,
  regenerateFixture,
  regenerationRequested,
} from "../helpers/golden.js";

test("golden/empty-shell.tty.txt: decodes to real CSI sequences", async () => {
  const fixture = await loadFixture("empty-shell.tty.txt");
  assert.ok(fixture.raw.includes("empty-shell-tty"), "scenario header present");
  assert.ok(fixture.body.length > 0, "non-empty body after comment strip");
  assert.ok(fixture.bytes.includes("\u001B["), "decodes to real CSI");
  assert.ok(!fixture.bytes.includes("\\e["), "no literal escapes remain");
});

test("golden/empty-shell.tty.txt: comparator self-match is equal", async () => {
  const fixture = await loadFixture("empty-shell.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});

test("golden/empty-shell.tty.txt: regeneration is gated on explicit opt-in", async () => {
  if (!regenerationRequested()) return;
  const fixture = await loadFixture("empty-shell.tty.txt");
  await regenerateFixture(fixture, fixture.bytes);
});
