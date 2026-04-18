/**
 * Phase 6 W10 PR15 — golden: doctor output.
 *
 * Scenario (plan line 589, examples/README.md §14): `bakudo doctor
 * --output-format=json` on a healthy host. Shape fixed by
 * `src/host/commands/doctorEnvelopeTypes.ts::DoctorEnvelope`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

type Doctor = {
  name: string;
  bakudoVersion: string;
  status: string;
  checks: Array<{ name: string; status: string; summary: string }>;
  node: { runtime: string; required: number };
  telemetry: { enabled: boolean; droppedEventBatches: number };
  storage: { totalArtifactBytes: number };
};

test("golden/doctor-output.json: parses as a DoctorEnvelope", async () => {
  const fixture = await loadFixture("doctor-output.json");
  const env = JSON.parse(fixture.bytes) as Doctor;
  assert.equal(env.name, "bakudo-doctor");
  assert.ok(env.checks.length >= 4, "expect >= 4 doctor checks");
  assert.equal(env.node.required, 22);
});

test("golden/doctor-output.json: self-match", async () => {
  const fixture = await loadFixture("doctor-output.json");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
