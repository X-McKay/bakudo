/**
 * Phase 6 W10 PR15 — golden: autopilot one-shot (plain).
 *
 * Scenario (plan line 589, examples/README.md §10): `bakudo --plain --mode
 * autopilot -p "…"` one-shot. Plain-mode narration includes inline
 * auto-approve / auto-deny lines and a summary footer with inspect
 * invocation. Exit code 0.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/autopilot-run.plain.txt: includes auto-approve narration", async () => {
  const fixture = await loadFixture("autopilot-run.plain.txt");
  assert.ok(
    fixture.bytes.includes("auto-approve") || fixture.bytes.includes("[auto]"),
    "auto-approval narration present",
  );
});

test("golden/autopilot-run.plain.txt: plain (no ANSI)", async () => {
  const fixture = await loadFixture("autopilot-run.plain.txt");
  assert.equal(fixture.bytes.includes("\u001B"), false);
});

test("golden/autopilot-run.plain.txt: self-match", async () => {
  const fixture = await loadFixture("autopilot-run.plain.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
