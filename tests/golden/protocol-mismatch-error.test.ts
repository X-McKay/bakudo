/**
 * Phase 6 W10 PR15 — golden: protocol mismatch error (plain).
 *
 * Scenario (plan line 589, examples/README.md §11): host needs protocol v3;
 * older abox reports protocol v1 only. WorkerProtocolMismatchError fires
 * before dispatch. Exit code 4; stable error code
 * `worker_protocol_mismatch`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/protocol-mismatch-error.plain.txt: advertises the stable error code", async () => {
  const fixture = await loadFixture("protocol-mismatch-error.plain.txt");
  assert.ok(fixture.bytes.includes("worker_protocol_mismatch"));
});

test("golden/protocol-mismatch-error.plain.txt: plain (no ANSI)", async () => {
  const fixture = await loadFixture("protocol-mismatch-error.plain.txt");
  assert.equal(fixture.bytes.includes("\u001B"), false);
});

test("golden/protocol-mismatch-error.plain.txt: self-match", async () => {
  const fixture = await loadFixture("protocol-mismatch-error.plain.txt");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
