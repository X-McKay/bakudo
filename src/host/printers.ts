import { ArtifactStore } from "../artifactStore.js";
import { type ReviewedTaskResult, reviewTaskResult } from "../reviewer.js";
import { SessionStore } from "../sessionStore.js";
import type { SessionRecord, SessionTaskRecord } from "../sessionTypes.js";
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

export const taskModeLabel = (task: SessionTaskRecord): string =>
  task.request?.mode ?? (task.request?.assumeDangerousSkipPermissions ? "build" : "plan");

export const latestTaskRecord = (
  session: SessionRecord,
  taskId?: string,
): SessionTaskRecord | undefined => {
  if (taskId !== undefined) {
    return session.tasks.find((task) => task.taskId === taskId);
  }
  return session.tasks.at(-1);
};

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
  const task = session.tasks.find((entry) => entry.taskId === reviewed.taskId);
  const sandboxTaskId =
    typeof task?.metadata?.sandboxTaskId === "string" ? task.metadata.sandboxTaskId : "n/a";
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

export const printTasks = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await new SessionStore(rootDir).loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const lines = [
    renderSection("Tasks"),
    renderKeyValue("Session", session.sessionId),
    renderKeyValue("Status", `${statusBadge(session.status)} ${session.status}`),
    renderKeyValue("Goal", session.goal),
    "",
  ];
  for (const task of session.tasks) {
    const reviewed = task.result === undefined ? null : reviewTaskResult(task.result);
    const sandboxTaskId =
      typeof task.metadata?.sandboxTaskId === "string" ? task.metadata.sandboxTaskId : "n/a";
    lines.push(
      `- ${statusBadge(task.status)} ${task.taskId} mode=${taskModeLabel(task)} status=${task.status} sandbox=${sandboxTaskId}${reviewed ? ` outcome=${reviewed.outcome} action=${reviewed.action}` : ""}${task.lastMessage ? ` message=${task.lastMessage}` : ""}`,
    );
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
    const latestTask = session.tasks.at(-1);
    const reviewed = latestTask?.result ? reviewTaskResult(latestTask.result) : null;
    lines.push(
      `- ${statusBadge(session.status)} ${session.sessionId} status=${session.status} tasks=${session.tasks.length} updated=${session.updatedAt}${reviewed ? ` latest=${reviewed.outcome}` : ""} goal=${session.goal}`,
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
  const session = await new SessionStore(rootDir).loadSession(args.sessionId);
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const latestTask = session.tasks.at(-1);
  const reviewed = latestTask?.result ? reviewTaskResult(latestTask.result) : null;
  const lines = [
    renderSection("Status"),
    renderKeyValue("Session", session.sessionId),
    renderKeyValue("Goal", session.goal),
    renderKeyValue("State", `${statusBadge(session.status)} ${session.status}`),
    renderKeyValue("Updated", formatUtcTimestamp(session.updatedAt)),
    renderKeyValue("Tasks", String(session.tasks.length)),
  ];
  if (latestTask) {
    const sandboxTaskId =
      typeof latestTask.metadata?.sandboxTaskId === "string"
        ? latestTask.metadata.sandboxTaskId
        : "n/a";
    lines.push(
      renderKeyValue(
        "Latest",
        `${latestTask.taskId} mode=${taskModeLabel(latestTask)} status=${latestTask.status}`,
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
  const session = await new SessionStore(rootDir).loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const task = latestTaskRecord(session, args.taskId);
  if (task === undefined) {
    throw new Error(`no task found for session ${session.sessionId}`);
  }

  const sandboxTaskId =
    typeof task.metadata?.sandboxTaskId === "string" ? task.metadata.sandboxTaskId : "n/a";
  const aboxCommand = Array.isArray(task.metadata?.aboxCommand)
    ? (task.metadata?.aboxCommand as unknown[]).map(String).join(" ")
    : "n/a";
  const artifacts = await new ArtifactStore(rootDir).listTaskArtifacts(
    session.sessionId,
    task.taskId,
  );
  stdoutWrite(
    [
      renderSection("Sandbox"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Task", task.taskId),
      renderKeyValue("Mode", taskModeLabel(task)),
      renderKeyValue("Status", `${statusBadge(task.status)} ${task.status}`),
      renderKeyValue("Sandbox", sandboxTaskId),
      renderKeyValue("ABox", aboxCommand),
      renderKeyValue(
        "Safety",
        task.request?.assumeDangerousSkipPermissions
          ? "dangerous-skip-permissions enabled in sandbox worker"
          : "host requested safer planning mode",
      ),
      ...(artifacts.length > 0 ? ["Artifacts:", ...formatArtifacts(artifacts)] : []),
      ...(task.result?.summary ? [renderKeyValue("Summary", task.result.summary)] : []),
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
  const sessionStore = new SessionStore(rootDir);
  const artifactStore = new ArtifactStore(rootDir);
  const session = await sessionStore.loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const task = latestTaskRecord(session, args.taskId);
  if (task?.result === undefined) {
    throw new Error(`no reviewed result found for session ${session.sessionId}`);
  }

  const reviewed = reviewTaskResult(task.result);
  const artifacts = await artifactStore.listTaskArtifacts(session.sessionId, task.taskId);
  const dispatchArtifact = artifacts.find((artifact) => artifact.kind === "dispatch");
  const workerLog = artifacts.find((artifact) => artifact.kind === "log");
  stdoutWrite(
    [
      renderSection("Review"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Task", task.taskId),
      renderKeyValue("Status", `${statusBadge(task.status)} ${task.status}`),
      renderKeyValue("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`),
      renderKeyValue("Action", reviewed.action),
      renderKeyValue("Reason", reviewed.reason),
      renderKeyValue("Summary", task.result.summary),
      ...(typeof task.metadata?.sandboxTaskId === "string"
        ? [renderKeyValue("Sandbox", task.metadata.sandboxTaskId)]
        : []),
      ...(task.result.exitCode === undefined
        ? []
        : [renderKeyValue("Exit", String(task.result.exitCode))]),
      ...(task.result.startedAt
        ? [renderKeyValue("Started", formatUtcTimestamp(task.result.startedAt))]
        : []),
      renderKeyValue("Finished", formatUtcTimestamp(task.result.finishedAt)),
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
  const session = await sessionStore.loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

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
