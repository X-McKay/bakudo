import assert from "node:assert/strict";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { hydratePermissionRule } from "../../src/attemptProtocol.js";
import type { SessionAttemptRecord, SessionRecord } from "../../src/sessionTypes.js";
import type { ApprovalRecord } from "../../src/host/approvalStore.js";
import { createApprovalRecord } from "../../src/host/approvalStore.js";
import { formatInspectProvenance } from "../../src/host/inspectTabs.js";
import type { ProvenanceRecord } from "../../src/host/provenance.js";

const buildSession = (): SessionRecord => ({
  schemaVersion: 2,
  sessionId: "session-prov",
  repoRoot: "/tmp/prov",
  title: "provenance fixture",
  status: "running",
  turns: [],
  createdAt: "2026-04-14T12:00:00.000Z",
  updatedAt: "2026-04-14T12:05:00.000Z",
});

const buildAttemptSpec = (): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "session-prov",
  turnId: "turn-1",
  attemptId: "attempt-prov",
  taskId: "task-prov",
  intentId: "intent-prov",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "do the thing",
  instructions: ["User prompt: do the thing"],
  cwd: "/tmp/prov",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 120, maxOutputBytes: 1_000_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-0", label: "things happened" }],
  artifactRequests: [{ name: "result.json", kind: "result", required: true }],
});

const buildAttempt = (overrides: Partial<SessionAttemptRecord> = {}): SessionAttemptRecord => ({
  attemptId: "attempt-prov",
  status: "succeeded",
  attemptSpec: buildAttemptSpec(),
  ...overrides,
});

const buildProvenance = (overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord => ({
  schemaVersion: 1,
  provenanceId: "provenance-test-1",
  sessionId: "session-prov",
  turnId: "turn-1",
  attemptId: "attempt-prov",
  repoRoot: "/tmp/prov/worktree",
  sandboxTaskId: "abox-sandbox-abc",
  dispatchCommand: ["abox", "--repo", "/tmp/prov", "run", "--task", "attempt-prov"],
  workerEngine: "agent_cli",
  composerMode: "standard",
  taskMode: "build",
  agentProfile: { name: "standard", autopilot: false },
  permissionRulesSnapshot: [],
  permissionFires: [
    {
      ruleId: "rule-shell-git-push",
      tool: "shell",
      target: "git push origin main",
      effect: "ask",
      firedAt: "2026-04-14T12:04:30.000Z",
    },
  ],
  envAllowlist: ["PATH", "HOME"],
  startedAt: "2026-04-14T12:04:00.000Z",
  finishedAt: "2026-04-14T12:05:00.000Z",
  exit: { exitCode: 0, exitSignal: null, timedOut: false, elapsedMs: 60000 },
  ...overrides,
});

const buildApproval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord =>
  createApprovalRecord({
    sessionId: "session-prov",
    turnId: "turn-1",
    attemptId: "attempt-prov",
    request: {
      tool: "shell",
      argument: "git push origin main",
      displayCommand: "shell(git push origin main)",
    },
    matchedRule: hydratePermissionRule({
      effect: "ask",
      tool: "shell",
      pattern: "git push*",
      source: "agent_profile",
    }),
    decision: "approved",
    decidedBy: "user_prompt",
    rationale: "user confirmed once",
    policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
    requestedAt: "2026-04-14T12:04:30.000Z",
    decidedAt: "2026-04-14T12:04:45.000Z",
    approvalId: "approval-test-1",
    ...overrides,
  });

const indexOf = (lines: string[], needle: string): number =>
  lines.findIndex((line) => line.includes(needle));

// ---------------------------------------------------------------------------

test("provenance tab: fully-populated record renders the 8 sections in order", () => {
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    provenance: buildProvenance(),
    approvals: [buildApproval()],
  });
  assert.equal(lines[0], "Provenance");
  // 1 — agent profile
  const agentIdx = indexOf(lines, "Active agent profile:");
  // 2 — compiled AttemptSpec
  const specIdx = indexOf(lines, "Compiled AttemptSpec:");
  // 3 — dispatch command (as array)
  const dispatchIdx = indexOf(lines, "abox dispatch command:");
  // 4 — sandbox task ID + worktree
  const sandboxIdx = indexOf(lines, "Sandbox");
  const worktreeIdx = indexOf(lines, "Worktree");
  // 5 — permission fires
  const fireIdx = indexOf(lines, "Permission rule matches:");
  // 6 — approval timeline
  const approvalIdx = indexOf(lines, "Approval timeline:");
  // 7 — env allowlist
  const envIdx = indexOf(lines, "Env allowlist snapshot:");
  // 8 — exit
  const exitIdx = indexOf(lines, "Exit details:");

  for (const idx of [
    agentIdx,
    specIdx,
    dispatchIdx,
    sandboxIdx,
    worktreeIdx,
    fireIdx,
    approvalIdx,
    envIdx,
    exitIdx,
  ]) {
    assert.ok(idx > 0, `section not found in ${JSON.stringify(lines)}`);
  }
  assert.ok(agentIdx < specIdx);
  assert.ok(specIdx < dispatchIdx);
  assert.ok(dispatchIdx < sandboxIdx);
  assert.ok(sandboxIdx <= worktreeIdx);
  assert.ok(worktreeIdx < fireIdx);
  assert.ok(fireIdx < approvalIdx);
  assert.ok(approvalIdx < envIdx);
  assert.ok(envIdx < exitIdx);
});

