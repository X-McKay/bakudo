import type { AttemptSpec, PermissionRule, PermissionTool } from "../attemptProtocol.js";
import type { ComposerMode } from "./appState.js";
import {
  loadDurableAllowlist,
  persistDurableRule,
  type ApprovalDecidedBy,
  type ApprovalDecision,
} from "./approvalStore.js";
import { suggestAllowAlwaysPattern } from "./approvalPolicy.js";
import {
  launchApprovalDialog,
  type ApprovalDialogChoice,
  type ApprovalRequest,
  type DialogDispatcher,
} from "./dialogLauncher.js";
import type { EventLogWriter } from "./eventLogWriter.js";
import { evaluatePermission, mergePermissionRules } from "./permissionEvaluator.js";
import type { HookRegistry } from "./hooks.js";
import { stdoutWrite } from "./io.js";
import {
  buildAllowAlwaysRule,
  buildApprovalRequestedEnvelope,
  buildApprovalRequestPayload,
  buildHookMatchedRule,
  findMatchingRule,
  recordApprovalOutcome,
  runPermissionRequestHooks,
  type ApprovalPolicySnapshotPayload,
  type ApprovalRequestPayload,
} from "./approvalProducerSupport.js";

/**
 * Phase 4 PR7 — Approval producer. Wires pre-dispatch permission evaluation
 * through the `permissionRequest` sync hook pipeline and the promise-based
 * `launchApprovalDialog`. Persists every decision as an `ApprovalRecord` and
 * emits `host.approval_requested` / `host.approval_resolved` envelopes.
 *
 * Lives outside `executeAttempt.ts` so the dispatcher stays under the
 * 400-line cap. See `approvalProducerSupport.ts` for the envelope and
 * record-persistence primitives.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IntendedOperation = {
  tool: PermissionTool;
  argument: string;
};

/**
 * Result returned to `executeAttempt`:
 *
 * - `"proceed"`: dispatch continues. The operation was allowed or no rule
 *   required approval.
 * - `"blocked"`: dispatch MUST NOT call the worker. Deny-precedence fired,
 *   the user picked `[3] deny`, or a hook returned deny.
 */
export type ApprovalProducerOutcome =
  | { status: "proceed" }
  | { status: "blocked"; rationale: string };

export type ResolveApprovalInput = {
  storageRoot: string;
  repoRoot: string;
  spec: AttemptSpec;
  operation: IntendedOperation;
  composerMode: ComposerMode;
  agentProfileName: string;
  writer: EventLogWriter;
  dispatcher: DialogDispatcher;
  /** Optional sync hook registry; when omitted, no hooks run. */
  hookRegistry?: HookRegistry;
  /** Optional test override for the dialog launcher. */
  dialogLauncher?: (
    dispatcher: DialogDispatcher,
    request: ApprovalRequest,
    pattern: string,
  ) => Promise<ApprovalDialogChoice>;
  /** Override for timestamp generation; keeps test output deterministic. */
  now?: () => string;
};

// ---------------------------------------------------------------------------
// Main producer
// ---------------------------------------------------------------------------

/**
 * Pre-dispatch approval pipeline. Callers emit `host.dispatch_started`
 * AFTER this returns `"proceed"` — the spec requires approval before
 * dispatch. Return `"blocked"` means skip the worker call and transition
 * the turn to `"blocked"` state with `rationale` as the reason.
 */
