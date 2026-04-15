import { ArtifactStore } from "../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import type { SessionAttemptRecord, SessionRecord, SessionTurnRecord } from "../sessionTypes.js";
import {
  blue,
  cyan,
  dim,
  gray,
  green,
  red,
  renderKeyValue,
  renderSection,
  yellow,
} from "./ansi.js";
import { stdoutWrite } from "./io.js";
import { storageRootFor } from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";

export const statusBadge = (status: string): string => {
  switch (status) {
    case "completed":
    case "succeeded":
    case "success":
      return green("[OK]");
    case "running":
    case "reviewing":
      return blue("[RUN]");
    case "planned":
    case "queued":
      return cyan("[QUE]");
    case "awaiting_user":
    case "blocked":
    case "blocked_needs_user":
      return yellow("[ASK]");
    case "failed":
    case "retryable_failure":
    case "policy_denied":
      return red("[ERR]");
    default:
      return gray("[---]");
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

export const nextActionHint = (reviewed: ReviewedTaskResult): string => {
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

export const reviewedOutcomeExitCode = (reviewed: ReviewedTaskResult): number => {
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

export const printRunSummary = (session: SessionRecord, reviewed: ReviewedTaskResult): void => {
  const located = findAttemptById(session, reviewed.taskId);
  const attempt = located?.attempt;
  const sandboxTaskId =
    typeof attempt?.metadata?.sandboxTaskId === "string" ? attempt.metadata.sandboxTaskId : "n/a";
  stdoutWrite(
    [
      "",
      renderSection("Summary"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Status", `${statusBadge(session.status)} ${session.status}`),
      renderKeyValue("Task", reviewed.taskId),
      renderKeyValue("Sandbox", sandboxTaskId),
      renderKeyValue("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`),
      renderKeyValue("Action", reviewed.action),
      renderKeyValue("Reason", reviewed.reason),
      renderKeyValue("Summary", reviewed.result.summary),
    ].join("\n") + "\n",
  );
};

const loadSessionOrThrow = async (rootDir: string, sessionId: string): Promise<SessionRecord> => {
  const session = await new SessionStore(rootDir).loadSession(sessionId);
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
    renderKeyValue("Goal", session.goal),
    "",
  ];
  for (const turn of session.turns) {
    for (const attempt of turn.attempts) {
      const reviewed = attempt.result === undefined ? null : reviewTaskResult(attempt.result);
      const sandboxTaskId =
        typeof attempt.metadata?.sandboxTaskId === "string"
          ? attempt.metadata.sandboxTaskId
          : "n/a";
      lines.push(
        `- ${statusBadge(attempt.status)} ${attempt.attemptId} mode=${attemptModeLabel(attempt)} status=${attempt.status} sandbox=${sandboxTaskId}${reviewed ? ` outcome=${reviewed.outcome} action=${reviewed.action}` : ""}${attempt.lastMessage ? ` message=${attempt.lastMessage}` : ""}`,
      );
    }
  }
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

export const printSessions = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessions = await new SessionStore(rootDir).listSessions();
  if (sessions.length === 0) {
    stdoutWrite(
      [
        renderSection("Sessions"),
        "  No sessions found yet.",
        dim('  Try `bakudo plan "inspect the repo"` or start the shell with `bakudo`.'),
      ].join("\n") + "\n",
    );
    return 0;
  }

  const lines = [renderSection("Sessions")];
  for (const session of sessions) {
    const turn = latestTurn(session);
    const attempt = turn === undefined ? undefined : latestAttempt(turn);
    const reviewed = attempt?.result ? reviewTaskResult(attempt.result) : null;
    lines.push(
      `- ${statusBadge(session.status)} ${session.sessionId} status=${session.status} turns=${session.turns.length} attempts=${countSessionAttempts(session)} updated=${session.updatedAt}${reviewed ? ` latest=${reviewed.outcome}` : ""} goal=${session.goal}`,
    );
  }
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

export const printStatus = async (args: HostCliArgs): Promise<number> => {
  if (!args.sessionId) {
    stdoutWrite(`${renderSection("Host Status")}\n`);
    return printSessions(args);
  }

  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await loadSessionOrThrow(rootDir, args.sessionId);

  const turn = latestTurn(session);
  const attempt = turn === undefined ? undefined : latestAttempt(turn);
  const reviewed = attempt?.result ? reviewTaskResult(attempt.result) : null;
  const lines = [
    renderSection("Status"),
    renderKeyValue("Session", session.sessionId),
    renderKeyValue("Goal", session.goal),
    renderKeyValue("State", `${statusBadge(session.status)} ${session.status}`),
    renderKeyValue("Updated", formatUtcTimestamp(session.updatedAt)),
    renderKeyValue("Turns", String(session.turns.length)),
    renderKeyValue("Attempts", String(countSessionAttempts(session))),
  ];
  if (attempt) {
    const sandboxTaskId =
      typeof attempt.metadata?.sandboxTaskId === "string" ? attempt.metadata.sandboxTaskId : "n/a";
    lines.push(
      renderKeyValue(
        "Latest",
        `${attempt.attemptId} mode=${attemptModeLabel(attempt)} status=${attempt.status}`,
      ),
    );
    lines.push(renderKeyValue("Sandbox", sandboxTaskId));
    if (reviewed) {
      lines.push(renderKeyValue("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`));
      lines.push(renderKeyValue("Action", reviewed.action));
      lines.push(renderKeyValue("Next", nextActionHint(reviewed)));
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

  const sandboxTaskId =
    typeof attempt.metadata?.sandboxTaskId === "string" ? attempt.metadata.sandboxTaskId : "n/a";
  const aboxCommand = Array.isArray(attempt.metadata?.aboxCommand)
    ? (attempt.metadata?.aboxCommand as unknown[]).map(String).join(" ")
    : "n/a";
  const artifacts = await new ArtifactStore(rootDir).listTaskArtifacts(
    session.sessionId,
    attempt.attemptId,
  );
  stdoutWrite(
    [
      renderSection("Sandbox"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Task", attempt.attemptId),
      renderKeyValue("Mode", attemptModeLabel(attempt)),
      renderKeyValue("Status", `${statusBadge(attempt.status)} ${attempt.status}`),
      renderKeyValue("Sandbox", sandboxTaskId),
      renderKeyValue("ABox", aboxCommand),
      renderKeyValue(
        "Safety",
        attempt.request?.assumeDangerousSkipPermissions
          ? "dangerous-skip-permissions enabled in sandbox worker"
          : "host requested safer planning mode",
      ),
      ...(artifacts.length > 0 ? ["Artifacts:", ...formatArtifacts(artifacts)] : []),
      ...(attempt.result?.summary ? [renderKeyValue("Summary", attempt.result.summary)] : []),
      renderKeyValue(
        "Next",
        "Use `bakudo review` for the host verdict or `bakudo logs` for the event stream.",
      ),
    ].join("\n") + "\n",
  );
  return 0;
};

export const printReview = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const artifactStore = new ArtifactStore(rootDir);
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
  const artifacts = await artifactStore.listTaskArtifacts(session.sessionId, attempt.attemptId);
  const dispatchArtifact = artifacts.find((artifact) => artifact.kind === "dispatch");
  const workerLog = artifacts.find((artifact) => artifact.kind === "log");
  stdoutWrite(
    [
      renderSection("Review"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Task", attempt.attemptId),
      renderKeyValue("Status", `${statusBadge(attempt.status)} ${attempt.status}`),
      renderKeyValue("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`),
      renderKeyValue("Action", reviewed.action),
      renderKeyValue("Reason", reviewed.reason),
      renderKeyValue("Summary", attempt.result.summary),
      ...(typeof attempt.metadata?.sandboxTaskId === "string"
        ? [renderKeyValue("Sandbox", attempt.metadata.sandboxTaskId)]
        : []),
      ...(attempt.result.exitCode === undefined
        ? []
        : [renderKeyValue("Exit", String(attempt.result.exitCode))]),
      ...(attempt.result.startedAt
        ? [renderKeyValue("Started", formatUtcTimestamp(attempt.result.startedAt))]
        : []),
      renderKeyValue("Finished", formatUtcTimestamp(attempt.result.finishedAt)),
      ...(dispatchArtifact ? [renderKeyValue("Dispatch", dispatchArtifact.path)] : []),
      ...(workerLog ? [renderKeyValue("Worker", workerLog.path)] : []),
      ...(artifacts.length > 0 ? ["Artifacts:", ...formatArtifacts(artifacts)] : []),
      renderKeyValue("Next", nextActionHint(reviewed)),
    ].join("\n") + "\n",
  );
  return reviewedOutcomeExitCode(reviewed);
};

export const printLogs = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionStore = new SessionStore(rootDir);
  const session = await loadSessionOrThrow(rootDir, args.sessionId ?? "");

  const events = await sessionStore.readTaskEvents(session.sessionId);
  const lines = events
    .filter((event) => args.taskId === undefined || event.taskId === args.taskId)
    .map(
      (event) =>
        `${event.timestamp} ${statusBadge(event.status)} ${event.taskId} ${event.kind} ${event.status}${event.message ? ` ${event.message}` : ""}`,
    );
  if (lines.length === 0) {
    stdoutWrite("No task events found.\n");
    return 0;
  }
  stdoutWrite(`${renderSection("Logs")}\n${lines.join("\n")}\n`);
  return 0;
};
