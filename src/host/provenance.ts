import { randomUUID } from "node:crypto";
import { join } from "node:path";

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

export const PROVENANCE_RECORD_SCHEMA_VERSION = 1 as const;

/**
 * Per-call permission-evaluator fire captured at the worker side. Optional —
 * worker-side reporting is deferred to a follow-up; records land with
 * `permissionFires` undefined until that lands.
 */
export type ProvenancePermissionFireRecord = {
  ruleId: string;
  tool: string;
  target: string;
  effect: "allow" | "deny" | "ask";
  firedAt: string;
};

export type ProvenanceAgentProfile = {
  name: string;
  autopilot: boolean;
};

export type ProvenanceExitDetails = {
  exitCode: number | null;
  exitSignal: string | null;
  timedOut: boolean;
  elapsedMs: number;
};

export type ProvenanceRecord = {
  schemaVersion: typeof PROVENANCE_RECORD_SCHEMA_VERSION;
  provenanceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  repoRoot: string;
  sandboxTaskId?: string;
  dispatchCommand: string[];
  workerEngine: "agent_cli" | "shell";
  composerMode: ComposerMode;
  taskMode: "build" | "plan";
  agentProfile: ProvenanceAgentProfile;
  permissionRulesSnapshot: PermissionRule[];
  permissionFires?: ProvenancePermissionFireRecord[];
  envAllowlist: string[];
  startedAt: string;
  finishedAt?: string;
  exit?: ProvenanceExitDetails;
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ComposerModeSchema = z.enum(["standard", "plan", "autopilot"]);

const ProvenancePermissionFireRecordSchema = z
  .object({
    ruleId: z.string(),
    tool: z.string(),
    target: z.string(),
    effect: z.enum(["allow", "deny", "ask"]),
    firedAt: z.string(),
  })
  .strip();

const ProvenanceExitSchema = z
  .object({
    exitCode: z.number().nullable(),
    exitSignal: z.string().nullable(),
    timedOut: z.boolean(),
    elapsedMs: z.number(),
  })
  .strip();

/**
 * Tolerant-on-read schema. Run output through {@link hydrateProvenanceRecord}
 * to promote nested PermissionRule shapes to the strict Phase-4 form.
 */
export const ProvenanceRecordSchema = z
  .object({
    schemaVersion: z.literal(PROVENANCE_RECORD_SCHEMA_VERSION),
    provenanceId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    attemptId: z.string(),
    repoRoot: z.string(),
    sandboxTaskId: z.string().optional(),
    dispatchCommand: z.array(z.string()),
    workerEngine: z.enum(["agent_cli", "shell"]),
    composerMode: ComposerModeSchema,
    taskMode: z.enum(["build", "plan"]),
    agentProfile: z.object({ name: z.string(), autopilot: z.boolean() }).strip(),
    permissionRulesSnapshot: z.array(PermissionRuleSchema),
    permissionFires: z.array(ProvenancePermissionFireRecordSchema).optional(),
    envAllowlist: z.array(z.string()),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    exit: ProvenanceExitSchema.optional(),
  })
  .strip();

export type RawProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

export const hydrateProvenanceRecord = (raw: RawProvenanceRecord): ProvenanceRecord => ({
  schemaVersion: raw.schemaVersion,
  provenanceId: raw.provenanceId,
  sessionId: raw.sessionId,
  turnId: raw.turnId,
  attemptId: raw.attemptId,
  repoRoot: raw.repoRoot,
  ...(raw.sandboxTaskId !== undefined ? { sandboxTaskId: raw.sandboxTaskId } : {}),
  dispatchCommand: raw.dispatchCommand,
  workerEngine: raw.workerEngine,
  composerMode: raw.composerMode,
  taskMode: raw.taskMode,
  agentProfile: raw.agentProfile,
  permissionRulesSnapshot: raw.permissionRulesSnapshot.map(hydratePermissionRule),
  ...(raw.permissionFires !== undefined ? { permissionFires: raw.permissionFires } : {}),
  envAllowlist: raw.envAllowlist,
  startedAt: raw.startedAt,
  ...(raw.finishedAt !== undefined ? { finishedAt: raw.finishedAt } : {}),
  ...(raw.exit !== undefined ? { exit: raw.exit } : {}),
});

// ---------------------------------------------------------------------------
// IDs and factory
// ---------------------------------------------------------------------------

export const createProvenanceId = (): string =>
  `provenance-${Date.now()}-${randomUUID().slice(0, 8)}`;

export type CreateProvenanceRecordInput = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  repoRoot: string;
  sandboxTaskId?: string;
  dispatchCommand?: string[];
  workerEngine: "agent_cli" | "shell";
  composerMode: ComposerMode;
  taskMode: "build" | "plan";
  agentProfile: ProvenanceAgentProfile;
  permissionRulesSnapshot: PermissionRule[];
  envAllowlist?: string[];
  startedAt?: string;
  provenanceId?: string;
};

