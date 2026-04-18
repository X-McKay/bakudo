import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hydratePermissionRule, type PermissionRule } from "../../src/attemptProtocol.js";
import {
  APPROVAL_RECORD_SCHEMA_VERSION,
  ApprovalRecordSchema,
  appendApprovalRecord,
  approvalsFilePath,
  createApprovalRecord,
  durableAllowlistPath,
  hydrateApprovalRecord,
  listSessionApprovals,
  listTurnApprovals,
  loadApproval,
  loadDurableAllowlist,
  persistDurableRule,
  type ApprovalRecord,
} from "../../src/host/approvalStore.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const matchedRule: PermissionRule = hydratePermissionRule({
  effect: "allow",
  tool: "shell",
  pattern: "*",
  source: "agent_profile",
});

const baseRecord = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord =>
  createApprovalRecord({
    sessionId: "session-abc",
    turnId: "turn-1",
    attemptId: "attempt-1",
    request: {
      tool: "shell",
      argument: "git push origin main",
      displayCommand: "shell(git push origin main)",
    },
    matchedRule,
    decision: "approved",
    decidedBy: "user_prompt",
    rationale: "user confirmed once",
    policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
    ...overrides,
  });

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-approval-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Factory + schema
// ---------------------------------------------------------------------------

test("createApprovalRecord fills schemaVersion, approvalId, requestedAt, decidedAt", () => {
  const rec = baseRecord();
  assert.equal(rec.schemaVersion, APPROVAL_RECORD_SCHEMA_VERSION);
  assert.ok(rec.approvalId.startsWith("approval-"));
  assert.ok(rec.requestedAt.length > 0);
  assert.ok(rec.decidedAt.length > 0);
});

test("ApprovalRecordSchema round-trips a record", () => {
  const rec = baseRecord();
  const parsed = ApprovalRecordSchema.parse(rec);
  // Hydrator is required to recover the strict PermissionRule shape.
  const hydrated = hydrateApprovalRecord(parsed);
  assert.equal(hydrated.approvalId, rec.approvalId);
  assert.equal(hydrated.matchedRule.ruleId, matchedRule.ruleId);
  assert.equal(hydrated.matchedRule.scope, "session");
});

