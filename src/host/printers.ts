import { ArtifactStore } from "../artifactStore.js";
import type { SessionEventEnvelope } from "../protocol.js";
import type { ReviewClassification } from "../resultClassifier.js";
import { persistedReviewForAttempt, reviewTaskResult } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import type {
  SessionAttemptRecord,
  SessionRecord,
  SessionReviewAction,
  SessionReviewOutcome,
  SessionTurnRecord,
} from "../sessionTypes.js";
import {
  blue,
  cyan,
  dim,
  gray,
  green,
  red,
  renderKeyValue,
  renderSection,
  renderStatusSymbol,
  yellow,
} from "./ansi.js";
import { formatInspectReview, formatInspectSandbox } from "./inspectFormatter.js";
import { stdoutWrite } from "./io.js";
import { storageRootFor } from "./sessionRunSupport.js";
import type { HostCliArgs } from "./parsing.js";
import type { SessionSummaryView } from "./sessionIndex.js";
import * as timeline from "./timeline.js";

/**
 * Render a status badge with a Unicode symbol + short label.
 * Matches the visual style of Codex CLI / OpenCode status indicators.
 */
export const statusBadge = (status: string): string => {
  const symbol = renderStatusSymbol(status);
  switch (status) {
    case "completed":
    case "succeeded":
    case "success":
      return `${symbol} ${green("ok")}`;
    case "running":
    case "reviewing":
      return `${symbol} ${blue("running")}`;
    case "planned":
    case "queued":
      return `${symbol} ${cyan("queued")}`;
    case "awaiting_user":
    case "blocked":
    case "blocked_needs_user":
      return `${symbol} ${yellow("waiting")}`;
    case "failed":
    case "retryable_failure":
    case "policy_denied":
      return `${symbol} ${red("failed")}`;
    default:
      return `${symbol} ${gray(status)}`;
  }
};

export const formatUtcTimestamp = (value: string | undefined): string => {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(".000Z", "Z");
};

export const nextActionHint = (
  reviewed: { action: string },
  attempt?: SessionAttemptRecord,
): string => {
  if (attempt?.candidateState === "candidate_ready") {
    return "Inspect `bakudo review` and `bakudo sandbox`, then accept to apply or halt to discard the preserved candidate.";
  }
  if (attempt?.candidateState === "needs_confirmation") {
    return "Inspect the preserved candidate and current checkout drift, then accept to continue or halt to discard.";
  }
  if (attempt?.candidateState === "apply_failed") {
    return "Inspect `bakudo review` and `bakudo sandbox`; the preserved candidate was kept because apply failed.";
  }
  switch (reviewed.action) {
    case "accept":
      return "No follow-up needed.";
    case "retry":
      return "Use `bakudo resume <session-id> [task-id]` to retry with the current host settings.";
    case "ask_user":
      return "Inspect `bakudo review` and `bakudo sandbox` before deciding whether to retry or adjust scope.";
    case "follow_up":
      return "Review worker logs and artifacts, then decide whether the host should retry or narrow the task.";
    case "halt":
      return "Stop here until the host policy or task framing changes.";
    default:
      return "Inspect the session before taking the next step.";
  }
};

export const formatArtifacts = (
  artifacts: Awaited<ReturnType<ArtifactStore["listTaskArtifacts"]>>,
): string[] =>
  artifacts.map((artifact) => `  - ${artifact.name} (${artifact.kind}) -> ${artifact.path}`);

export const attemptModeLabel = (attempt: SessionAttemptRecord): string =>
  attempt.request?.mode ?? (attempt.request?.assumeDangerousSkipPermissions ? "build" : "plan");

export const latestTurn = (session: SessionRecord): SessionTurnRecord | undefined =>
  session.turns.at(-1);
export const latestAttempt = (
  turn: SessionTurnRecord,
  attemptId?: string,
): SessionAttemptRecord | undefined => {
  if (attemptId !== undefined) {
    return turn.attempts.find((attempt) => attempt.attemptId === attemptId);
  }
  return turn.attempts.at(-1);
};

export const findAttemptById = (
  session: SessionRecord,
  attemptId: string,
): { turn: SessionTurnRecord; attempt: SessionAttemptRecord } | undefined => {
  for (const turn of session.turns) {
    const attempt = turn.attempts.find((entry) => entry.attemptId === attemptId);
    if (attempt !== undefined) {
      return { turn, attempt };
    }
  }
  return undefined;
};

export const countSessionAttempts = (session: SessionRecord): number =>
  session.turns.reduce((total, turn) => total + turn.attempts.length, 0);

