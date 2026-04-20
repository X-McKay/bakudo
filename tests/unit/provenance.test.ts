import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hydratePermissionRule, type PermissionRule } from "../../src/attemptProtocol.js";
import {
  PROVENANCE_RECORD_SCHEMA_VERSION,
  ProvenanceRecordSchema,
  appendProvenanceRecord,
  createProvenanceRecord,
  finalizeProvenanceRecord,
  hydrateProvenanceRecord,
  listSessionProvenance,
  listTurnProvenance,
  loadProvenance,
  provenanceFilePath,
  type ProvenanceRecord,
} from "../../src/host/provenance.js";

const shellAllow: PermissionRule = hydratePermissionRule({
  effect: "allow",
  tool: "shell",
  pattern: "*",
  source: "agent_profile",
});

const baseRecord = (overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord =>
  createProvenanceRecord({
    sessionId: "session-p",
    turnId: "turn-1",
    attemptId: "attempt-1",
    repoRoot: "/tmp/repo",
    workerEngine: "agent_cli",
    composerMode: "standard",
    taskMode: "build",
    agentProfile: { name: "standard", autopilot: false },
    permissionRulesSnapshot: [shellAllow],
    ...overrides,
  });

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-prov-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Factory + schema
// ---------------------------------------------------------------------------

test("createProvenanceRecord fills schemaVersion, provenanceId, startedAt, defaults", () => {
  const rec = baseRecord();
  assert.equal(rec.schemaVersion, PROVENANCE_RECORD_SCHEMA_VERSION);
  assert.ok(rec.provenanceId.startsWith("provenance-"));
  assert.ok(rec.startedAt.length > 0);
  assert.deepEqual(rec.dispatchCommand, []);
  assert.deepEqual(rec.envAllowlist, []);
  assert.equal(rec.finishedAt, undefined);
  assert.equal(rec.exit, undefined);
});

test("createProvenanceRecord respects provenanceId + startedAt overrides", () => {
  const rec = baseRecord({ provenanceId: "provenance-fixed", startedAt: "2026-01-01T00:00:00Z" });
  assert.equal(rec.provenanceId, "provenance-fixed");
  assert.equal(rec.startedAt, "2026-01-01T00:00:00Z");
});

test("ProvenanceRecordSchema round-trips a record", () => {
  const rec = baseRecord();
  const parsed = ProvenanceRecordSchema.parse(rec);
  const hydrated = hydrateProvenanceRecord(parsed);
  assert.equal(hydrated.provenanceId, rec.provenanceId);
  assert.equal(hydrated.permissionRulesSnapshot[0]?.ruleId, shellAllow.ruleId);
});

test("ProvenanceRecordSchema tolerates permissionRulesSnapshot rules without ruleId/scope", () => {
  const raw = {
    schemaVersion: PROVENANCE_RECORD_SCHEMA_VERSION,
    provenanceId: "provenance-legacy",
    sessionId: "s",
    turnId: "t",
    attemptId: "a",
    repoRoot: "/r",
    dispatchCommand: [],
    workerEngine: "agent_cli" as const,
    composerMode: "standard" as const,
    taskMode: "build" as const,
    agentProfile: { name: "standard", autopilot: false },
    permissionRulesSnapshot: [
      { effect: "allow", tool: "shell", pattern: "*", source: "agent_profile" },
    ],
    envAllowlist: [],
    startedAt: "2026-01-01T00:00:00Z",
  };
  const parsed = ProvenanceRecordSchema.parse(raw);
  const hydrated = hydrateProvenanceRecord(parsed);
  assert.ok(hydrated.permissionRulesSnapshot[0]?.ruleId.startsWith("rule-"));
  assert.equal(hydrated.permissionRulesSnapshot[0]?.scope, "session");
});

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

test("finalizeProvenanceRecord merges exit, finishedAt, dispatchCommand, sandboxTaskId", () => {
  const start = baseRecord();
  const finalized = finalizeProvenanceRecord(start, {
    finishedAt: "2026-02-02T00:00:00Z",
    exit: { exitCode: 0, exitSignal: null, timedOut: false, elapsedMs: 1234 },
    dispatchCommand: ["abox", "run", "--task", "abc"],
    sandboxTaskId: "sandbox-xyz",
  });
  assert.equal(finalized.provenanceId, start.provenanceId);
  assert.equal(finalized.finishedAt, "2026-02-02T00:00:00Z");
  assert.deepEqual(finalized.exit, {
    exitCode: 0,
    exitSignal: null,
    timedOut: false,
    elapsedMs: 1234,
  });
  assert.deepEqual(finalized.dispatchCommand, ["abox", "run", "--task", "abc"]);
  assert.equal(finalized.sandboxTaskId, "sandbox-xyz");
});

test("finalizeProvenanceRecord preserves prior fields when finalize is minimal", () => {
  const start = baseRecord({ dispatchCommand: ["abox", "run"] });
  const finalized = finalizeProvenanceRecord(start, {
    exit: { exitCode: 0, exitSignal: null, timedOut: false, elapsedMs: 100 },
  });
  assert.deepEqual(finalized.dispatchCommand, ["abox", "run"]);
  assert.equal(finalized.sandboxTaskId, undefined);
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test("provenanceFilePath lives under <storageRoot>/<sessionId>/provenance.ndjson", () => {
  assert.equal(
    provenanceFilePath("/srv/.bakudo/sessions", "session-x"),
    "/srv/.bakudo/sessions/session-x/provenance.ndjson",
  );
});

// ---------------------------------------------------------------------------
// Store — append, load, listTurn, listSession, last-write-wins
// ---------------------------------------------------------------------------

test("appendProvenanceRecord + loadProvenance roundtrip on a single attempt", async () => {
  await withTempRoot(async (root) => {
    const rec = baseRecord();
    await appendProvenanceRecord(root, rec);
    const found = await loadProvenance(root, rec.sessionId, rec.attemptId);
    assert.equal(found?.provenanceId, rec.provenanceId);
  });
});

test("loadProvenance returns null when the file does not exist", async () => {
  await withTempRoot(async (root) => {
    const found = await loadProvenance(root, "session-absent", "attempt-x");
    assert.equal(found, null);
  });
});

test("last-write-wins: finalize record overrides start", async () => {
  await withTempRoot(async (root) => {
    const start = baseRecord({ dispatchCommand: [] });
    await appendProvenanceRecord(root, start);
    const finalized = finalizeProvenanceRecord(start, {
      exit: { exitCode: 0, exitSignal: null, timedOut: false, elapsedMs: 500 },
      dispatchCommand: ["abox", "run"],
      sandboxTaskId: "sb-1",
    });
    await appendProvenanceRecord(root, finalized);
    const found = await loadProvenance(root, start.sessionId, start.attemptId);
    assert.equal(found?.sandboxTaskId, "sb-1");
    assert.deepEqual(found?.dispatchCommand, ["abox", "run"]);
    assert.equal(found?.exit?.elapsedMs, 500);
  });
});

test("loadProvenance prefers the newest record when attemptId is reused with a new provenanceId", async () => {
  await withTempRoot(async (root) => {
    const first = baseRecord({
      sessionId: "session-reused",
      turnId: "turn-1",
      attemptId: "attempt-1",
      dispatchCommand: ["abox", "run", "--task", "old"],
    });
    const second = baseRecord({
      sessionId: "session-reused",
      turnId: "turn-1",
      attemptId: "attempt-1",
      dispatchCommand: ["abox", "run", "--task", "new"],
    });
    await appendProvenanceRecord(root, first);
    await appendProvenanceRecord(root, second);

    const found = await loadProvenance(root, "session-reused", "attempt-1");
    assert.equal(found?.provenanceId, second.provenanceId);
    assert.deepEqual(found?.dispatchCommand, ["abox", "run", "--task", "new"]);
  });
});

test("listTurnProvenance filters by turnId", async () => {
  await withTempRoot(async (root) => {
    await appendProvenanceRecord(root, baseRecord({ turnId: "t1", attemptId: "a1" }));
    await appendProvenanceRecord(root, baseRecord({ turnId: "t2", attemptId: "a2" }));
    await appendProvenanceRecord(root, baseRecord({ turnId: "t1", attemptId: "a3" }));
    const t1 = await listTurnProvenance(root, "session-p", "t1");
    assert.equal(t1.length, 2);
    assert.ok(t1.every((rec) => rec.turnId === "t1"));
  });
});

test("listSessionProvenance returns one folded record per attempt across turns", async () => {
  await withTempRoot(async (root) => {
    const start1 = baseRecord({ attemptId: "a1" });
    const finalize1 = finalizeProvenanceRecord(start1, {
      exit: { exitCode: 0, exitSignal: null, timedOut: false, elapsedMs: 10 },
    });
    const start2 = baseRecord({ attemptId: "a2", turnId: "t2" });
    await appendProvenanceRecord(root, start1);
    await appendProvenanceRecord(root, finalize1);
    await appendProvenanceRecord(root, start2);
    const all = await listSessionProvenance(root, "session-p");
    assert.equal(all.length, 2);
    const a1 = all.find((rec) => rec.attemptId === "a1");
    assert.ok(a1?.exit, "a1 should have exit after finalize");
  });
});

test("composerMode=autopilot is preserved on the persisted record", async () => {
  await withTempRoot(async (root) => {
    const rec = baseRecord({
      composerMode: "autopilot",
      agentProfile: { name: "autopilot", autopilot: true },
    });
    await appendProvenanceRecord(root, rec);
    const found = await loadProvenance(root, rec.sessionId, rec.attemptId);
    assert.equal(found?.composerMode, "autopilot");
    assert.equal(found?.agentProfile.autopilot, true);
  });
});

test("permissionRulesSnapshot round-trips with ruleId + scope", async () => {
  await withTempRoot(async (root) => {
    const rec = baseRecord({ permissionRulesSnapshot: [shellAllow] });
    await appendProvenanceRecord(root, rec);
    const found = await loadProvenance(root, rec.sessionId, rec.attemptId);
    assert.equal(found?.permissionRulesSnapshot[0]?.ruleId, shellAllow.ruleId);
    assert.equal(found?.permissionRulesSnapshot[0]?.scope, "session");
  });
});