test("provenance tab: dispatchCommand renders each arg on its own line prefixed with `  - `", () => {
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    provenance: buildProvenance({
      dispatchCommand: ["abox", "run", "--task", "x"],
    }),
    approvals: [],
  });
  const listStart = indexOf(lines, "abox dispatch command:");
  assert.equal(lines[listStart + 1], "  - abox");
  assert.equal(lines[listStart + 2], "  - run");
  assert.equal(lines[listStart + 3], "  - --task");
  assert.equal(lines[listStart + 4], "  - x");
});

test("provenance tab: undefined permissionFires renders placeholder (PR2 records)", () => {
  const provenance = buildProvenance();
  const withoutFires: ProvenanceRecord = {
    schemaVersion: provenance.schemaVersion,
    provenanceId: provenance.provenanceId,
    sessionId: provenance.sessionId,
    turnId: provenance.turnId,
    attemptId: provenance.attemptId,
    repoRoot: provenance.repoRoot,
    dispatchCommand: provenance.dispatchCommand,
    workerEngine: provenance.workerEngine,
    composerMode: provenance.composerMode,
    taskMode: provenance.taskMode,
    agentProfile: provenance.agentProfile,
    permissionRulesSnapshot: provenance.permissionRulesSnapshot,
    envAllowlist: provenance.envAllowlist,
    startedAt: provenance.startedAt,
  };
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    provenance: withoutFires,
    approvals: [],
  });
  const joined = lines.join("\n");
  assert.match(joined, /Permission rule matches:/);
  assert.match(joined, /not yet reported by worker/);
});

test("provenance tab: empty permissionFires renders '(no rules fired)'", () => {
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    provenance: buildProvenance({ permissionFires: [] }),
    approvals: [],
  });
  const joined = lines.join("\n");
  assert.match(joined, /no rules fired/);
});

test("provenance tab: autopilot profile renders [autopilot] marker", () => {
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    provenance: buildProvenance({
      agentProfile: { name: "autopilot", autopilot: true },
      composerMode: "autopilot",
    }),
    approvals: [],
  });
  const joined = lines.join("\n");
  assert.match(joined, /autopilot \[autopilot\]/);
});

test("provenance tab: approval timeline sorts by requestedAt ascending", () => {
  const early = buildApproval({
    approvalId: "approval-early",
    requestedAt: "2026-04-14T12:00:00.000Z",
    decidedAt: "2026-04-14T12:00:10.000Z",
    request: {
      tool: "shell",
      argument: "ls",
      displayCommand: "shell(ls)",
    },
  });
  const late = buildApproval({
    approvalId: "approval-late",
    requestedAt: "2026-04-14T12:10:00.000Z",
    decidedAt: "2026-04-14T12:10:05.000Z",
    request: {
      tool: "shell",
      argument: "git push",
      displayCommand: "shell(git push)",
    },
  });
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    provenance: buildProvenance(),
    approvals: [late, early],
  });
  const idxEarly = indexOf(lines, "shell(ls)");
  const idxLate = indexOf(lines, "shell(git push)");
  assert.ok(idxEarly > 0);
  assert.ok(idxLate > 0);
  assert.ok(idxEarly < idxLate, "early approval should render before later one");
});

test("provenance tab: exit details surface exitCode/signal/timedOut/elapsedMs", () => {
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    provenance: buildProvenance({
      exit: { exitCode: 137, exitSignal: "SIGKILL", timedOut: true, elapsedMs: 30000 },
    }),
    approvals: [],
  });
  const joined = lines.join("\n");
  assert.match(joined, /Code.*137/);
  assert.match(joined, /Signal.*SIGKILL/);
  assert.match(joined, /TimedOut.*true/);
  assert.match(joined, /Elapsed.*30000 ms/);
});

test("provenance tab: missing AttemptSpec on attempt surfaces legacy placeholder", () => {
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt({ attemptSpec: undefined as unknown as AttemptSpec }),
    provenance: buildProvenance(),
    approvals: [],
  });
  const joined = lines.join("\n");
  assert.match(joined, /Compiled AttemptSpec/);
  assert.match(joined, /legacy attempt/);
});

test("provenance tab: missing provenance record still surfaces heading + placeholders", () => {
  const lines = formatInspectProvenance({
    session: buildSession(),
    attempt: buildAttempt(),
    approvals: [],
  });
  assert.equal(lines[0], "Provenance");
  const joined = lines.join("\n");
  assert.match(joined, /no provenance record/);
  assert.match(joined, /attempt not finalized/);
});
