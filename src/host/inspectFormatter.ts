import type { AttemptSpec } from "../attemptProtocol.js";
import type { ArtifactStore } from "../artifactStore.js";
import { persistedReviewForAttempt, type ReviewedTaskResult, reviewTaskResult } from "../reviewer.js";
import type { ReviewConfidence } from "../resultClassifier.js";
import { synthesizeLegacySpec } from "../sessionMigration.js";
import type {
  CandidateRecord,
  SessionAttemptRecord,
  SessionRecord,
  SessionReviewRecord,
  SessionTurnRecord,
} from "../sessionTypes.js";
import { DEFAULT_REDACTION_POLICY, redactText } from "./redaction.js";

/**
 * Phase 6 W5 hard rule 383 — inspect summaries must NEVER expose raw secret
 * values. Every string that originates from user input, worker output, or
 * persisted metadata passes through this helper before rendering.
 */
const safe = (value: string): string => redactText(value, DEFAULT_REDACTION_POLICY);

/**
 * Convenience: redact `undefined`-safe. Returns `undefined` unchanged so
 * callers can chain with existing optional-chaining.
 */
const safeMaybe = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : safe(value);

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

const modeOf = (attempt: SessionAttemptRecord): string =>
  attempt.request?.mode ?? (attempt.request?.assumeDangerousSkipPermissions ? "build" : "plan");

const sandboxOf = (attempt: SessionAttemptRecord): string =>
  typeof attempt.metadata?.sandboxTaskId === "string" ? attempt.metadata.sandboxTaskId : "n/a";

/**
 * Phase 6 W3 — extract the protocol-mismatch decoration left by
 * `executeAttempt.persistProtocolMismatchAttempt` when the worker capability
 * negotiation rejected dispatch. Returns a render-friendly view (or `null`
 * when the attempt failed for unrelated reasons).
 */
type ProtocolMismatchView = {
  message: string;
  recoveryHint?: string;
  details?: Record<string, unknown>;
};

const protocolMismatchOf = (
  attempt: SessionAttemptRecord | undefined,
): ProtocolMismatchView | null => {
  const raw = attempt?.metadata?.protocolMismatch;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.message !== "string") {
    return null;
  }
  const view: ProtocolMismatchView = { message: obj.message };
  if (typeof obj.recoveryHint === "string") {
    view.recoveryHint = obj.recoveryHint;
  }
  if (obj.details !== undefined && typeof obj.details === "object" && obj.details !== null) {
    view.details = obj.details as Record<string, unknown>;
  }
  return view;
};

const renderProtocolMismatchLines = (view: ProtocolMismatchView): string[] => {
  const lines: string[] = [renderKv("Mismatch", safe(view.message))];
  if (view.recoveryHint !== undefined) {
    lines.push(renderKv("Hint", safe(view.recoveryHint)));
  }
  if (view.details !== undefined) {
    const detailLine = Object.entries(view.details)
      .map(([k, v]) => `${k}=${safe(typeof v === "string" ? v : JSON.stringify(v))}`)
      .join(" ");
    if (detailLine.length > 0) {
      lines.push(renderKv("Detail", detailLine));
    }
  }
  return lines;
};

/**
 * Resolve the {@link AttemptSpec} for display. Returns the persisted spec when
 * available, or synthesizes a read-only legacy spec for v2 sessions.
 */
const resolveAttemptSpec = (
  attempt: SessionAttemptRecord | undefined,
  turn: SessionTurnRecord | undefined,
): Partial<AttemptSpec> | undefined => {
  if (attempt?.dispatchPlan?.spec !== undefined) {
    return attempt.dispatchPlan.spec;
  }
  if (attempt?.attemptSpec !== undefined) {
    return attempt.attemptSpec;
  }
  if (attempt !== undefined && turn !== undefined) {
    return synthesizeLegacySpec(attempt, turn);
  }
  return undefined;
};

const dispatchCommandOf = (attempt: SessionAttemptRecord): string[] | undefined => {
  if (Array.isArray(attempt.dispatchCommand) && attempt.dispatchCommand.length > 0) {
    return attempt.dispatchCommand;
  }
  if (Array.isArray(attempt.metadata?.aboxCommand)) {
    return (attempt.metadata.aboxCommand as unknown[]).map((entry) => String(entry));
  }
  return undefined;
};

