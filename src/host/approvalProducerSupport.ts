import {
  hydratePermissionRule,
  synthesizePermissionRuleId,
  type PermissionRule,
  type PermissionSource,
  type PermissionTool,
} from "../attemptProtocol.js";
import { createSessionEvent, type SessionEventEnvelope } from "../protocol.js";
import type { ComposerMode } from "./appState.js";
import {
  appendApprovalRecord,
  createApprovalRecord,
  type ApprovalDecidedBy,
  type ApprovalDecision,
} from "./approvalStore.js";
import { renderPermissionDisplayCommand } from "./approvalPolicy.js";
import type { EventLogWriter } from "./eventLogWriter.js";
import { dispatchHook, type HookRegistry, type HookResult } from "./hooks.js";

/**
 * Support helpers for {@link resolveApprovalBeforeDispatch}. Extracted to
 * keep the main producer module below the 400-line ceiling.
 *
 * Surfaces exported here:
 *
 * - Envelope builders for `host.approval_requested` / `host.approval_resolved`.
 * - `PermissionRule` synthesis helpers (synthetic ask, allow-always).
 * - `findMatchingRule`: picks the rule that fired for audit log fidelity.
 * - `runPermissionRequestHooks`: thin wrapper over `dispatchHook`.
 * - `recordOutcome`: writes the `ApprovalRecord` + resolved envelope pair.
 */

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

export type ApprovalRequestPayload = {
  tool: string;
  argument: string;
  displayCommand: string;
};

export type ApprovalPolicySnapshotPayload = {
  agent: string;
  composerMode: ComposerMode;
  autopilot: boolean;
};

export const buildApprovalRequestedEnvelope = (args: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  approvalId: string;
  request: ApprovalRequestPayload;
  policySnapshot: ApprovalPolicySnapshotPayload;
  requestedAt: string;
}): SessionEventEnvelope =>
  createSessionEvent({
    kind: "host.approval_requested",
    sessionId: args.sessionId,
    turnId: args.turnId,
    attemptId: args.attemptId,
    actor: "host",
    payload: {
      approvalId: args.approvalId,
      request: args.request,
      policySnapshot: args.policySnapshot,
      requestedAt: args.requestedAt,
    },
  });

export const buildApprovalResolvedEnvelope = (args: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  approvalId: string;
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  matchedRule: PermissionRule;
  persistedRule?: PermissionRule;
  rationale: string;
  decidedAt: string;
}): SessionEventEnvelope =>
  createSessionEvent({
    kind: "host.approval_resolved",
    sessionId: args.sessionId,
    turnId: args.turnId,
    attemptId: args.attemptId,
    actor: "host",
    payload: {
      approvalId: args.approvalId,
      decision: args.decision,
      decidedBy: args.decidedBy,
      matchedRule: args.matchedRule,
      ...(args.persistedRule !== undefined ? { persistedRule: args.persistedRule } : {}),
      rationale: args.rationale,
      decidedAt: args.decidedAt,
    },
  });

// ---------------------------------------------------------------------------
// Rule synthesis helpers
// ---------------------------------------------------------------------------

export const synthAskRule = (tool: PermissionTool, argument: string): PermissionRule => {
  const effect = "ask" as const;
  const pattern = argument;
  const source: PermissionSource = "agent_profile";
  return {
    ruleId: synthesizePermissionRuleId({ effect, tool, pattern, source }),
    effect,
    tool,
    pattern,
    scope: "session",
    source,
  };
};

export const buildAllowAlwaysRule = (tool: PermissionTool, pattern: string): PermissionRule => ({
  ruleId: synthesizePermissionRuleId({
    effect: "allow",
    tool,
    pattern,
    source: "user_interactive",
  }),
  effect: "allow",
  tool,
  pattern,
  scope: "always",
  source: "user_interactive",
});

/**
 * Determine which rule actually matched for the (tool, argument) pair. Used
 * to fill `ApprovalRecord.matchedRule` with the real rule the evaluator
 * fired on, so audit logs show the exact source of the decision.
 *
 * First deny match wins (deny-precedence); otherwise first allow; otherwise
 * first ask. Returns the synthetic ask rule when nothing matches.
 */
