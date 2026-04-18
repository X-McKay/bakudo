import type { ArtifactStore } from "../artifactStore.js";
import type { SessionEventEnvelope } from "../protocol.js";
import type { SessionAttemptRecord, SessionRecord, SessionTurnRecord } from "../sessionTypes.js";
import type { ApprovalRecord } from "./approvalStore.js";
import {
  formatInspectArtifacts,
  formatInspectLogs,
  formatInspectReview,
  formatInspectSandbox,
  formatInspectSummary,
  type InspectReviewPayload,
} from "./inspectFormatter.js";
import { applyInspectWindow } from "./inspectScroll.js";
import type { ProvenanceRecord } from "./provenance.js";

/**
 * Phase 4 PR4 "Provenance Tab Layout": ordered renderer for the
 * `/inspect provenance` (née `sandbox`) tab. See the plan doc
 * `plans/bakudo-ux/04-provenance-first-inspection-and-approval.md`,
 * subsection "Provenance Tab Layout", and `phase-4-record-design.md` §6.2.
 *
 * Fields render in this order — tests assert the order explicitly:
 *   1. Active agent profile (name + autopilot marker)
 *   2. Compiled AttemptSpec JSON (pretty-printed)
 *   3. abox dispatch command (one element per line, `  - <arg>`)
 *   4. Sandbox task ID + worktree path
 *   5. Permission rule matches (`record.permissionFires[]`; placeholder if
 *      undefined — PR2 records land with permissionFires omitted)
 *   6. Approval timeline (chronological ApprovalRecord list for the turn)
 *   7. Env allowlist snapshot
 *   8. Exit details (code, signal, timedOut, elapsedMs)
 */

type ArtifactRow = Awaited<ReturnType<ArtifactStore["listTaskArtifacts"]>>[number];

const renderKv = (label: string, value: string): string => `${label.padEnd(10)} ${value}`;

const formatUtc = (value: string | undefined): string => {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(".000Z", "Z");
};

// ---------------------------------------------------------------------------
// Provenance tab renderer
// ---------------------------------------------------------------------------

export type InspectProvenanceInput = {
  session: SessionRecord;
  attempt: SessionAttemptRecord;
  provenance?: ProvenanceRecord;
  /**
   * All approval records for the attempt's turn (chronological or any order —
   * the tab renderer sorts by `requestedAt` ascending for display).
   */
  approvals: readonly ApprovalRecord[];
  /**
   * Optional raw v2 event envelopes for the attempt. When present, used only
   * to render the approval timeline's `host.approval_resolved` details. When
   * absent, the renderer falls back to the ApprovalRecord summary.
   */
  events?: readonly SessionEventEnvelope[];
};

const renderAgentProfile = (provenance: ProvenanceRecord | undefined): string[] => {
  const lines = ["Active agent profile:"];
  if (provenance === undefined) {
    lines.push("  (no provenance record)");
    return lines;
  }
  const marker = provenance.agentProfile.autopilot ? " [autopilot]" : "";
  lines.push(`  ${provenance.agentProfile.name}${marker}`);
  return lines;
};

const renderAttemptSpec = (attempt: SessionAttemptRecord): string[] => {
  const lines = ["Compiled AttemptSpec:"];
  if (attempt.attemptSpec === undefined) {
    lines.push("  (no compiled spec — legacy attempt)");
    return lines;
  }
  const pretty = JSON.stringify(attempt.attemptSpec, null, 2).split("\n");
  for (const row of pretty) {
    lines.push(`  ${row}`);
  }
  return lines;
};

const renderDispatchCommand = (provenance: ProvenanceRecord | undefined): string[] => {
  const lines = ["abox dispatch command:"];
  if (
    provenance === undefined ||
    provenance.dispatchCommand === undefined ||
    provenance.dispatchCommand.length === 0
  ) {
    lines.push("  (not recorded)");
    return lines;
  }
  for (const part of provenance.dispatchCommand) {
    lines.push(`  - ${part}`);
  }
  return lines;
};

const renderSandboxContext = (provenance: ProvenanceRecord | undefined): string[] => {
  if (provenance === undefined) {
    return [renderKv("Sandbox", "n/a"), renderKv("Worktree", "n/a")];
  }
  return [
    renderKv("Sandbox", provenance.sandboxTaskId ?? "n/a"),
    renderKv("Worktree", provenance.repoRoot),
  ];
};

