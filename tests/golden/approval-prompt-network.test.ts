/**
 * Phase 6 W10 PR15 — golden: approval prompt (network).
 *
 * Scenario (plan line 589, examples/README.md §6): worker requests
 * `network(api.github.com)` in standard mode; prompt proposes
 * `network(*.github.com)` as the "always" pattern.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/approval-prompt-network.tty.txt: proposes network(*.github.com)", async () => {
  const fixture = await loadFixture("approval-prompt-network.tty.txt");
  assert.ok(fixture.bytes.includes("network(*.github.com)"));
});

test("golden/approval-prompt-network.tty.txt: preserves four-choice UX copy", async () => {
  const fixture = await loadFixture("approval-prompt-network.tty.txt");
  const plain = fixture.bytes.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, "");
  for (const marker of ["[1] allow once", "[2] allow always", "[3] deny", "[4] show context"]) {
    assert.ok(plain.includes(marker), `missing ${marker}`);
  }
});

test("golden/approval-prompt-network.tty.txt: self-match", async () => {
  const fixture = await loadFixture("approval-prompt-network.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
