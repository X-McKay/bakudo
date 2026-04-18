/**
 * Phase 6 W10 PR15 — golden: JSON-mode session events (JSONL).
 *
 * Scenario (plan line 589, examples/README.md §12): `bakudo
 * --output-format=json` capturing a full successful turn. One
 * SessionEventEnvelope per line, covering the full host/worker lifecycle.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diffAgainstFixture, loadFixture } from "../helpers/golden.js";

test("golden/json-mode-session-events.jsonl: every line parses as JSON", async () => {
  const fixture = await loadFixture("json-mode-session-events.jsonl");
  const lines = fixture.bytes.split("\n").filter((l) => l.trim().length > 0);
  assert.ok(lines.length >= 5, `expected >= 5 JSONL entries, got ${lines.length}`);
  for (const line of lines) {
    JSON.parse(line); // throws on invalid JSON
  }
});

test("golden/json-mode-session-events.jsonl: every envelope declares schemaVersion=2", async () => {
  const fixture = await loadFixture("json-mode-session-events.jsonl");
  const lines = fixture.bytes.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const env = JSON.parse(line) as { schemaVersion?: number };
    assert.equal(env.schemaVersion, 2, `envelope must be v2: ${line.slice(0, 80)}`);
  }
});

test("golden/json-mode-session-events.jsonl: self-match", async () => {
  const fixture = await loadFixture("json-mode-session-events.jsonl");
  assert.equal(diffAgainstFixture(fixture, fixture.bytes).kind, "equal");
});
