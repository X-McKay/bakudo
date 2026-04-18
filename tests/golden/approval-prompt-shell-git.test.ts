/**
 * Phase 6 W10 PR15 — golden: approval prompt (shell git push).
 *
 * Scenario (plan line 589, examples/README.md §5): worker requests
 * `shell(git push origin main)` in standard mode; no allow rule matches.
 * Approval prompt shows the four choices (once / always / deny / inspect).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/approval-prompt-shell-git.tty.txt: renders four-choice copy", async () => {
  const fixture = await loadFixture("approval-prompt-shell-git.tty.txt");
  const plain = fixture.bytes.replace(/\u001B\[[0-9;]*[A-Za-z]/gu, "");
  assert.ok(plain.includes("[1] allow once"));
  assert.ok(plain.includes("[2] allow always for"));
  assert.ok(plain.includes("[3] deny"));
  assert.ok(plain.includes("[4] show context"));
});

test("golden/approval-prompt-shell-git.tty.txt: mentions shell(git push:*) pattern", async () => {
  const fixture = await loadFixture("approval-prompt-shell-git.tty.txt");
  assert.ok(fixture.bytes.includes("shell(git push:*)"));
});

test("golden/approval-prompt-shell-git.tty.txt: self-match", async () => {
  const fixture = await loadFixture("approval-prompt-shell-git.tty.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