export const resolveApprovalBeforeDispatch = async (
  input: ResolveApprovalInput,
): Promise<ApprovalProducerOutcome> => {
  const { spec, operation, composerMode, agentProfileName } = input;
  const nowFn = input.now ?? ((): string => new Date().toISOString());

  // Merge spec rules with the durable workspace allowlist (deny-preserving).
  const durable = await loadDurableAllowlist(input.repoRoot);
  const rules = mergePermissionRules([spec.permissions.rules, durable]);

  const effect = evaluatePermission(rules, operation.tool, operation.argument);
  const policySnapshot: ApprovalPolicySnapshotPayload = {
    agent: agentProfileName,
    composerMode,
    autopilot: composerMode === "autopilot",
  };
  const request = buildApprovalRequestPayload(operation.tool, operation.argument);

  // Deny-precedence short-circuit: deny always wins, no dialog.
  if (effect === "deny") {
    const matchedRule = findMatchingRule(rules, operation.tool, operation.argument);
    await persistResolution(input, {
      matchedRule,
      decision: "auto_denied",
      decidedBy: "recorded_rule",
      rationale: `deny rule matched (${matchedRule.ruleId})`,
      decidedAt: nowFn(),
      requestedAt: nowFn(),
      request,
      policySnapshot,
    });
    return {
      status: "blocked",
      rationale: `blocked by deny rule ${matchedRule.ruleId}`,
    };
  }

  // Allow (including autopilot's allow-all path): nothing to prompt.
  if (effect === "allow") {
    return { status: "proceed" };
  }

  // effect === "ask" — emit the requested envelope, run hooks, fall through
  // to the interactive dialog.
  return askPath({ input, rules, request, policySnapshot, nowFn });
};

// ---------------------------------------------------------------------------
// Ask-path: hook dispatch + dialog loop
// ---------------------------------------------------------------------------

type AskPathArgs = {
  input: ResolveApprovalInput;
  rules: PermissionRule[];
  request: ApprovalRequestPayload;
  policySnapshot: ApprovalPolicySnapshotPayload;
  nowFn: () => string;
};

const askPath = async (args: AskPathArgs): Promise<ApprovalProducerOutcome> => {
  // `rules` rides along inside `args` so it reaches `dialogLoop` without
  // being re-derived. askPath itself does not consult it.
  const { input, request, policySnapshot, nowFn } = args;
  const { spec, operation } = input;
  const approvalId = `approval-${Date.now()}`;
  const requestedAt = nowFn();

  const requestedEnvelope = buildApprovalRequestedEnvelope({
    sessionId: spec.sessionId,
    turnId: spec.turnId,
    attemptId: spec.attemptId,
    approvalId,
    request,
    policySnapshot,
    requestedAt,
  });
  await input.writer.append(requestedEnvelope);

  const hookOutcome = await runPermissionRequestHooks(input.hookRegistry, requestedEnvelope);
  if (hookOutcome !== undefined) {
    const decision: ApprovalDecision =
      hookOutcome.decision === "allow" ? "auto_approved" : "auto_denied";
    const decidedBy: ApprovalDecidedBy = "hook_sync";
    const rationale = hookOutcome.reason ?? `Decided by user_config hook (${hookOutcome.decision})`;
    const matchedRule = buildHookMatchedRule(
      operation.tool,
      operation.argument,
      hookOutcome.decision === "allow",
    );
    await persistResolution(input, {
      matchedRule,
      decision,
      decidedBy,
      rationale,
      decidedAt: nowFn(),
      approvalId,
      requestedAt,
      request,
      policySnapshot,
    });
    if (decision === "auto_denied") {
      return { status: "blocked", rationale };
    }
    return { status: "proceed" };
  }

  return dialogLoop({ ...args, approvalId, requestedAt });
};

// ---------------------------------------------------------------------------
// Interactive dialog loop — supports show_context re-prompting
// ---------------------------------------------------------------------------

type DialogLoopArgs = AskPathArgs & {
  approvalId: string;
  requestedAt: string;
};

const MAX_SHOW_CONTEXT_CYCLES = 5;