test("ApprovalRecordSchema tolerates a rule missing ruleId/scope on read", () => {
  // Older on-disk record (pre-Phase-4) without ruleId or scope on its rule.
  const raw = {
    schemaVersion: APPROVAL_RECORD_SCHEMA_VERSION,
    approvalId: "approval-legacy",
    sessionId: "s",
    turnId: "t",
    request: { tool: "shell", argument: "ls", displayCommand: "shell(ls)" },
    matchedRule: {
      effect: "allow",
      tool: "shell",
      pattern: "*",
      source: "agent_profile",
    },
    decision: "approved",
    decidedBy: "user_prompt",
    decidedAt: "2026-01-01T00:00:00.000Z",
    requestedAt: "2026-01-01T00:00:00.000Z",
    rationale: "",
    policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
  };
  const parsed = ApprovalRecordSchema.parse(raw);
  const hydrated = hydrateApprovalRecord(parsed);
  assert.ok(hydrated.matchedRule.ruleId.startsWith("rule-"));
  assert.equal(hydrated.matchedRule.scope, "session");
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

test("approvalsFilePath lives under <storageRoot>/<sessionId>/approvals.ndjson", () => {
  const p = approvalsFilePath("/srv/.bakudo/sessions", "session-xyz");
  assert.equal(p, "/srv/.bakudo/sessions/session-xyz/approvals.ndjson");
});

test("durableAllowlistPath lives at <repoRoot>/.bakudo/approvals.jsonl", () => {
  const p = durableAllowlistPath("/home/me/project");
  assert.equal(p, "/home/me/project/.bakudo/approvals.jsonl");
});

// ---------------------------------------------------------------------------
// Per-session append + read roundtrip
// ---------------------------------------------------------------------------

test("appendApprovalRecord + listSessionApprovals roundtrip", async () => {
  await withTempRoot(async (storageRoot) => {
    const a = baseRecord({ sessionId: "s1", turnId: "t1", decision: "approved" });
    const b = baseRecord({ sessionId: "s1", turnId: "t1", decision: "denied" });
    const c = baseRecord({ sessionId: "s1", turnId: "t2", decision: "auto_approved" });
    await appendApprovalRecord(storageRoot, a);
    await appendApprovalRecord(storageRoot, b);
    await appendApprovalRecord(storageRoot, c);

    const all = await listSessionApprovals(storageRoot, "s1");
    assert.equal(all.length, 3);
    // NDJSON preserves insertion order.
    assert.equal(all[0]?.approvalId, a.approvalId);
    assert.equal(all[1]?.approvalId, b.approvalId);
    assert.equal(all[2]?.approvalId, c.approvalId);
  });
});

test("listSessionApprovals returns [] when the file does not exist", async () => {
  await withTempRoot(async (storageRoot) => {
    const all = await listSessionApprovals(storageRoot, "session-absent");
    assert.deepEqual(all, []);
  });
});

test("listTurnApprovals filters by turnId", async () => {
  await withTempRoot(async (storageRoot) => {
    await appendApprovalRecord(storageRoot, baseRecord({ sessionId: "s", turnId: "t1" }));
    await appendApprovalRecord(storageRoot, baseRecord({ sessionId: "s", turnId: "t2" }));
    await appendApprovalRecord(storageRoot, baseRecord({ sessionId: "s", turnId: "t1" }));
    const t1 = await listTurnApprovals(storageRoot, "s", "t1");
    assert.equal(t1.length, 2);
    assert.ok(t1.every((rec) => rec.turnId === "t1"));
  });
});

test("loadApproval finds by approvalId, returns null when absent", async () => {
  await withTempRoot(async (storageRoot) => {
    const rec = baseRecord({ sessionId: "s", turnId: "t" });
    await appendApprovalRecord(storageRoot, rec);
    const found = await loadApproval(storageRoot, "s", rec.approvalId);
    assert.equal(found?.approvalId, rec.approvalId);
    const missing = await loadApproval(storageRoot, "s", "approval-unknown");
    assert.equal(missing, null);
  });
});

// ---------------------------------------------------------------------------
// Durable allowlist
// ---------------------------------------------------------------------------

test("persistDurableRule + loadDurableAllowlist roundtrip", async () => {
  await withTempRoot(async (repoRoot) => {
    const alwaysRule: PermissionRule = hydratePermissionRule({
      effect: "allow",
      tool: "shell",
      pattern: "git push:*",
      source: "user_interactive",
      scope: "always",
    });
    await persistDurableRule(repoRoot, alwaysRule);
    const loaded = await loadDurableAllowlist(repoRoot);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.pattern, "git push:*");
    assert.equal(loaded[0]?.scope, "always");
  });
});

test("loadDurableAllowlist returns [] when the file does not exist", async () => {
  await withTempRoot(async (repoRoot) => {
    const loaded = await loadDurableAllowlist(repoRoot);
    assert.deepEqual(loaded, []);
  });
});

test("durable allowlist file is plain NDJSON at the workspace .bakudo dir", async () => {
  await withTempRoot(async (repoRoot) => {
    const rule = hydratePermissionRule({
      effect: "allow",
      tool: "write",
      pattern: "src/**",
      source: "user_interactive",
      scope: "always",
    });
    await persistDurableRule(repoRoot, rule);
    const body = await readFile(durableAllowlistPath(repoRoot), "utf8");
    assert.ok(body.endsWith("\n"));
    const parsed = JSON.parse(body.trim()) as PermissionRule;
    assert.equal(parsed.ruleId, rule.ruleId);
  });
});
