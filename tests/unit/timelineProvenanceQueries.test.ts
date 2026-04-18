import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hydratePermissionRule } from "../../src/attemptProtocol.js";
import {
  appendProvenanceRecord,
  createProvenanceRecord,
  finalizeProvenanceRecord,
} from "../../src/host/provenance.js";
import {
  listSessionProvenanceRecords,
  listTurnProvenanceRecords,
  loadAttemptProvenance,
} from "../../src/host/timeline.js";

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-tlprov-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const rule = hydratePermissionRule({
  effect: "allow",
  tool: "shell",
  pattern: "*",
  source: "agent_profile",
});

const makeRecord = (sessionId: string, turnId: string, attemptId: string) =>
  createProvenanceRecord({
    sessionId,
    turnId,
    attemptId,
    repoRoot: "/r",
    workerEngine: "agent_cli",
    composerMode: "standard",
    taskMode: "build",
    agentProfile: { name: "standard", autopilot: false },
    permissionRulesSnapshot: [rule],
  });

// ---------------------------------------------------------------------------

test("timeline.loadAttemptProvenance returns null when missing", async () => {
  await withTempRoot(async (root) => {
    const got = await loadAttemptProvenance(root, "session-absent", "attempt-x");
    assert.equal(got, null);
  });
});

test("timeline.loadAttemptProvenance returns the folded record", async () => {
  await withTempRoot(async (root) => {
    const start = makeRecord("s", "t", "a");
    const finalized = finalizeProvenanceRecord(start, {
      exit: { exitCode: 0, exitSignal: null, timedOut: false, elapsedMs: 42 },
      dispatchCommand: ["abox"],
    });
    await appendProvenanceRecord(root, start);
    await appendProvenanceRecord(root, finalized);
    const got = await loadAttemptProvenance(root, "s", "a");
    assert.equal(got?.provenanceId, start.provenanceId);
    assert.equal(got?.exit?.elapsedMs, 42);
    assert.deepEqual(got?.dispatchCommand, ["abox"]);
  });
});

test("timeline.listTurnProvenanceRecords returns per-turn records", async () => {
  await withTempRoot(async (root) => {
    await appendProvenanceRecord(root, makeRecord("s", "t1", "a1"));
    await appendProvenanceRecord(root, makeRecord("s", "t2", "a2"));
    await appendProvenanceRecord(root, makeRecord("s", "t1", "a3"));
    const t1 = await listTurnProvenanceRecords(root, "s", "t1");
    assert.equal(t1.length, 2);
    assert.ok(t1.every((r) => r.turnId === "t1"));
  });
});

test("timeline.listSessionProvenanceRecords returns all session records", async () => {
  await withTempRoot(async (root) => {
    await appendProvenanceRecord(root, makeRecord("s", "t1", "a1"));
    await appendProvenanceRecord(root, makeRecord("s", "t2", "a2"));
    const all = await listSessionProvenanceRecords(root, "s");
    assert.equal(all.length, 2);
  });
});