const renderPermissionFires = (provenance: ProvenanceRecord | undefined): string[] => {
  const lines = ["Permission rule matches:"];
  if (provenance === undefined || provenance.permissionFires === undefined) {
    lines.push("  (not yet reported by worker)");
    return lines;
  }
  if (provenance.permissionFires.length === 0) {
    lines.push("  (no rules fired)");
    return lines;
  }
  for (const fire of provenance.permissionFires) {
    lines.push(
      `  - [${fire.effect}] ${fire.tool} ${fire.target} (rule ${fire.ruleId}) @ ${fire.firedAt}`,
    );
  }
  return lines;
};

const renderApprovalTimeline = (
  approvals: readonly ApprovalRecord[],
  attemptId: string,
): string[] => {
  const lines = ["Approval timeline:"];
  const scoped = approvals
    .filter((record) => record.attemptId === attemptId || record.attemptId === undefined)
    .slice()
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  if (scoped.length === 0) {
    lines.push("  (no approvals for this attempt)");
    return lines;
  }
  for (const record of scoped) {
    lines.push(
      `  - ${formatUtc(record.requestedAt)} ${record.request.displayCommand} -> ${record.decision} (by ${record.decidedBy}) @ ${formatUtc(record.decidedAt)}`,
    );
    if (record.rationale.length > 0) {
      lines.push(`      rationale: ${record.rationale}`);
    }
  }
  return lines;
};

const renderEnvAllowlist = (provenance: ProvenanceRecord | undefined): string[] => {
  const lines = ["Env allowlist snapshot:"];
  if (provenance === undefined || provenance.envAllowlist.length === 0) {
    lines.push("  (empty)");
    return lines;
  }
  for (const entry of provenance.envAllowlist) {
    lines.push(`  - ${entry}`);
  }
  return lines;
};

const renderExitDetails = (provenance: ProvenanceRecord | undefined): string[] => {
  const lines = ["Exit details:"];
  if (provenance === undefined || provenance.exit === undefined) {
    lines.push("  (attempt not finalized)");
    return lines;
  }
  const { exitCode, exitSignal, timedOut, elapsedMs } = provenance.exit;
  lines.push(renderKv("  Code", exitCode === null ? "null" : String(exitCode)));
  lines.push(renderKv("  Signal", exitSignal ?? "null"));
  lines.push(renderKv("  TimedOut", String(timedOut)));
  lines.push(renderKv("  Elapsed", `${elapsedMs} ms`));
  return lines;
};

export const formatInspectProvenance = (input: InspectProvenanceInput): string[] => {
  const { session, attempt, provenance, approvals } = input;
  const lines: string[] = [
    "Provenance",
    renderKv("Session", session.sessionId),
    renderKv("Task", attempt.attemptId),
  ];
  // 1. Active agent profile.
  lines.push(...renderAgentProfile(provenance));
  // 2. Compiled AttemptSpec.
  lines.push(...renderAttemptSpec(attempt));
  // 3. abox dispatch command (as array).
  lines.push(...renderDispatchCommand(provenance));
  // 4. Sandbox task ID + worktree.
  lines.push(...renderSandboxContext(provenance));
  // 5. Permission rule matches.
  lines.push(...renderPermissionFires(provenance));
  // 6. Approval timeline.
  lines.push(...renderApprovalTimeline(approvals, attempt.attemptId));
  // 7. Env allowlist snapshot.
  lines.push(...renderEnvAllowlist(provenance));
  // 8. Exit details.
  lines.push(...renderExitDetails(provenance));
  return lines;
};

// ---------------------------------------------------------------------------
// Approvals tab renderer
// ---------------------------------------------------------------------------

export type InspectApprovalsInput = {
  session: SessionRecord;
  turn?: SessionTurnRecord;
  approvals: readonly ApprovalRecord[];
  /**
   * Optional raw v2 event envelopes for the turn. When present, the renderer
   * surfaces the matched `host.approval_resolved` envelope's `decidedBy` /
   * rationale next to the ApprovalRecord. When absent, only the persisted
   * ApprovalRecord fields are shown.
   */
  events?: readonly SessionEventEnvelope[];
};

