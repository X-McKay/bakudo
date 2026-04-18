/**
 * Phase 6 Workstream 4 — Artifact Retention Policy.
 *
 * Declarative policy that decides which on-disk artifact files are eligible
 * for cleanup, given a session's records (status, latest turn/attempt) and a
 * caller-supplied "older-than" threshold. The policy itself is data —
 * {@link RetentionPolicy} — so callers can override defaults per invocation
 * without forking the engine.
 *
 * Design constraints (plan 06 lines 303-322):
 *
 *   Keep by default:
 *     1. session summaries indefinitely
 *     2. latest attempt artifacts for active or awaiting-user sessions
 *     3. latest successful attempt artifacts for completed sessions
 *
 *   Eligible for cleanup:
 *     1. stale raw logs for superseded retries
 *     2. intermediate artifacts from failed attempts older than threshold
 *     3. orphaned temp files (not tracked in any artifact record)
 *
 *   Hard rules:
 *     1. NEVER delete the only persisted review record for a turn
 *     2. NEVER delete provenance or approval records by default
 *     3. Mark missing optional artifacts explicitly when deleted under policy
 *
 * The policy never deletes — it only classifies. Cleanup of files / artifact
 * records is the job of `cleanup.ts`, which consumes a {@link RetentionPlan}
 * built here. This separation keeps decision logic pure (testable without
 * touching the filesystem) and lets the dry-run path share one engine with
 * the delete path.
 *
 * Migration note (plan 06 lines 811-819 — A6 `.bakudo/` → XDG): the policy is
 * keyed by `(sessionRecord, artifactRecords[])` rather than by absolute
 * filesystem paths. When Wave 6e relocates session storage to XDG, this
 * module needs no changes — only the cleanup driver's path resolution does.
 */

import type { ArtifactKind, ArtifactRecord } from "./artifactStore.js";
import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionStatus,
  SessionTurnRecord,
} from "../sessionTypes.js";

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

/**
 * Parse a human duration like `30d`, `7d`, `6h`, `45m`, `30s` into milliseconds.
 * Returns `null` on malformed input. Accepts a single positive integer
 * followed by exactly one unit suffix (`s`, `m`, `h`, `d`). Whitespace is
 * trimmed; leading `+` is accepted; case-insensitive.
 *
 * The output is `number` rather than `bigint` so callers can subtract from
 * `Date.now()` directly. JS's safe-integer ceiling (~285k years in ms) is
 * far above any reasonable retention horizon, so the precision is fine.
 */
export const parseDurationMs = (input: string): number | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const match = /^\+?(\d+)\s*([smhdSMHD])$/u.exec(trimmed);
  if (match === null) return null;
  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 0;
  if (multiplier === 0) return null;
  return value * multiplier;
};

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

/**
 * Tunable knobs for the retention engine. Defaults map to the plan's
 * recommendations; callers (`bakudo cleanup --older-than ...`) override a
 * subset. The shape is exhaustive on purpose — every field a future
 * `bakudo.config.toml` `[retention]` block would set is named here, so the
 * config layer can serialize 1:1.
 */
export type RetentionPolicy = {
  /**
   * Files older than this (in ms, relative to "now") become eligible for
   * cleanup. Applied to (a) intermediate artifacts of failed attempts and
   * (b) stale raw logs for superseded retries. Session summaries and the
   * latest-success artifacts are never touched regardless of this value.
   */
  intermediateMaxAgeMs: number;
  /**
   * Kinds the engine treats as "intermediate" — eligible for cleanup once
   * the attempt is superseded or has failed and aged past
   * {@link intermediateMaxAgeMs}. The default omits `result` and `summary`
   * so we always retain the canonical per-attempt outcome.
   */
  intermediateKinds: ReadonlyArray<ArtifactKind>;
  /**
   * Kinds the engine NEVER deletes by default. The cleanup driver enforces
   * the "review/provenance/approval" hard rule by checking these against
   * the on-disk file basename map; this list is for artifact-record kinds
   * the policy itself recognises.
   */
  protectedKinds: ReadonlyArray<ArtifactKind>;
};

