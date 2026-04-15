import type { ArtifactStore } from "../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../reviewer.js";
import type { SessionAttemptRecord, SessionRecord, SessionTurnRecord } from "../sessionTypes.js";

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

const formatArtifactRows = (artifacts: ArtifactRow[]): string[] =>
  artifacts.map((artifact) => `  - ${artifact.name} (${artifact.kind}) -> ${artifact.path}`);

export type InspectSummaryInput = {
  session: SessionRecord;
  turn?: SessionTurnRecord;
  attempt?: SessionAttemptRecord;
};

export const formatInspectSummary = (input: InspectSummaryInput): string[] => {
  const { session, turn, attempt } = input;
  const reviewed = attempt?.result ? reviewTaskResult(attempt.result) : null;
  const lines = [
    "Summary",
    renderKv("Session", session.sessionId),
    renderKv("Repo", session.repoRoot),
    renderKv("Goal", session.goal),
    renderKv("State", session.status),
    renderKv("Updated", formatUtc(session.updatedAt)),
    renderKv("Turns", String(session.turns.length)),
  ];
  if (turn !== undefined) {
    lines.push(renderKv("Turn", `${turn.turnId} mode=${turn.mode} status=${turn.status}`));
  }
  if (attempt !== undefined) {
    lines.push(
      renderKv("Attempt", `${attempt.attemptId} mode=${modeOf(attempt)} status=${attempt.status}`),
    );
    lines.push(renderKv("Sandbox", sandboxOf(attempt)));
  }
  if (reviewed) {
    lines.push(renderKv("Outcome", reviewed.outcome));
    lines.push(renderKv("Action", reviewed.action));
  }
  return lines;
};

export type InspectReviewInput = {
  session: SessionRecord;
  attempt: SessionAttemptRecord;
  reviewed: ReviewedTaskResult;
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
    renderKv("Reason", reviewed.reason),
  ];
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
  const aboxCommand = Array.isArray(attempt.metadata?.aboxCommand)
    ? (attempt.metadata?.aboxCommand as unknown[]).map(String).join(" ")
    : "n/a";
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