export const findMatchingRule = (
  rules: ReadonlyArray<PermissionRule>,
  tool: PermissionTool,
  argument: string,
): PermissionRule => {
  const toolMatches = rules.filter((r) => r.tool === tool || r.tool === "*");
  const deny = toolMatches.find((r) => r.effect === "deny");
  if (deny !== undefined) {
    return deny;
  }
  const allow = toolMatches.find((r) => r.effect === "allow");
  if (allow !== undefined) {
    return allow;
  }
  const ask = toolMatches.find((r) => r.effect === "ask");
  if (ask !== undefined) {
    return ask;
  }
  return synthAskRule(tool, argument);
};

// ---------------------------------------------------------------------------
// Hook dispatch
// ---------------------------------------------------------------------------

/**
 * Run `permissionRequest` sync hooks. The first `allow` or `deny` wins;
 * `skip`/`replace` are collapsed to no-opinion. Returns `undefined` when no
 * hook expressed an allow/deny opinion.
 */
export const runPermissionRequestHooks = async (
  registry: HookRegistry | undefined,
  envelope: SessionEventEnvelope,
): Promise<HookResult | undefined> => {
  if (registry === undefined) {
    return undefined;
  }
  const results = await dispatchHook(registry, "permissionRequest", envelope);
  for (const result of results) {
    if (result.decision === "allow" || result.decision === "deny") {
      return result;
    }
  }
  return undefined;
};

/**
 * Build the matched rule for a hook-sourced approval. Mirrors the convention
 * in phase-4-record-design.md §3.5 — the synthesized rule carries
 * `source: "user_config"` so the audit trail reflects hook origin.
 */
export const buildHookMatchedRule = (
  tool: PermissionTool,
  argument: string,
  allow: boolean,
): PermissionRule =>
  hydratePermissionRule({
    effect: allow ? "allow" : "deny",
    tool,
    pattern: argument,
    source: "user_config",
  });

// ---------------------------------------------------------------------------
// Record persistence
// ---------------------------------------------------------------------------

export type RecordOutcomeArgs = {
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  writer: EventLogWriter;
  request: ApprovalRequestPayload;
  policySnapshot: ApprovalPolicySnapshotPayload;
  approvalId: string;
  requestedAt: string;
  matchedRule: PermissionRule;
  persistedRule?: PermissionRule;
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  rationale: string;
  decidedAt: string;
};

/**
 * Write a single `ApprovalRecord` to the per-session log AND emit the
 * `host.approval_resolved` envelope. The envelope carries the same decision
 * surface — the two writes stay in sync by construction.
 */
export const recordApprovalOutcome = async (args: RecordOutcomeArgs): Promise<void> => {
  const record = createApprovalRecord({
    sessionId: args.sessionId,
    turnId: args.turnId,
    attemptId: args.attemptId,
    request: args.request,
    matchedRule: args.matchedRule,
    ...(args.persistedRule !== undefined ? { persistedRule: args.persistedRule } : {}),
    decision: args.decision,
    decidedBy: args.decidedBy,
    rationale: args.rationale,
    policySnapshot: args.policySnapshot,
    approvalId: args.approvalId,
    requestedAt: args.requestedAt,
    decidedAt: args.decidedAt,
  });

  await appendApprovalRecord(args.storageRoot, record);

  await args.writer.append(
    buildApprovalResolvedEnvelope({
      sessionId: args.sessionId,
      turnId: args.turnId,
      attemptId: args.attemptId,
      approvalId: args.approvalId,
      decision: args.decision,
      decidedBy: args.decidedBy,
      matchedRule: args.matchedRule,
      ...(args.persistedRule !== undefined ? { persistedRule: args.persistedRule } : {}),
      rationale: args.rationale,
      decidedAt: args.decidedAt,
    }),
  );
};

// Convenience helper used by a couple of display paths.
export const buildApprovalRequestPayload = (
  tool: PermissionTool,
  argument: string,
): ApprovalRequestPayload => ({
  tool: String(tool),
  argument,
  displayCommand: renderPermissionDisplayCommand(tool, argument),
});