/**
 * Build a "start" {@link ProvenanceRecord}. `finishedAt` + `exit` stay
 * undefined until {@link finalizeProvenanceRecord} merges in the terminal
 * data via an NDJSON last-write-wins append.
 */
export const createProvenanceRecord = (input: CreateProvenanceRecordInput): ProvenanceRecord => ({
  schemaVersion: PROVENANCE_RECORD_SCHEMA_VERSION,
  provenanceId: input.provenanceId ?? createProvenanceId(),
  sessionId: input.sessionId,
  turnId: input.turnId,
  attemptId: input.attemptId,
  repoRoot: input.repoRoot,
  ...(input.sandboxTaskId !== undefined ? { sandboxTaskId: input.sandboxTaskId } : {}),
  dispatchCommand: input.dispatchCommand ?? [],
  workerEngine: input.workerEngine,
  composerMode: input.composerMode,
  taskMode: input.taskMode,
  agentProfile: input.agentProfile,
  permissionRulesSnapshot: input.permissionRulesSnapshot,
  envAllowlist: input.envAllowlist ?? [],
  startedAt: input.startedAt ?? new Date().toISOString(),
});

export type FinalizeProvenanceInput = {
  finishedAt?: string;
  exit: ProvenanceExitDetails;
  sandboxTaskId?: string;
  dispatchCommand?: string[];
  permissionFires?: ProvenancePermissionFireRecord[];
};

/**
 * Produce the "finalize" record to append alongside the start line. Shares
 * the same `provenanceId`; readers fold via last-write-wins so the
 * finalize line overrides the start's `exit`, `finishedAt`, and optionally
 * `dispatchCommand` / `sandboxTaskId` / `permissionFires`.
 *
 * The dispatch command is typically only known after `runner.runAttempt`
 * returns; the start record seeds it as `[]` and this function fills the
 * observed value at finalize time.
 */
export const finalizeProvenanceRecord = (
  prior: ProvenanceRecord,
  finalize: FinalizeProvenanceInput,
): ProvenanceRecord => ({
  ...prior,
  ...(finalize.sandboxTaskId !== undefined ? { sandboxTaskId: finalize.sandboxTaskId } : {}),
  ...(finalize.dispatchCommand !== undefined ? { dispatchCommand: finalize.dispatchCommand } : {}),
  ...(finalize.permissionFires !== undefined ? { permissionFires: finalize.permissionFires } : {}),
  finishedAt: finalize.finishedAt ?? new Date().toISOString(),
  exit: finalize.exit,
});

// ---------------------------------------------------------------------------
// Path + store
// ---------------------------------------------------------------------------

const PROVENANCE_FILE_NAME = "provenance.ndjson";

export const provenanceFilePath = (storageRoot: string, sessionId: string): string =>
  join(storageRoot, sessionId, PROVENANCE_FILE_NAME);

export const appendProvenanceRecord = async (
  storageRoot: string,
  record: ProvenanceRecord,
): Promise<void> => {
  await appendNdjsonLine(provenanceFilePath(storageRoot, record.sessionId), record);
};

/**
 * Fold the NDJSON log by `provenanceId` with last-write-wins semantics —
 * start-line gets overridden by any subsequent finalize-line for the same
 * `provenanceId`. Returns records in their last-written order.
 */
const foldLastWriteWins = (raws: ProvenanceRecord[]): ProvenanceRecord[] => {
  const byId = new Map<string, ProvenanceRecord>();
  for (const rec of raws) {
    byId.set(rec.provenanceId, rec);
  }
  return Array.from(byId.values());
};

export const listSessionProvenance = async (
  storageRoot: string,
  sessionId: string,
): Promise<ProvenanceRecord[]> => {
  const raws = await readNdjsonFile(
    provenanceFilePath(storageRoot, sessionId),
    ProvenanceRecordSchema,
  );
  return foldLastWriteWins(raws.map(hydrateProvenanceRecord));
};

export const listTurnProvenance = async (
  storageRoot: string,
  sessionId: string,
  turnId: string,
): Promise<ProvenanceRecord[]> => {
  const all = await listSessionProvenance(storageRoot, sessionId);
  return all.filter((record) => record.turnId === turnId);
};

export const loadProvenance = async (
  storageRoot: string,
  sessionId: string,
  attemptId: string,
): Promise<ProvenanceRecord | null> => {
  const all = await listSessionProvenance(storageRoot, sessionId);
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const record = all[index];
    if (record?.attemptId === attemptId) {
      return record;
    }
  }
  return null;
};
