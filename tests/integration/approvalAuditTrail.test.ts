import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hydratePermissionRule } from "../../src/attemptProtocol.js";
import type { SessionEventEnvelope } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import {
  appendApprovalRecord,
  createApprovalRecord,
  listTurnApprovals,
} from "../../src/host/approvalStore.js";
import { formatInspectTab } from "../../src/host/inspectTabs.js";

/**
 * Integration test: persist two ApprovalRecord entries for a single turn,
 * open the approvals tab, assert chronological ordering and that the
 * `host.approval_resolved` envelope detail is surfaced next to each record.
 */

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-audit-"));

test("approvals tab surfaces two persisted records in chronological order with envelope details", async () => {
  const root = await createTempRoot();
  try {
    const store = new SessionStore(root);
    const session = await store.createSession({
      sessionId: "session-audit-1",
      goal: "approvals audit",
      repoRoot: "/tmp",
      assumeDangerousSkipPermissions: false,
      status: "running",
      turns: [
        {
          turnId: "turn-1",
          prompt: "approvals audit",
          mode: "build",
          status: "running",
          attempts: [],
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    });

    const matchedRule = hydratePermissionRule({
      effect: "ask",
      tool: "shell",
      pattern: "*",
      source: "agent_profile",
    });

    const early = createApprovalRecord({
      sessionId: session.sessionId,
      turnId: "turn-1",
      attemptId: "attempt-1",
      request: {
        tool: "shell",
        argument: "ls -la",
        displayCommand: "shell(ls -la)",
      },
      matchedRule,
      decision: "approved",
      decidedBy: "user_prompt",
      rationale: "trivial read",
      policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
      requestedAt: "2026-04-15T00:00:05.000Z",
      decidedAt: "2026-04-15T00:00:06.000Z",
      approvalId: "approval-audit-early",
    });

    const late = createApprovalRecord({
      sessionId: session.sessionId,
      turnId: "turn-1",
      attemptId: "attempt-1",
      request: {
        tool: "shell",
        argument: "git push origin main",
        displayCommand: "shell(git push origin main)",
      },
      matchedRule,
      decision: "denied",
      decidedBy: "user_prompt",
      rationale: "cannot push yet",
      policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
      requestedAt: "2026-04-15T00:01:00.000Z",
      decidedAt: "2026-04-15T00:01:02.000Z",
      approvalId: "approval-audit-late",
    });

    // Append out-of-order to exercise the sort inside the renderer.
    await appendApprovalRecord(root, late);
    await appendApprovalRecord(root, early);

    const approvals = await listTurnApprovals(root, session.sessionId, "turn-1");
    assert.equal(approvals.length, 2);

    // Synthetic host.approval_resolved envelopes carrying extra detail the
    // approval records alone do not express (per-envelope `decidedBy`).
    const envelopes: SessionEventEnvelope[] = [
      {
        schemaVersion: 2,
        eventId: "evt-resolved-early",
        sessionId: session.sessionId,
        turnId: "turn-1",
        attemptId: "attempt-1",
        actor: "host",
        kind: "host.approval_resolved",
        timestamp: early.decidedAt,
        payload: {
          approvalId: early.approvalId,
          decision: early.decision,
          decidedBy: early.decidedBy,
          matchedRule: early.matchedRule,
          rationale: early.rationale,
          decidedAt: early.decidedAt,
        },
      },
      {
        schemaVersion: 2,
        eventId: "evt-resolved-late",
        sessionId: session.sessionId,
        turnId: "turn-1",
        attemptId: "attempt-1",
        actor: "host",
        kind: "host.approval_resolved",
        timestamp: late.decidedAt,
        payload: {
          approvalId: late.approvalId,
          decision: late.decision,
          decidedBy: late.decidedBy,
          matchedRule: late.matchedRule,
          rationale: late.rationale,
          decidedAt: late.decidedAt,
        },
      },
    ];

    const turn = session.turns[0]!;
    const lines = formatInspectTab("approvals", {
      session,
      turn,
      artifacts: [],
      events: [],
      approvals,
      envelopes,
    });
    assert.equal(lines[0], "Approvals");
    const joined = lines.join("\n");
    assert.match(joined, /Count.*2/);

    const idxEarly = lines.findIndex((line) => line.includes("shell(ls -la)"));
    const idxLate = lines.findIndex((line) => line.includes("shell(git push origin main)"));
    assert.ok(idxEarly > 0, "early approval surfaced");
    assert.ok(idxLate > 0, "late approval surfaced");
    assert.ok(idxEarly < idxLate, "chronological: earlier approval renders above later one");

    // Rationale from both records surfaces.
    assert.match(joined, /trivial read/);
    assert.match(joined, /cannot push yet/);

    // host.approval_resolved envelope details are rendered next to the record.
    assert.match(joined, /envelope decidedBy: user_prompt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