export type TurnReviewView = {
  outcome: SessionReviewOutcome;
  action: SessionReviewAction;
  reason?: string;
};

/** Structured review view for a turn/attempt pair. Prefers `latestReview`. */
export const reviewViewFor = (
  turn: SessionTurnRecord | undefined,
  attempt: SessionAttemptRecord | undefined,
): TurnReviewView | null => {
  const persisted = persistedReviewForAttempt(turn, attempt);
  if (persisted !== undefined) {
    return {
      outcome: persisted.outcome,
      action: persisted.action,
      ...(persisted.reason === undefined ? {} : { reason: persisted.reason }),
    };
  }
  if (attempt?.result !== undefined) {
    const reviewed = reviewTaskResult(attempt.result);
    return { outcome: reviewed.outcome, action: reviewed.action, reason: reviewed.reason };
  }
  return null;
};

export const reviewedOutcomeExitCode = (
  reviewed: { outcome: ReviewClassification["outcome"]; [key: string]: unknown },
): number => {
  if (reviewed.outcome === "success") {
    return 0;
  }
  if (reviewed.outcome === "blocked_needs_user") {
    return 2;
  }
  if (reviewed.outcome === "policy_denied") {
    return 3;
  }
  return 1;
};

export const printRunSummary = (
  session: SessionRecord,
  reviewed: {
    outcome: ReviewClassification["outcome"];
    action: string;
    reason?: string;
    taskId?: string;
    result?: { summary: string };
  },
): void => {
  const taskId = reviewed.taskId ?? session.turns.at(-1)?.attempts.at(-1)?.attemptId ?? "n/a";
  const attempt = findAttemptById(session, taskId)?.attempt;
  const sbx =
    typeof attempt?.metadata?.sandboxTaskId === "string" ? attempt.metadata.sandboxTaskId : "n/a";
  const summary = reviewed.result?.summary ?? attempt?.result?.summary ?? "n/a";
  stdoutWrite(
    [
      "",
      renderSection("Summary"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Status", statusBadge(session.status)),
      renderKeyValue("Task", taskId),
      renderKeyValue("Sandbox", sbx),
      renderKeyValue("Outcome", statusBadge(reviewed.outcome)),
      renderKeyValue("Action", reviewed.action),
      renderKeyValue("Reason", reviewed.reason ?? "n/a"),
      renderKeyValue("Summary", summary),
    ].join("\n") + "\n",
  );
};

const loadSessionOrThrow = async (rootDir: string, sessionId: string): Promise<SessionRecord> => {
  const session = await timeline.loadSession(rootDir, sessionId);
  if (session === null) {
    throw new Error(`unknown session: ${sessionId}`);
  }
  return session;
};

export const printTasks = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await loadSessionOrThrow(rootDir, args.sessionId ?? "");
  const lines = [
    renderSection("Tasks"),
    renderKeyValue("Session", session.sessionId),
    renderKeyValue("Status", `${statusBadge(session.status)} ${session.status}`),
    renderKeyValue("Goal", session.title),
    "",
  ];
  for (const turn of session.turns) {
    const tailId = turn.attempts.at(-1)?.attemptId;
    for (const attempt of turn.attempts) {
      const reviewed =
        attempt.attemptId === tailId
          ? reviewViewFor(turn, attempt)
          : attempt.result === undefined
            ? null
            : reviewTaskResult(attempt.result);
      const sbx =
        typeof attempt.metadata?.sandboxTaskId === "string"
          ? attempt.metadata.sandboxTaskId
          : "n/a";
      lines.push(
        `- ${statusBadge(attempt.status)} ${attempt.attemptId} mode=${attemptModeLabel(attempt)} status=${attempt.status} sandbox=${sbx}${attempt.candidateState ? ` candidate=${attempt.candidateState}` : ""}${reviewed ? ` outcome=${reviewed.outcome} action=${reviewed.action}` : ""}${attempt.lastMessage ? ` message=${attempt.lastMessage}` : ""}`,
      );
    }
  }
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

/** Lift the index-level review hint into the shape `reviewViewFor` produces. */
export const reviewViewForSummary = (summary: SessionSummaryView): TurnReviewView | null => {
  if (summary.latestReviewedOutcome === undefined || summary.latestReviewedAction === undefined) {
    return null;
  }
  return { outcome: summary.latestReviewedOutcome, action: summary.latestReviewedAction };
};

const emptySessionsText = (heading: string): string =>
  [
    renderSection(heading),
    "  No sessions found yet.",
    dim('  Try `bakudo plan "inspect the repo"` or start the shell with `bakudo`.'),
  ].join("\n") + "\n";

const formatSummaryLine = (summary: SessionSummaryView): string => {
  const reviewed = reviewViewForSummary(summary);
  return `- ${statusBadge(summary.status)} ${summary.sessionId} status=${summary.status} updated=${summary.updatedAt}${summary.latestCandidateState ? ` candidate=${summary.latestCandidateState}` : ""}${reviewed ? ` latest=${reviewed.outcome}` : ""} title=${summary.title}`;
};

const emitSummariesJsonl = (summaries: SessionSummaryView[]): void => {
  for (const summary of summaries) {
    stdoutWrite(`${JSON.stringify(summary)}\n`);
  }
};

export const printSessions = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const summaries = await timeline.listSessionSummaries(rootDir);
  if (args.copilot.outputFormat === "json") {
    emitSummariesJsonl(summaries);
    return 0;
  }
  if (summaries.length === 0) {
    stdoutWrite(emptySessionsText("Sessions"));
    return 0;
  }
  const lines = [renderSection("Sessions"), ...summaries.map(formatSummaryLine)];
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

export const printStatus = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const json = args.copilot.outputFormat === "json";
  if (!args.sessionId) {
    const summaries = await timeline.listSessionSummaries(rootDir);
    if (json) {
      emitSummariesJsonl(summaries);
      return 0;
    }
    if (summaries.length === 0) {
      stdoutWrite(emptySessionsText("Host Status"));
      return 0;
    }
    const lines = [renderSection("Host Status"), ...summaries.map(formatSummaryLine)];
    stdoutWrite(lines.join("\n") + "\n");
    return 0;
  }

  const session = await loadSessionOrThrow(rootDir, args.sessionId);
  if (json) {
    stdoutWrite(`${JSON.stringify(session)}\n`);
    return 0;
  }

  const turn = latestTurn(session);
  const attempt = turn === undefined ? undefined : latestAttempt(turn);
  const reviewed = reviewViewFor(turn, attempt);
  const kv = renderKeyValue;
  const lines = [
    renderSection("Status"),
    kv("Session", session.sessionId),
    kv("Goal", session.title),
    kv("State", `${statusBadge(session.status)} ${session.status}`),
    kv("Updated", formatUtcTimestamp(session.updatedAt)),
    kv("Turns", String(session.turns.length)),
    kv("Attempts", String(countSessionAttempts(session))),
  ];
  if (attempt) {
    const sbx =
      typeof attempt.metadata?.sandboxTaskId === "string" ? attempt.metadata.sandboxTaskId : "n/a";
    lines.push(
      kv(
        "Latest",
        `${attempt.attemptId} mode=${attemptModeLabel(attempt)} status=${attempt.status}${attempt.candidateState ? ` candidate=${attempt.candidateState}` : ""}`,
      ),
    );
    lines.push(kv("Sandbox", sbx));
    if (reviewed) {
      lines.push(kv("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`));
      lines.push(kv("Action", reviewed.action));
      lines.push(kv("Next", nextActionHint(reviewed, attempt)));
    }
  }
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

export const printSandbox = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await loadSessionOrThrow(rootDir, args.sessionId ?? "");
  const turn = latestTurn(session);
  if (turn === undefined) {
    throw new Error(`no turn found for session ${session.sessionId}`);
  }
  const attempt = latestAttempt(turn, args.taskId);
  if (attempt === undefined) {
    throw new Error(`no attempt found for session ${session.sessionId}`);
  }
  if (args.copilot.outputFormat === "json") {
    stdoutWrite(`${JSON.stringify(attempt)}\n`);
    return 0;
  }
  const artifacts = await new ArtifactStore(rootDir).listTaskArtifacts(
    session.sessionId,
    attempt.attemptId,
  );
  const lines = formatInspectSandbox({ session, attempt, artifacts });
  lines.push(
    "Next       Use `bakudo review` for the host verdict or `bakudo logs` for the event stream.",
  );
  stdoutWrite(`${renderSection("Sandbox")}\n${lines.slice(1).join("\n")}\n`);
  return 0;
};

export const printReview = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await loadSessionOrThrow(rootDir, args.sessionId ?? "");
  const turn = latestTurn(session);
  if (turn === undefined) {
    throw new Error(`no turn found for session ${session.sessionId}`);
  }
  const attempt = latestAttempt(turn, args.taskId);
  if (attempt?.result === undefined) {
    throw new Error(`no reviewed result found for session ${session.sessionId}`);
  }
  const reviewed = reviewTaskResult(attempt.result);
  const persistedReview = persistedReviewForAttempt(turn, attempt);
  const reviewForOutput = persistedReview ?? reviewed;
  if (args.copilot.outputFormat === "json") {
    stdoutWrite(
      `${JSON.stringify({
        ...reviewForOutput,
        ...(attempt.candidateState === undefined ? {} : { candidateState: attempt.candidateState }),
        ...(attempt.candidate?.driftDecision === undefined
          ? {}
          : { driftDecision: attempt.candidate.driftDecision }),
        ...(attempt.candidate?.confirmationReason === undefined
          ? {}
          : { confirmationReason: attempt.candidate.confirmationReason }),
        ...(attempt.candidate?.applyError === undefined
          ? {}
          : { applyError: attempt.candidate.applyError }),
      })}\n`,
    );
    return reviewedOutcomeExitCode(reviewForOutput);
  }
  const artifactStore = new ArtifactStore(rootDir);
  const artifacts = await artifactStore.listTaskArtifacts(session.sessionId, attempt.attemptId);
  const lines = formatInspectReview({ session, attempt, reviewed: reviewForOutput, artifacts });
  lines.push(`Next       ${nextActionHint(reviewForOutput, attempt)}`);
  stdoutWrite(`${renderSection("Review")}\n${lines.slice(1).join("\n")}\n`);
  return reviewedOutcomeExitCode(reviewForOutput);
};

const truncateLogValue = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberField = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const booleanField = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const joinLogDetails = (parts: Array<string | undefined>): string =>
  parts.filter((part): part is string => part !== undefined && part.length > 0).join(" ");

const envelopeAttemptId = (envelope: SessionEventEnvelope): string | undefined => {
  const payload = envelope.payload as Record<string, unknown>;
  return envelope.attemptId ?? stringField(payload.attemptId);
};

const envelopeTurnId = (envelope: SessionEventEnvelope): string | undefined => {
  const payload = envelope.payload as Record<string, unknown>;
  return envelope.turnId ?? stringField(payload.turnId);
};

const envelopeStatus = (envelope: SessionEventEnvelope): string | undefined => {
  const payload = envelope.payload as Record<string, unknown>;
  return stringField(payload.status);
};

const commandDetail = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const command = value.filter((part): part is string => typeof part === "string").join(" ");
  return command.length > 0 ? truncateLogValue(command, 120) : undefined;
};