const dialogLoop = async (args: DialogLoopArgs): Promise<ApprovalProducerOutcome> => {
  const { input, rules, request, policySnapshot, nowFn, approvalId, requestedAt } = args;
  const { spec, operation } = input;

  const launcher = input.dialogLauncher ?? launchApprovalDialog;
  const suggestedPattern = suggestAllowAlwaysPattern(operation.tool, operation.argument);

  // `show_context` can re-enqueue; bound the loop so a pathological resolver
  // cannot trap us.
  for (let _i = 0; _i < MAX_SHOW_CONTEXT_CYCLES; _i += 1) {
    const choice = await launcher(
      input.dispatcher,
      {
        sessionId: spec.sessionId,
        turnId: spec.turnId,
        attemptId: spec.attemptId,
        tool: String(operation.tool),
        argument: operation.argument,
        policySnapshot,
      },
      suggestedPattern,
    );

    if (choice.kind === "show_context") {
      stdoutWrite(`${JSON.stringify(spec, null, 2)}\n`);
      continue;
    }

    const matchedRule = findMatchingRule(rules, operation.tool, operation.argument);
    const decidedAt = nowFn();
    const baseArgs = { approvalId, requestedAt, request, policySnapshot };

    if (choice.kind === "deny") {
      await persistResolution(input, {
        ...baseArgs,
        matchedRule,
        decision: "denied",
        decidedBy: "user_prompt",
        rationale: "User chose [3] deny",
        decidedAt,
      });
      return { status: "blocked", rationale: "User chose [3] deny" };
    }

    if (choice.kind === "allow_always") {
      const persistedRule = buildAllowAlwaysRule(operation.tool, choice.pattern);
      await persistDurableRule(input.repoRoot, persistedRule);
      await persistResolution(input, {
        ...baseArgs,
        matchedRule,
        persistedRule,
        decision: "approved",
        decidedBy: "user_prompt",
        rationale: `User chose [2] allow always for ${operation.tool}(${choice.pattern})`,
        decidedAt,
      });
      return { status: "proceed" };
    }

    // allow_once
    await persistResolution(input, {
      ...baseArgs,
      matchedRule,
      decision: "approved",
      decidedBy: "user_prompt",
      rationale: "User chose [1] allow once",
      decidedAt,
    });
    return { status: "proceed" };
  }

  return { status: "blocked", rationale: "Approval dialog exceeded retry budget" };
};

// ---------------------------------------------------------------------------
// Persistence wrapper — convenience over recordApprovalOutcome
// ---------------------------------------------------------------------------

type PersistArgs = {
  approvalId?: string;
  requestedAt?: string;
  request: ApprovalRequestPayload;
  policySnapshot: ApprovalPolicySnapshotPayload;
  matchedRule: PermissionRule;
  persistedRule?: PermissionRule;
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  rationale: string;
  decidedAt: string;
};

const persistResolution = async (input: ResolveApprovalInput, args: PersistArgs): Promise<void> => {
  await recordApprovalOutcome({
    storageRoot: input.storageRoot,
    sessionId: input.spec.sessionId,
    turnId: input.spec.turnId,
    attemptId: input.spec.attemptId,
    writer: input.writer,
    request: args.request,
    policySnapshot: args.policySnapshot,
    approvalId: args.approvalId ?? `approval-${Date.now()}`,
    requestedAt: args.requestedAt ?? new Date().toISOString(),
    matchedRule: args.matchedRule,
    ...(args.persistedRule !== undefined ? { persistedRule: args.persistedRule } : {}),
    decision: args.decision,
    decidedBy: args.decidedBy,
    rationale: args.rationale,
    decidedAt: args.decidedAt,
  });
};

// ---------------------------------------------------------------------------
// Intended-operation extraction
// ---------------------------------------------------------------------------

/**
 * Pick a single (tool, argument) tuple to evaluate against permission rules.
 *
 * - `explicit_command` / `verification_check`: use `execution.command` as a
 *   shell invocation. `["bash", "-lc", "foo"]` → `{tool: "shell", argument: "foo"}`.
 * - `assistant_job`: no concrete tool/argument at dispatch time — returns
 *   `null` and the caller skips host-owned approval. Worker-mediated
 *   permission requests are a Phase 6 concern.
 */
export const extractIntendedOperation = (spec: AttemptSpec): IntendedOperation | null => {
  if (spec.taskKind === "assistant_job") {
    return null;
  }
  const command = spec.execution.command;
  if (command === undefined || command.length === 0) {
    return null;
  }
  if (command[0] === "bash" && command[1] === "-lc" && typeof command[2] === "string") {
    return { tool: "shell", argument: command[2] };
  }
  return { tool: "shell", argument: command.join(" ") };
};
