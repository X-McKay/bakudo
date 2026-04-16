import type { SessionReviewRecord } from "../sessionTypes.js";
import type { SessionStore } from "../sessionStore.js";
import type { WorkerTaskProgressEvent, WorkerTaskSpec } from "../workerRuntime.js";
import { bold, dim, renderKeyValue, renderModeChip, renderSection } from "./ansi.js";
import type { HostCliArgs } from "./parsing.js";
import { statusBadge } from "./printers.js";

export const formatProgressLine = (event: WorkerTaskProgressEvent): string => {
  const stamp = event.timestamp.slice(11, 19);
  const metrics = [
    event.elapsedMs !== undefined ? `elapsed=${event.elapsedMs}ms` : "",
    event.stdoutBytes !== undefined ? `stdout=${event.stdoutBytes}B` : "",
    event.stderrBytes !== undefined ? `stderr=${event.stderrBytes}B` : "",
    event.exitCode !== undefined && event.exitCode !== null ? `exit=${event.exitCode}` : "",
    event.timedOut ? "timed_out=true" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const detail = event.message ? ` ${event.message}` : "";
  const suffix = metrics ? ` ${dim(`(${metrics})`)}` : "";
  return `${dim(`[${stamp}]`)} ${statusBadge(event.status)} ${bold(event.kind)}${detail}${suffix}\n`;
};

export const renderDispatchBanner = (
  sessionId: string,
  request: WorkerTaskSpec,
  mode: HostCliArgs["mode"],
): string =>
  [
    "",
    renderSection("Dispatch"),
    `${statusBadge("queued")} ${renderModeChip(request.mode ?? mode)} ${dim("sending task to abox worker")}`,
    renderKeyValue("Session", sessionId),
    renderKeyValue("Task", request.taskId),
    renderKeyValue("Goal", request.goal),
    renderKeyValue("Sandbox", "ephemeral abox worker"),
    "",
  ].join("\n");

/**
 * Merge a {@link SessionReviewRecord} into the named turn. Silently no-ops
 * when the session or turn has gone missing so callers do not need to guard
 * against races between executions and session mutations.
 */
export const upsertTurnLatestReview = async (
  sessionStore: SessionStore,
  sessionId: string,
  turnId: string,
  latestReview: SessionReviewRecord,
): Promise<void> => {
  const session = await sessionStore.loadSession(sessionId);
  if (session === null) {
    return;
  }
  const turn = session.turns.find((entry) => entry.turnId === turnId);
  if (turn === undefined) {
    return;
  }
  await sessionStore.upsertTurn(sessionId, { ...turn, latestReview });
};