/**
 * Plan defaults (lines 303-316). 30 days for intermediate-artifact cleanup
 * matches the explicit example in the plan command (`bakudo cleanup
 * --older-than 30d`). `result` and `summary` are kept indefinitely; `report`
 * is also retained because reports are user-visible verdicts.
 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  intermediateMaxAgeMs: 30 * 86_400_000, // 30 days
  intermediateKinds: ["log", "dispatch", "patch", "diff"],
  protectedKinds: ["result", "summary", "report"],
};

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------

export type RetentionDecisionReason =
  /** Session is active or awaiting user — keep latest attempt's artifacts. */
  | "session_active_keep_latest"
  /** Successful attempt for a completed session — keep indefinitely. */
  | "session_completed_keep_success"
  /** Kind protected by policy (e.g. `result`, `summary`, `report`). */
  | "protected_kind"
  /** Stale raw log for a superseded retry attempt. */
  | "superseded_retry_log"
  /** Intermediate artifact from a failed attempt older than threshold. */
  | "failed_intermediate_aged"
  /** Orphan file: present on disk but no matching artifact record exists. */
  | "orphan_temp_file";

export type RetentionDecision = {
  /** True ⇒ eligible for cleanup. */
  eligible: boolean;
  /** Free-text classification slot for diagnostics + reporting. */
  reason: RetentionDecisionReason;
};

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

const isActiveStatus = (status: SessionStatus): boolean =>
  status === "draft" ||
  status === "planned" ||
  status === "running" ||
  status === "reviewing" ||
  status === "awaiting_user";

const isCompletedStatus = (status: SessionStatus): boolean => status === "completed";

const latestTurn = (session: SessionRecord): SessionTurnRecord | undefined => session.turns.at(-1);

const latestAttempt = (turn: SessionTurnRecord | undefined): SessionAttemptRecord | undefined =>
  turn?.attempts.at(-1);

const latestSuccessfulAttempt = (
  turn: SessionTurnRecord | undefined,
): SessionAttemptRecord | undefined => {
  if (turn === undefined) return undefined;
  for (let i = turn.attempts.length - 1; i >= 0; i -= 1) {
    const attempt = turn.attempts[i];
    if (attempt !== undefined && attempt.status === "succeeded") return attempt;
  }
  return undefined;
};

/** Set of attempt IDs whose artifacts must be preserved per the keep rules. */
const buildKeepAttemptIdSet = (session: SessionRecord): ReadonlySet<string> => {
  const keep = new Set<string>();
  if (isActiveStatus(session.status)) {
    // Plan 308 — keep latest attempt artifacts for active/awaiting sessions.
    const tip = latestAttempt(latestTurn(session));
    if (tip !== undefined) keep.add(tip.attemptId);
  } else if (isCompletedStatus(session.status)) {
    // Plan 309 — keep latest *successful* attempt artifacts for completed.
    const win = latestSuccessfulAttempt(latestTurn(session));
    if (win !== undefined) keep.add(win.attemptId);
  }
  return keep;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type RetentionPlanInput = {
  session: SessionRecord;
  /** v2 artifact records (NDJSON log) for the session. */
  records: ReadonlyArray<ArtifactRecord>;
  /** Override of {@link DEFAULT_RETENTION_POLICY}. Missing fields fall back to defaults. */
  policy?: Partial<RetentionPolicy>;
  /** Epoch-ms timestamp the engine treats as "now". Defaults to `Date.now()`. */
  now?: number;
};

export type RetentionPlanItem = {
  record: ArtifactRecord;
  decision: RetentionDecision;
};

export type RetentionPlan = {
  policy: RetentionPolicy;
  items: RetentionPlanItem[];
};

/**
 * Merge a partial override onto the defaults. Kept inline (not Object.assign)
 * so missing properties stay `undefined`-safe under `exactOptionalPropertyTypes`.
 */
const resolvePolicy = (override?: Partial<RetentionPolicy>): RetentionPolicy => ({
  intermediateMaxAgeMs:
    override?.intermediateMaxAgeMs ?? DEFAULT_RETENTION_POLICY.intermediateMaxAgeMs,
  intermediateKinds: override?.intermediateKinds ?? DEFAULT_RETENTION_POLICY.intermediateKinds,
  protectedKinds: override?.protectedKinds ?? DEFAULT_RETENTION_POLICY.protectedKinds,
});

const recordAgeMs = (record: ArtifactRecord, now: number): number => {
  const created = Date.parse(record.createdAt);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, now - created);
};