const fallbackPayloadDetail = (payload: Record<string, unknown>): string => {
  const message = stringField(payload.message);
  if (message !== undefined) {
    return `message=${truncateLogValue(message, 120)}`;
  }
  const serialized = JSON.stringify(payload);
  return serialized === "{}" ? "" : truncateLogValue(serialized, 160);
};

const envelopeDetail = (envelope: SessionEventEnvelope): string => {
  const payload = envelope.payload as Record<string, unknown>;
  switch (envelope.kind) {
    case "user.turn_submitted":
    case "host.turn_queued":
      return joinLogDetails([
        stringField(payload.mode) ? `mode=${stringField(payload.mode)}` : undefined,
        stringField(payload.prompt)
          ? `prompt=${truncateLogValue(stringField(payload.prompt)!, 100)}`
          : undefined,
      ]);
    case "host.plan_started":
    case "host.plan_completed":
    case "host.dispatch_started":
      return joinLogDetails([
        stringField(payload.mode) ? `mode=${stringField(payload.mode)}` : undefined,
        stringField(payload.goal)
          ? `goal=${truncateLogValue(stringField(payload.goal)!, 100)}`
          : undefined,
      ]);
    case "host.provenance_started":
      return joinLogDetails([
        stringField(payload.provenanceId)
          ? `provenance=${stringField(payload.provenanceId)}`
          : undefined,
        stringField(payload.sandboxTaskId)
          ? `sandbox=${stringField(payload.sandboxTaskId)}`
          : undefined,
        commandDetail(payload.dispatchCommand)
          ? `cmd=${commandDetail(payload.dispatchCommand)}`
          : undefined,
      ]);
    case "host.provenance_finalized":
      return joinLogDetails([
        stringField(payload.provenanceId)
          ? `provenance=${stringField(payload.provenanceId)}`
          : undefined,
        numberField(payload.exitCode) !== undefined
          ? `exit=${String(numberField(payload.exitCode))}`
          : undefined,
        booleanField(payload.timedOut) === true ? "timedOut=true" : undefined,
        numberField(payload.elapsedMs) !== undefined
          ? `elapsedMs=${String(numberField(payload.elapsedMs))}`
          : undefined,
      ]);
    case "host.approval_requested": {
      const request =
        payload.request !== null && typeof payload.request === "object"
          ? (payload.request as Record<string, unknown>)
          : undefined;
      return joinLogDetails([
        stringField(request?.tool) ? `tool=${stringField(request?.tool)}` : undefined,
        stringField(request?.displayCommand)
          ? `cmd=${truncateLogValue(stringField(request?.displayCommand)!, 120)}`
          : undefined,
      ]);
    }
    case "host.approval_resolved":
      return joinLogDetails([
        stringField(payload.decision) ? `decision=${stringField(payload.decision)}` : undefined,
        stringField(payload.decidedBy) ? `by=${stringField(payload.decidedBy)}` : undefined,
        stringField(payload.rationale)
          ? `why=${truncateLogValue(stringField(payload.rationale)!, 120)}`
          : undefined,
      ]);
    case "worker.attempt_started":
    case "worker.attempt_progress":
    case "worker.attempt_completed":
    case "worker.attempt_failed":
      return joinLogDetails([
        stringField(payload.status) ? `status=${stringField(payload.status)}` : undefined,
        numberField(payload.percentComplete) !== undefined
          ? `percent=${String(numberField(payload.percentComplete))}`
          : undefined,
        numberField(payload.exitCode) !== undefined
          ? `exit=${String(numberField(payload.exitCode))}`
          : undefined,
        stringField(payload.exitSignal) ? `signal=${stringField(payload.exitSignal)}` : undefined,
        booleanField(payload.timedOut) === true ? "timedOut=true" : undefined,
        numberField(payload.elapsedMs) !== undefined
          ? `elapsedMs=${String(numberField(payload.elapsedMs))}`
          : undefined,
        numberField(payload.outputBytes) !== undefined
          ? `outputBytes=${String(numberField(payload.outputBytes))}`
          : undefined,
        stringField(payload.subKind) ? `subKind=${stringField(payload.subKind)}` : undefined,
        stringField(payload.message)
          ? `message=${truncateLogValue(stringField(payload.message)!, 120)}`
          : undefined,
      ]);
    case "host.review_started":
      return joinLogDetails([
        stringField(payload.attemptId) ? `attempt=${stringField(payload.attemptId)}` : undefined,
      ]);
    case "host.review_completed":
      return joinLogDetails([
        stringField(payload.outcome) ? `outcome=${stringField(payload.outcome)}` : undefined,
        stringField(payload.action) ? `action=${stringField(payload.action)}` : undefined,
        stringField(payload.reason)
          ? `reason=${truncateLogValue(stringField(payload.reason)!, 120)}`
          : undefined,
      ]);
    case "host.artifact_registered":
      return joinLogDetails([
        stringField(payload.kind) ? `kind=${stringField(payload.kind)}` : undefined,
        stringField(payload.name) ? `name=${stringField(payload.name)}` : undefined,
      ]);
    default:
      return fallbackPayloadDetail(payload);
  }
};

