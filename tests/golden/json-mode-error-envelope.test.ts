/**
 * Phase 6 W10 PR15 — golden: JSON error envelope.
 *
 * Scenario (plan line 589, examples/README.md §13): a single top-level
 * error envelope returned in JSON mode for the protocol-mismatch
 * condition. Shape fixed by `src/host/errors.ts::JsonErrorEnvelope`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

type Envelope = {
  ok: boolean;
  kind: string;
  error: { code: string; message: string; details?: Record<string, unknown> };
};

test("golden/json-mode-error-envelope.json: parses and matches shape", async () => {
  const fixture = await loadFixture("json-mode-error-envelope.json");
  const env = JSON.parse(fixture.bytes) as Envelope;
  assert.equal(env.ok, false);
  assert.equal(env.kind, "error");
  assert.equal(env.error.code, "worker_protocol_mismatch");
  assert.equal(typeof env.error.message, "string");
});

test("golden/json-mode-error-envelope.json: self-match", async () => {
  const fixture = await loadFixture("json-mode-error-envelope.json");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