/**
 * Decide whether a single artifact record is eligible for cleanup. Pure —
 * the policy is fully determined by `(session, record, policy, now)`.
 *
 * Decision precedence (most-protective first):
 *
 *   1. session-active keep-latest
 *   2. session-completed keep-success
 *   3. protected kind
 *   4. superseded retry log (for an attempt that is not the latest of its turn)
 *   5. failed intermediate aged past threshold
 *
 * If none match, the record stays (returns `eligible: false` with the most
 * specific keep reason).
 */
export const decideForRecord = (
  session: SessionRecord,
  record: ArtifactRecord,
  policy: RetentionPolicy,
  now: number,
): RetentionDecision => {
  const keepIds = buildKeepAttemptIdSet(session);
  const attemptId = record.attemptId;
  if (attemptId !== undefined && keepIds.has(attemptId)) {
    return {
      eligible: false,
      reason: isCompletedStatus(session.status)
        ? "session_completed_keep_success"
        : "session_active_keep_latest",
    };
  }
  if (policy.protectedKinds.includes(record.kind)) {
    return { eligible: false, reason: "protected_kind" };
  }

  // Determine whether the attempt this record belongs to is "superseded" —
  // i.e. there is a later attempt in the same turn — or "failed".
  const owningTurn = session.turns.find((turn) =>
    turn.attempts.some((attempt) => attempt.attemptId === attemptId),
  );
  const owningAttempt = owningTurn?.attempts.find((attempt) => attempt.attemptId === attemptId);
  const isLatestOfTurn = owningTurn?.attempts.at(-1)?.attemptId === attemptId;
  const isFailedAttempt =
    owningAttempt !== undefined &&
    owningAttempt.status !== "succeeded" &&
    owningAttempt.status !== "queued" &&
    owningAttempt.status !== "running";

  if (!isLatestOfTurn && record.kind === "log" && policy.intermediateKinds.includes(record.kind)) {
    return { eligible: true, reason: "superseded_retry_log" };
  }

  if (
    isFailedAttempt &&
    policy.intermediateKinds.includes(record.kind) &&
    recordAgeMs(record, now) >= policy.intermediateMaxAgeMs
  ) {
    return { eligible: true, reason: "failed_intermediate_aged" };
  }

  return { eligible: false, reason: "session_active_keep_latest" };
};

/**
 * Build a {@link RetentionPlan} for a session: one decision per artifact
 * record, plus the resolved policy snapshot. Pure; no I/O.
 */
export const buildRetentionPlan = (input: RetentionPlanInput): RetentionPlan => {
  const policy = resolvePolicy(input.policy);
  const now = input.now ?? Date.now();
  const items = input.records.map<RetentionPlanItem>((record) => ({
    record,
    decision: decideForRecord(input.session, record, policy, now),
  }));
  return { policy, items };
};

/**
 * Classify a path as an "orphan" if it is on disk under a session's artifact
 * dir but not referenced by any record in the supplied list. Used by the
 * cleanup driver to round up untracked temp files.
 *
 * Comparison is by basename (the artifact-record `path` is relative to the
 * session dir, matching what the cleanup driver passes in).
 */
export const isOrphanFileBasename = (
  basename: string,
  records: ReadonlyArray<ArtifactRecord>,
): boolean => {
  for (const record of records) {
    const recBase = record.path.split(/[\\/]/u).at(-1);
    if (recBase === basename) return false;
  }
  return true;
};