const formatLogEnvelope = (envelope: SessionEventEnvelope): string => {
  const status = envelopeStatus(envelope);
  const badge = status === undefined ? gray("[LOG]") : statusBadge(status);
  const turnId = envelopeTurnId(envelope) ?? "-";
  const attemptId = envelopeAttemptId(envelope) ?? "-";
  const detail = envelopeDetail(envelope);
  return `${formatUtcTimestamp(envelope.timestamp)} ${badge} ${envelope.kind} turn=${turnId} attempt=${attemptId}${detail.length > 0 ? ` ${detail}` : ""}`;
};

export const printLogs = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const json = args.copilot.outputFormat === "json";
  await loadSessionOrThrow(rootDir, args.sessionId ?? "");
  const { envelopes, malformedLineCount } = await timeline.loadEventLog(
    rootDir,
    args.sessionId ?? "",
  );
  const filtered =
    args.taskId === undefined
      ? envelopes
      : envelopes.filter((envelope) => envelopeAttemptId(envelope) === args.taskId);

  if (json) {
    for (const envelope of filtered) {
      stdoutWrite(`${JSON.stringify(envelope)}\n`);
    }
    return 0;
  }

  if (filtered.length === 0 && malformedLineCount === 0) {
    stdoutWrite("No log events found.\n");
    return 0;
  }
  const lines = [renderSection("Logs"), ...filtered.map(formatLogEnvelope)];
  if (malformedLineCount > 0) {
    lines.push(dim(`Skipped ${malformedLineCount} malformed event log line(s).`));
  }
  stdoutWrite(`${lines.join("\n")}\n`);
  return 0;
};
