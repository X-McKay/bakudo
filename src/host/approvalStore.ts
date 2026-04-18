import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  hydratePermissionRule,
  PermissionRuleSchema,
  type PermissionRule,
} from "../attemptProtocol.js";
import type { ComposerMode } from "./appState.js";
import { appendNdjsonLine, readNdjsonFile } from "./ndjsonAppendLog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const APPROVAL_RECORD_SCHEMA_VERSION = 1 as const;

export type ApprovalDecision = "approved" | "denied" | "auto_approved" | "auto_denied";

export type ApprovalDecidedBy = "user_prompt" | "hook_sync" | "autopilot" | "recorded_rule";

export type ApprovalRequest = {
  tool: string;
  argument: string;
  /** Pre-rendered display form (e.g. `"shell(git push origin main)"`). */
  displayCommand: string;
};

export type ApprovalPolicySnapshot = {
  agent: string;
  composerMode: ComposerMode;
  autopilot: boolean;
};

export type ApprovalRecord = {
  schemaVersion: typeof APPROVAL_RECORD_SCHEMA_VERSION;
  approvalId: string;
  sessionId: string;
  turnId: string;
  /** Absent for pre-dispatch approvals (the attempt does not exist yet). */
  attemptId?: string;
  request: ApprovalRequest;
  matchedRule: PermissionRule;
  /** Present when the user picked "allow always" — persisted into the
   *  workspace-level allowlist. */
  persistedRule?: PermissionRule;
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  decidedAt: string;
  requestedAt: string;
  rationale: string;
  policySnapshot: ApprovalPolicySnapshot;
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ApprovalDecisionSchema = z.enum(["approved", "denied", "auto_approved", "auto_denied"]);

const ApprovalDecidedBySchema = z.enum(["user_prompt", "hook_sync", "autopilot", "recorded_rule"]);

const ComposerModeSchema = z.enum(["standard", "plan", "autopilot"]);

const ApprovalRequestSchema = z
  .object({
    tool: z.string(),
    argument: z.string(),
    displayCommand: z.string(),
  })
  .strip();

const ApprovalPolicySnapshotSchema = z
  .object({
    agent: z.string(),
    composerMode: ComposerModeSchema,
    autopilot: z.boolean(),
  })
  .strip();

/**
 * Tolerant-on-read schema for {@link ApprovalRecord}. Callers that want a
 * strict {@link PermissionRule} shape on `matchedRule`/`persistedRule`
 * should run the output through {@link hydrateApprovalRecord}.
 */
export const ApprovalRecordSchema = z
  .object({
    schemaVersion: z.literal(APPROVAL_RECORD_SCHEMA_VERSION),
    approvalId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    attemptId: z.string().optional(),
    request: ApprovalRequestSchema,
    matchedRule: PermissionRuleSchema,
    persistedRule: PermissionRuleSchema.optional(),
    decision: ApprovalDecisionSchema,
    decidedBy: ApprovalDecidedBySchema,
    decidedAt: z.string(),
    requestedAt: z.string(),
    rationale: z.string(),
    policySnapshot: ApprovalPolicySnapshotSchema,
  })
  .strip();

export type RawApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const hydrateApprovalRecord = (raw: RawApprovalRecord): ApprovalRecord => ({
  schemaVersion: raw.schemaVersion,
  approvalId: raw.approvalId,
  sessionId: raw.sessionId,
  turnId: raw.turnId,
  ...(raw.attemptId !== undefined ? { attemptId: raw.attemptId } : {}),
  request: raw.request,
  matchedRule: hydratePermissionRule(raw.matchedRule),
  ...(raw.persistedRule !== undefined
    ? { persistedRule: hydratePermissionRule(raw.persistedRule) }
    : {}),
  decision: raw.decision,
  decidedBy: raw.decidedBy,
  decidedAt: raw.decidedAt,
  requestedAt: raw.requestedAt,
  rationale: raw.rationale,
  policySnapshot: raw.policySnapshot,
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const APPROVALS_FILE_NAME = "approvals.ndjson";
const DURABLE_ALLOWLIST_DIR = ".bakudo";
const DURABLE_ALLOWLIST_FILE = "approvals.jsonl";

/**
 * Location of the per-session approval log. `storageRoot` is the sessions
 * root (e.g. `<repo>/.bakudo/sessions`) and mirrors `transitionStore.ts`.
 */
export const approvalsFilePath = (storageRoot: string, sessionId: string): string =>
  join(storageRoot, sessionId, APPROVALS_FILE_NAME);

/**
 * Location of the workspace-level durable allowlist — `PermissionRule`
 * entries whose `scope: "always"` survive across sessions. Lives at
 * `<repoRoot>/.bakudo/approvals.jsonl`. NOT to be confused with the
 * per-session approvals file above.
 */
export const durableAllowlistPath = (repoRoot: string): string =>
  join(repoRoot, DURABLE_ALLOWLIST_DIR, DURABLE_ALLOWLIST_FILE);

// ---------------------------------------------------------------------------
// IDs and factory
// ---------------------------------------------------------------------------

export const createApprovalId = (): string => `approval-${Date.now()}-${randomUUID().slice(0, 8)}`;

export type CreateApprovalRecordInput = {
  sessionId: string;
  turnId: string;
  attemptId?: string;
  request: ApprovalRequest;
  matchedRule: PermissionRule;
  persistedRule?: PermissionRule;
  decision: ApprovalDecision;
  decidedBy: ApprovalDecidedBy;
  rationale: string;
  policySnapshot: ApprovalPolicySnapshot;
  requestedAt?: string;
  decidedAt?: string;
  approvalId?: string;
};

/**
 * Build an {@link ApprovalRecord} with sane defaults for `approvalId`,
 * `requestedAt`, `decidedAt`, and the v1 `schemaVersion`. Callers may
 * override any of them for determinism in tests.
 */
export const createApprovalRecord = (input: CreateApprovalRecordInput): ApprovalRecord => {
  const now = new Date().toISOString();
  return {
    schemaVersion: APPROVAL_RECORD_SCHEMA_VERSION,
    approvalId: input.approvalId ?? createApprovalId(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    request: input.request,
    matchedRule: input.matchedRule,
    ...(input.persistedRule !== undefined ? { persistedRule: input.persistedRule } : {}),
    decision: input.decision,
    decidedBy: input.decidedBy,
    decidedAt: input.decidedAt ?? now,
    requestedAt: input.requestedAt ?? now,
    rationale: input.rationale,
    policySnapshot: input.policySnapshot,
  };
};

// ---------------------------------------------------------------------------
// Per-session approval log
// ---------------------------------------------------------------------------

export const appendApprovalRecord = async (
  storageRoot: string,
  record: ApprovalRecord,
): Promise<void> => {
  const filePath = approvalsFilePath(storageRoot, record.sessionId);
  await appendNdjsonLine(filePath, record);
};

export const listSessionApprovals = async (
  storageRoot: string,
  sessionId: string,
): Promise<ApprovalRecord[]> => {
  const raws = await readNdjsonFile(
    approvalsFilePath(storageRoot, sessionId),
    ApprovalRecordSchema,
  );
  return raws.map(hydrateApprovalRecord);
};

export const listTurnApprovals = async (
  storageRoot: string,
  sessionId: string,
  turnId: string,
): Promise<ApprovalRecord[]> => {
  const all = await listSessionApprovals(storageRoot, sessionId);
  return all.filter((record) => record.turnId === turnId);
};

export const loadApproval = async (
  storageRoot: string,
  sessionId: string,
  approvalId: string,
): Promise<ApprovalRecord | null> => {
  const all = await listSessionApprovals(storageRoot, sessionId);
  return all.find((record) => record.approvalId === approvalId) ?? null;
};

// ---------------------------------------------------------------------------
// Durable workspace-level allowlist
// ---------------------------------------------------------------------------

/**
 * Load the durable allowlist — `PermissionRule` entries the user has
 * persisted via `allow always`. Entries get the hydrator treatment so any
 * missing `ruleId`/`scope` on older data gets filled in.
 */
export const loadDurableAllowlist = async (repoRoot: string): Promise<PermissionRule[]> => {
  const raws = await readNdjsonFile(durableAllowlistPath(repoRoot), PermissionRuleSchema);
  return raws.map(hydratePermissionRule);
};

/**
 * Append a single rule to the durable allowlist. No dedup — callers that
 * care (`/allow-all show`, interactive merge) dedup via `ruleId` before
 * presentation. The underlying append is one-line-per-write.
 */
export const persistDurableRule = async (repoRoot: string, rule: PermissionRule): Promise<void> => {
  await appendNdjsonLine(durableAllowlistPath(repoRoot), rule);
};

/**
 * Rewrite the durable allowlist file with the supplied rules, replacing any
 * prior contents. Used by `/allow-all off` to remove specific rules while
 * preserving the rest. No dedup — callers filter before calling.
 */
export const writeDurableAllowlist = async (
  repoRoot: string,
  rules: ReadonlyArray<PermissionRule>,
): Promise<void> => {
  const filePath = durableAllowlistPath(repoRoot);
  await mkdir(dirname(filePath), { recursive: true });
  const body = rules.map((rule) => JSON.stringify(rule)).join("\n");
  const payload = rules.length === 0 ? "" : `${body}\n`;
  await writeFile(filePath, payload, { encoding: "utf8" });
};