export const formatInspectApprovals = (input: InspectApprovalsInput): string[] => {
  const { session, turn, approvals, events } = input;
  const lines = [
    "Approvals",
    renderKv("Session", session.sessionId),
    ...(turn === undefined ? [] : [renderKv("Turn", turn.turnId)]),
    renderKv("Count", String(approvals.length)),
  ];
  if (approvals.length === 0) {
    lines.push("  (no approval records for this turn)");
    return lines;
  }
  const ordered = approvals
    .slice()
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  const resolvedByApprovalId = new Map<string, SessionEventEnvelope>();
  if (events !== undefined) {
    for (const envelope of events) {
      if (envelope.kind !== "host.approval_resolved") {
        continue;
      }
      const payload = envelope.payload as { approvalId?: unknown };
      if (typeof payload.approvalId === "string") {
        resolvedByApprovalId.set(payload.approvalId, envelope);
      }
    }
  }
  for (const record of ordered) {
    lines.push(
      `  - [${formatUtc(record.requestedAt)}] ${record.request.displayCommand} (${record.request.tool})`,
    );
    lines.push(
      `      decision ${record.decision} by ${record.decidedBy} @ ${formatUtc(record.decidedAt)}`,
    );
    if (record.rationale.length > 0) {
      lines.push(`      rationale: ${record.rationale}`);
    }
    lines.push(
      `      matched rule ${record.matchedRule.ruleId} (${record.matchedRule.effect} ${record.matchedRule.tool} ${record.matchedRule.pattern})`,
    );
    if (record.persistedRule !== undefined) {
      lines.push(`      persisted as ${record.persistedRule.ruleId}`);
    }
    const resolvedEnvelope = resolvedByApprovalId.get(record.approvalId);
    if (resolvedEnvelope !== undefined) {
      const payload = resolvedEnvelope.payload as {
        decidedBy?: string;
        rationale?: string;
      };
      if (typeof payload.rationale === "string" && payload.rationale.length > 0) {
        lines.push(`      envelope rationale: ${payload.rationale}`);
      }
      if (typeof payload.decidedBy === "string") {
        lines.push(`      envelope decidedBy: ${payload.decidedBy}`);
      }
    }
  }
  return lines;
};

// ---------------------------------------------------------------------------
// Six-tab dispatcher
// ---------------------------------------------------------------------------

export type InspectTabDispatchInput = {
  session: SessionRecord;
  turn?: SessionTurnRecord;
  attempt?: SessionAttemptRecord;
  artifacts: ArtifactRow[];
  events: Array<{
    timestamp: string;
    status: string;
    taskId: string;
    kind: string;
    message?: string;
  }>;
  reviewed?: InspectReviewPayload;
  provenance?: ProvenanceRecord;
  approvals: readonly ApprovalRecord[];
  envelopes?: readonly SessionEventEnvelope[];
};

export type InspectTabName =
  | "summary"
  | "review"
  | "provenance"
  | "artifacts"
  | "approvals"
  | "logs";

/**
 * Window-slicing options for {@link formatInspectTab}. When `window` is
 * provided, the returned lines are clipped to the viewport (see
 * `inspectScroll.ts`). Omitted → full content returned (backward-compatible).
 */
export type FormatInspectTabOptions = {
  window?: { offset: number; height: number };
};

const dispatchInspectTab = (tab: InspectTabName, input: InspectTabDispatchInput): string[] => {
  const { session, turn, attempt, artifacts, events, reviewed, provenance, approvals, envelopes } =
    input;
  switch (tab) {
    case "summary":
      return formatInspectSummary({
        session,
        ...(turn ? { turn } : {}),
        ...(attempt ? { attempt } : {}),
      });
    case "review":
      if (attempt === undefined || reviewed === undefined) {
        return ["Review", "  (no reviewed result yet)"];
      }
      return formatInspectReview({ session, attempt, reviewed, artifacts });
    case "provenance":
      if (attempt === undefined) {
        return ["Provenance", "  (no attempts yet)"];
      }
      return formatInspectProvenance({
        session,
        attempt,
        ...(provenance ? { provenance } : {}),
        approvals,
        ...(envelopes ? { events: envelopes } : {}),
      });
    case "artifacts":
      return formatInspectArtifacts({ session, ...(attempt ? { attempt } : {}), artifacts });
    case "approvals":
      return formatInspectApprovals({
        session,
        ...(turn ? { turn } : {}),
        approvals,
        ...(envelopes ? { events: envelopes } : {}),
      });
    case "logs":
      return formatInspectLogs({ session, ...(attempt ? { attempt } : {}), events });
  }
};

/**
 * Route an {@link InspectTabName} to its renderer. Phase 5 PR8 adds
 * `options.window` for viewport-sized slicing.
 */
export const formatInspectTab = (
  tab: InspectTabName,
  input: InspectTabDispatchInput,
  options?: FormatInspectTabOptions,
): string[] => {
  const lines = dispatchInspectTab(tab, input);
  if (options?.window === undefined) {
    return lines;
  }
  return applyInspectWindow({
    lines,
    offset: options.window.offset,
    height: options.window.height,
  }).lines;
};

// Legacy alias. The pre-PR4 `sandbox` tab is now a thin wrapper around the
// richer `provenance` renderer when a ProvenanceRecord is available; callers
// that only have the old arguments keep seeing the legacy formatter.
export { formatInspectSandbox };
