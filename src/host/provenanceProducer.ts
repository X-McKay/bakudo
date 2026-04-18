import { createSessionEvent, type SessionEventEnvelope } from "../protocol.js";
import {
  appendProvenanceRecord,
  createProvenanceRecord,
  finalizeProvenanceRecord,
  type CreateProvenanceRecordInput,
  type FinalizeProvenanceInput,
  type ProvenanceRecord,
} from "./provenance.js";

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

export const buildProvenanceStartedEnvelope = (input: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  provenanceId: string;
  sandboxTaskId?: string;
  dispatchCommand: string[];
}): SessionEventEnvelope =>
  createSessionEvent({
    kind: "host.provenance_started",
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    actor: "host",
    payload: {
      provenanceId: input.provenanceId,
      attemptId: input.attemptId,
      ...(input.sandboxTaskId !== undefined ? { sandboxTaskId: input.sandboxTaskId } : {}),
      dispatchCommand: input.dispatchCommand,
    },
  });

export const buildProvenanceFinalizedEnvelope = (input: {
  sessionId: string;
  turnId: string;
  attemptId: string;
  provenanceId: string;
  exitCode: number | null;
  timedOut: boolean;
  elapsedMs: number;
}): SessionEventEnvelope =>
  createSessionEvent({
    kind: "host.provenance_finalized",
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    actor: "host",
    payload: {
      provenanceId: input.provenanceId,
      attemptId: input.attemptId,
      exitCode: input.exitCode,
      timedOut: input.timedOut,
      elapsedMs: input.elapsedMs,
    },
  });

// ---------------------------------------------------------------------------
// Producer helpers — mount on the dispatch path
// ---------------------------------------------------------------------------

export type RecordProvenanceStartInput = CreateProvenanceRecordInput & {
  storageRoot: string;
};

/**
 * Create a fresh {@link ProvenanceRecord}, persist it to the per-session
 * NDJSON log, and return the record alongside the matching
 * `host.provenance_started` envelope. Callers emit the envelope to their
 * own event-log writer.
 */
export const recordProvenanceStart = async (
  input: RecordProvenanceStartInput,
): Promise<{ record: ProvenanceRecord; envelope: SessionEventEnvelope }> => {
  const { storageRoot, ...factoryInput } = input;
  const record = createProvenanceRecord(factoryInput);
  await appendProvenanceRecord(storageRoot, record);
  const envelope = buildProvenanceStartedEnvelope({
    sessionId: record.sessionId,
    turnId: record.turnId,
    attemptId: record.attemptId,
    provenanceId: record.provenanceId,
    ...(record.sandboxTaskId !== undefined ? { sandboxTaskId: record.sandboxTaskId } : {}),
    dispatchCommand: record.dispatchCommand,
  });
  return { record, envelope };
};

export type RecordProvenanceFinalizeInput = FinalizeProvenanceInput & {
  storageRoot: string;
  prior: ProvenanceRecord;
};

/**
 * Merge terminal data into a prior {@link ProvenanceRecord} and append the
 * result to the log (last-write-wins on `provenanceId`). Returns the
 * finalized record and its `host.provenance_finalized` envelope.
 */
export const recordProvenanceFinalize = async (
  input: RecordProvenanceFinalizeInput,
): Promise<{ record: ProvenanceRecord; envelope: SessionEventEnvelope }> => {
  const { storageRoot, prior, ...finalize } = input;
  const record = finalizeProvenanceRecord(prior, finalize);
  await appendProvenanceRecord(storageRoot, record);
  const envelope = buildProvenanceFinalizedEnvelope({
    sessionId: record.sessionId,
    turnId: record.turnId,
    attemptId: record.attemptId,
    provenanceId: record.provenanceId,
    exitCode: record.exit?.exitCode ?? null,
    timedOut: record.exit?.timedOut ?? false,
    elapsedMs: record.exit?.elapsedMs ?? 0,
  });
  return { record, envelope };
};
