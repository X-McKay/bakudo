import type { AttemptSpec } from "../attemptProtocol.js";
import type { ArtifactStore } from "../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../reviewer.js";
import type { ReviewConfidence } from "../resultClassifier.js";
import { synthesizeLegacySpec } from "../sessionMigration.js";
import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionReviewRecord,
  SessionTurnRecord,
} from "../sessionTypes.js";

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
 * Resolve the {@link AttemptSpec} for display. Returns the persisted spec when
 * available, or synthesizes a read-only legacy spec for v2 sessions.
 */
const resolveAttemptSpec = (
  attempt: SessionAttemptRecord | undefined,
  turn: SessionTurnRecord | undefined,
): Partial<AttemptSpec> | undefined => {
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

type ReviewLike = Pick<ReviewedTaskResult, "outcome" | "action"> & { reason?: string };

const reviewFromTurn = (turn: SessionTurnRecord | undefined): SessionReviewRecord | undefined =>
  turn?.latestReview;

const selectReviewView = (
  turn: SessionTurnRecord | undefined,
  attempt: SessionAttemptRecord | undefined,
): ReviewLike | null => {
  const fromTurn = reviewFromTurn(turn);
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

const formatArtifactRows = (artifacts: ArtifactRow[]): string[] =>
  artifacts.map((artifact) => `  - ${artifact.name} (${artifact.kind}) -> ${artifact.path}`);

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
    renderKv("Repo", session.repoRoot),
    renderKv("Goal", session.turns[0]?.prompt ?? session.title),
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
  }
  const spec = resolveAttemptSpec(attempt, turn);
  if (spec?.taskKind !== undefined) {
    lines.push(renderKv("TaskKind", spec.taskKind));
  }
  if (spec?.execution?.engine !== undefined) {
    lines.push(renderKv("Engine", spec.execution.engine));
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
export type InspectReviewPayload = ReviewedTaskResult & {
  confidence?: ReviewConfidence;
  userExplanation?: string;
  remediationHint?: string;
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
  if (reviewed.confidence !== undefined) {
    lines.push(renderKv("Confidence", reviewed.confidence));
  }
  if (reviewed.userExplanation !== undefined && reviewed.userExplanation.length > 0) {
    lines.push(renderKv("Explain", reviewed.userExplanation));
  }
  lines.push(renderKv("Reason", reviewed.reason));
  if (reviewed.remediationHint !== undefined && reviewed.remediationHint.length > 0) {
    lines.push(renderKv("Remedy", reviewed.remediationHint));
  }
  if (result) {
    lines.push(renderKv("Summary", result.summary));
    if (result.exitCode !== undefined && result.exitCode !== null) {
      lines.push(renderKv("Exit", String(result.exitCode)));
    }
    if (result.startedAt) {
      lines.push(renderKv("Started", formatUtc(result.startedAt)));
    }
    lines.push(renderKv("Finished", formatUtc(result.finishedAt)));
  }
  if (typeof attempt.metadata?.sandboxTaskId === "string") {
    lines.push(renderKv("Sandbox", attempt.metadata.sandboxTaskId));
  }
  if (dispatchArtifact) {
    lines.push(renderKv("Dispatch", dispatchArtifact.path));
  }
  if (workerLog) {
    lines.push(renderKv("Worker", workerLog.path));
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
  const dispatchCommand = dispatchCommandOf(attempt);
  const aboxCommand = dispatchCommand === undefined ? "n/a" : dispatchCommand.join(" ");
  const lines = [
    "Sandbox",
    renderKv("Session", session.sessionId),
    renderKv("Task", attempt.attemptId),
    renderKv("Mode", modeOf(attempt)),
    renderKv("Status", attempt.status),
    renderKv("Sandbox", sandboxOf(attempt)),
    renderKv("ABox", aboxCommand),
    renderKv(
      "Safety",
      attempt.request?.assumeDangerousSkipPermissions
        ? "dangerous-skip-permissions enabled in sandbox worker"
        : "host requested safer planning mode",
    ),
  ];
  if (artifacts.length > 0) {
    lines.push("Artifacts:");
    lines.push(...formatArtifactRows(artifacts));
  }
  if (attempt.result?.summary) {
    lines.push(renderKv("Summary", attempt.result.summary));
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
    const message = event.message ? ` ${event.message}` : "";
    lines.push(`${event.timestamp} ${event.taskId} ${event.kind} ${event.status}${message}`);
  }
  return lines;
};