const artifactMetadataString = (artifact: ArtifactRow, key: string): string | undefined => {
  const value = artifact.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const artifactProducerOf = (artifact: ArtifactRow): string =>
  artifact.producer ??
  artifactMetadataString(artifact, "producer") ??
  artifactMetadataString(artifact, "generatedBy") ??
  "unknown";

const artifactPhaseOf = (artifact: ArtifactRow): string =>
  artifact.phase ?? artifactMetadataString(artifact, "phase") ?? "unknown";

const artifactRoleOf = (artifact: ArtifactRow): string | undefined =>
  artifact.role ?? artifactMetadataString(artifact, "role");

const artifactSourceRelativePathOf = (artifact: ArtifactRow): string | undefined =>
  artifact.sourceRelativePath ??
  artifactMetadataString(artifact, "sourceRelativePath") ??
  artifactMetadataString(artifact, "originalPath");

const countDisplayLines = (value: string): number => value.split(/\r\n|\r|\n/u).length;

const shouldSummarizeDispatchBody = (body: string): boolean =>
  body.includes("\n") || Buffer.byteLength(body, "utf8") > 160;

const summarizeSandboxDispatchCommand = (args: {
  dispatchCommand: string[] | undefined;
  artifacts: ArtifactRow[];
}): string[] => {
  const { dispatchCommand, artifacts } = args;
  if (dispatchCommand === undefined) {
    return [renderKv("ABox", "n/a")];
  }

  const shellBodyFlagIndex = dispatchCommand.findIndex(
    (entry, index) => index < dispatchCommand.length - 1 && (entry === "-c" || entry === "-lc"),
  );
  const bodyIndex = shellBodyFlagIndex === -1 ? -1 : shellBodyFlagIndex + 1;
  if (bodyIndex === -1) {
    return [renderKv("ABox", dispatchCommand.map((arg) => safe(arg)).join(" "))];
  }

  const body = dispatchCommand[bodyIndex];
  if (body === undefined || !shouldSummarizeDispatchBody(body)) {
    return [renderKv("ABox", dispatchCommand.map((arg) => safe(arg)).join(" "))];
  }

  const dispatchArtifact = artifacts.find((artifact) => artifact.kind === "dispatch");
  const dispatchHint = dispatchArtifact === undefined ? "" : `; see ${safe(dispatchArtifact.path)}`;
  const bodySummary = `<${countDisplayLines(body)} lines, ${Buffer.byteLength(body, "utf8")} bytes${dispatchHint}>`;
  const splitIndex = dispatchCommand.indexOf("--");

  if (splitIndex !== -1 && splitIndex < bodyIndex) {
    const prefix = dispatchCommand
      .slice(0, splitIndex + 1)
      .map((arg) => safe(arg))
      .join(" ");
    const runner = dispatchCommand
      .slice(splitIndex + 1, bodyIndex)
      .map((arg) => safe(arg))
      .join(" ");
    return [renderKv("ABox", prefix), renderKv("", `${runner} ${bodySummary}`.trim())];
  }

  const prefix = dispatchCommand
    .slice(0, bodyIndex)
    .map((arg) => safe(arg))
    .join(" ");
  return [renderKv("ABox", prefix), renderKv("", bodySummary)];
};

type ReviewLike = Pick<ReviewedTaskResult, "outcome" | "action"> & { reason?: string };

const reviewFromTurn = (
  turn: SessionTurnRecord | undefined,
  attempt: SessionAttemptRecord | undefined,
): SessionReviewRecord | undefined => persistedReviewForAttempt(turn, attempt);

const selectReviewView = (
  turn: SessionTurnRecord | undefined,
  attempt: SessionAttemptRecord | undefined,
): ReviewLike | null => {
  const fromTurn = reviewFromTurn(turn, attempt);
  if (fromTurn !== undefined) {
    return {
      outcome: fromTurn.outcome,
      action: fromTurn.action,
      ...(fromTurn.reason === undefined ? {} : { reason: fromTurn.reason }),
    };
  }
  if (attempt?.result !== undefined) {
    const reviewed = reviewTaskResult(attempt.result);
    return { outcome: reviewed.outcome, action: reviewed.action, reason: reviewed.reason };
  }
  return null;
};

const formatArtifactRows = (artifacts: ArtifactRow[]): string[] => {
  const grouped = new Map<string, ArtifactRow[]>();
  for (const artifact of artifacts) {
    const key = `${artifactProducerOf(artifact)}\u0000${artifactPhaseOf(artifact)}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [artifact]);
    } else {
      existing.push(artifact);
    }
  }

  const lines: string[] = [];
  for (const [key, rows] of grouped) {
    const [producer = "unknown", phase = "unknown"] = key.split("\u0000");
    lines.push(`  ${safe(producer)} / ${safe(phase)}`);
    for (const artifact of rows) {
      const detailParts = [artifact.kind];
      const role = artifactRoleOf(artifact);
      const sourceRelativePath = artifactSourceRelativePathOf(artifact);
      if (role !== undefined && role !== artifact.kind) {
        detailParts.push(`role=${safe(role)}`);
      }
      if (sourceRelativePath !== undefined) {
        detailParts.push(`source=${safe(sourceRelativePath)}`);
      }
      lines.push(`    - ${safe(artifact.name)} (${detailParts.join(", ")}) -> ${safe(artifact.path)}`);
    }
  }
  return lines;
};

const formatCandidateDetails = (candidate: CandidateRecord | undefined): string[] => {
  if (candidate === undefined) {
    return [];
  }
  const lines: string[] = [];
  if (candidate.changeKind !== undefined) {
    lines.push(renderKv("Changes", candidate.changeKind));
  }
  if (candidate.sourceBaseline !== undefined) {
    const baseline = candidate.sourceBaseline;
    const branch = baseline.branchName === undefined ? "<detached>" : safe(baseline.branchName);
    lines.push(
      renderKv(
        "Baseline",
        `repo=${safe(baseline.repoRoot)} branch=${branch} head=${safe(baseline.headSha)} detached=${String(baseline.detachedHead)} clean=${String(baseline.clean)}`,
      ),
    );
    lines.push(renderKv("Captured", formatUtc(baseline.capturedAt)));
  }
  if (candidate.driftDecision !== undefined) {
    lines.push(renderKv("Drift", candidate.driftDecision));
  }
  if (candidate.confirmationReason !== undefined) {
    lines.push(renderKv("Confirm", safe(candidate.confirmationReason)));
  }
  if (candidate.applyError !== undefined) {
    lines.push(renderKv("ApplyErr", safe(candidate.applyError)));
  }
  if (candidate.stagedAt !== undefined) {
    lines.push(renderKv("Staged", formatUtc(candidate.stagedAt)));
  }
  if (candidate.verifiedAt !== undefined) {
    lines.push(renderKv("Verified", formatUtc(candidate.verifiedAt)));
  }
  if (candidate.writebackAt !== undefined) {
    lines.push(renderKv("Writeback", formatUtc(candidate.writebackAt)));
  }
  if (candidate.appliedAt !== undefined) {
    lines.push(renderKv("Applied", formatUtc(candidate.appliedAt)));
  }
  for (const dispatch of candidate.applyDispatches ?? []) {
    const fragments: string[] = [dispatch.kind, dispatch.status];
    if (dispatch.error !== undefined) {
      fragments.push(`error=${safe(dispatch.error)}`);
    }
    lines.push(renderKv("ApplyRun", fragments.join(" ")));
  }
  for (const resolution of candidate.resolutions ?? []) {
    lines.push(
      renderKv(
        "Resolution",
        `${safe(resolution.path)} ${resolution.status} confidence=${resolution.confidence}`,
      ),
    );
    lines.push(renderKv("", safe(resolution.rationale)));
  }
  return lines;
};

export type InspectSummaryInput = {
  session: SessionRecord;
  turn?: SessionTurnRecord;
  attempt?: SessionAttemptRecord;
};

export const formatInspectSummary = (input: InspectSummaryInput): string[] => {
  const { session, turn, attempt } = input;
  const reviewed = selectReviewView(turn, attempt);
  // Required ordering (phase doc priorities, PR3 follow-up):
  //   1. Session
  //   2. Repo
  //   3. Goal
  //   4. Outcome / Action
  //   5. Attempt / Sandbox (+ Turn)
  //   6. State / Updated / Turns
  const lines = [
    "Summary",
    renderKv("Session", session.sessionId),
    renderKv("Repo", safe(session.repoRoot)),
    renderKv("Goal", safe(session.turns[0]?.prompt ?? session.title)),
  ];
  if (reviewed) {
    lines.push(renderKv("Outcome", reviewed.outcome));
    lines.push(renderKv("Action", reviewed.action));
  }
  if (turn !== undefined) {
    lines.push(renderKv("Turn", `${turn.turnId} mode=${turn.mode} status=${turn.status}`));
  }
  if (attempt !== undefined) {
    lines.push(
      renderKv("Attempt", `${attempt.attemptId} mode=${modeOf(attempt)} status=${attempt.status}`),
    );
    lines.push(renderKv("Sandbox", sandboxOf(attempt)));
    if (attempt.candidateState !== undefined) {
      lines.push(renderKv("Candidate", attempt.candidateState));
    }
  }
  const spec = resolveAttemptSpec(attempt, turn);
  if (spec?.taskKind !== undefined) {
    lines.push(renderKv("TaskKind", spec.taskKind));
  }
  if (spec?.execution?.engine !== undefined) {
    lines.push(renderKv("Engine", spec.execution.engine));
  }
  const mismatch = protocolMismatchOf(attempt);
  if (mismatch !== null) {
    lines.push(...renderProtocolMismatchLines(mismatch));
  }
  lines.push(renderKv("State", session.status));
  lines.push(renderKv("Updated", formatUtc(session.updatedAt)));
  lines.push(renderKv("Turns", String(session.turns.length)));
  return lines;
};

/**
 * Reviewed payload accepted by {@link formatInspectReview}. The formatter
 * reads the base classification fields ({@link ReviewedTaskResult.outcome},
 * {@link ReviewedTaskResult.action}, {@link ReviewedTaskResult.reason}) and
 * surfaces the PR5 additions — `confidence`, `userExplanation`, and
 * `remediationHint` — when they are present. The PR5 fields are optional so
 * legacy callers that still hand in a {@link ReviewedTaskResult} (which gets
 * `confidence` for free via the classifier) continue to work unchanged.
 */
export type InspectReviewPayload = {
  outcome: string;
  action: string;
  reason?: string;
  confidence?: ReviewConfidence;
  userExplanation?: string;
  remediationHint?: string;
  reviewedAt?: string;
};

export type InspectReviewInput = {
  session: SessionRecord;
  attempt: SessionAttemptRecord;
  reviewed: InspectReviewPayload;
  artifacts: ArtifactRow[];
};

export const formatInspectReview = (input: InspectReviewInput): string[] => {
  const { session, attempt, reviewed, artifacts } = input;
  const dispatchArtifact = artifacts.find((artifact) => artifact.kind === "dispatch");
  const workerLog = artifacts.find((artifact) => artifact.kind === "log");
  const result = attempt.result;
  const lines = [
    "Review",
    renderKv("Session", session.sessionId),
    renderKv("Task", attempt.attemptId),
    renderKv("Status", attempt.status),
    renderKv("Outcome", reviewed.outcome),
    renderKv("Action", reviewed.action),
  ];
  if (attempt.candidateState !== undefined) {
    lines.push(renderKv("Candidate", attempt.candidateState));
  }
  if (reviewed.confidence !== undefined) {
    lines.push(renderKv("Confidence", reviewed.confidence));
  }
  if (reviewed.userExplanation !== undefined && reviewed.userExplanation.length > 0) {
    lines.push(renderKv("Explain", safe(reviewed.userExplanation)));
  }
  lines.push(renderKv("Reason", safe(reviewed.reason ?? "n/a")));
  if (reviewed.remediationHint !== undefined && reviewed.remediationHint.length > 0) {
    lines.push(renderKv("Remedy", safe(reviewed.remediationHint)));
  }
  if (reviewed.reviewedAt !== undefined) {
    lines.push(renderKv("Reviewed", formatUtc(reviewed.reviewedAt)));
  }
  lines.push(...formatCandidateDetails(attempt.candidate));
  if (result) {
    lines.push(renderKv("Summary", safe(result.summary)));
    if (result.exitCode !== undefined && result.exitCode !== null) {
      lines.push(renderKv("Exit", String(result.exitCode)));
    }
    if (result.startedAt) {
      lines.push(renderKv("Started", formatUtc(result.startedAt)));
    }
    lines.push(renderKv("Finished", formatUtc(result.finishedAt)));
  }
  if (typeof attempt.metadata?.sandboxTaskId === "string") {
    lines.push(renderKv("Sandbox", safeMaybe(attempt.metadata.sandboxTaskId) ?? ""));
  }
  if (dispatchArtifact) {
    lines.push(renderKv("Dispatch", safe(dispatchArtifact.path)));
  }
  if (workerLog) {
    lines.push(renderKv("Worker", safe(workerLog.path)));
  }
  return lines;
};

export type InspectSandboxInput = {
  session: SessionRecord;
  attempt: SessionAttemptRecord;
  artifacts: ArtifactRow[];
};

export const formatInspectSandbox = (input: InspectSandboxInput): string[] => {
  const { session, attempt, artifacts } = input;
  const lines = [
    "Sandbox",
    renderKv("Session", session.sessionId),
    renderKv("Task", attempt.attemptId),
    renderKv("Mode", modeOf(attempt)),
    renderKv("Status", attempt.status),
    ...(attempt.candidateState !== undefined
      ? [renderKv("Candidate", attempt.candidateState)]
      : []),
    renderKv("Sandbox", sandboxOf(attempt)),
    ...summarizeSandboxDispatchCommand({
      dispatchCommand: dispatchCommandOf(attempt),
      artifacts,
    }),
    renderKv(
      "Safety",
      attempt.request?.assumeDangerousSkipPermissions
        ? "dangerous-skip-permissions enabled in sandbox worker"
        : "host requested safer planning mode",
    ),
  ];
  if (typeof attempt.metadata?.worktreePath === "string") {
    lines.push(renderKv("Worktree", safe(attempt.metadata.worktreePath)));
  }
  lines.push(...formatCandidateDetails(attempt.candidate));
  if (artifacts.length > 0) {
    lines.push("Artifacts:");
    lines.push(...formatArtifactRows(artifacts));
  }
  if (attempt.result?.summary) {
    lines.push(renderKv("Summary", safe(attempt.result.summary)));
  }
  return lines;
};

export type InspectArtifactsInput = {
  session: SessionRecord;
  attempt?: SessionAttemptRecord;
  artifacts: ArtifactRow[];
};

export const formatInspectArtifacts = (input: InspectArtifactsInput): string[] => {
  const { session, attempt, artifacts } = input;
  const lines = [
    "Artifacts",
    renderKv("Session", session.sessionId),
    ...(attempt ? [renderKv("Task", attempt.attemptId)] : []),
    renderKv("Count", String(artifacts.length)),
  ];
  if (artifacts.length === 0) {
    lines.push("  (no artifacts registered)");
  } else {
    lines.push(...formatArtifactRows(artifacts));
  }
  return lines;
};

export type InspectLogsInput = {
  session: SessionRecord;
  attempt?: SessionAttemptRecord;
  events: Array<{
    timestamp: string;
    status: string;
    taskId: string;
    kind: string;
    message?: string;
  }>;
};

export const formatInspectLogs = (input: InspectLogsInput): string[] => {
  const { session, attempt, events } = input;
  const filtered =
    attempt === undefined ? events : events.filter((event) => event.taskId === attempt.attemptId);
  const lines = [
    "Logs",
    renderKv("Session", session.sessionId),
    ...(attempt ? [renderKv("Task", attempt.attemptId)] : []),
    renderKv("Events", String(filtered.length)),
  ];
  if (filtered.length === 0) {
    lines.push("  (no events recorded)");
    return lines;
  }
  for (const event of filtered) {
    const message = event.message ? ` ${safe(event.message)}` : "";
    lines.push(`${event.timestamp} ${event.taskId} ${event.kind} ${event.status}${message}`);
  }
  return lines;
};
