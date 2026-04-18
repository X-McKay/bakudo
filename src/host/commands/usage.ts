/**
 * Phase 6 Wave 6c PR8 — `bakudo usage` + `/usage`.
 *
 * A6.8 "usage reporter". The driver resolves the storage root, enumerates
 * the sessions under the repo's storage tree (or the one the caller named
 * with `--session`), loads their event envelopes via the Phase 2 NDJSON
 * reader, and delegates per-session rollup to
 * {@link buildUsageSessionRow}. All parse/format logic lives in
 * `usageSupport.ts` so the driver stays within the LOC cap and so every
 * pure helper is unit-testable without touching disk.
 *
 * The file name collides with the existing `src/host/usage.ts` (the help
 * banner). The module paths differ (`./commands/usage.js` vs `../usage.js`)
 * so no import-site confusion occurs; the banner file keeps its role.
 */

import type { HostCommandSpec } from "../commandRegistry.js";
import { stdoutWrite } from "../io.js";
import { storageRootFor, repoRootFor } from "../orchestration.js";
import { listSessionSummaries, loadSession, readSessionEventLog } from "../timeline.js";
import type { SessionEventEnvelope } from "../../protocol.js";
import type { SessionRecord } from "../../sessionTypes.js";
import {
  buildUsageSessionRow,
  formatUsageReport,
  parseUsageArgs,
  sumUsageTotals,
  type UsageArgs,
  type UsageFormat,
  type UsageReport,
  type UsageSessionRow,
} from "./usageSupport.js";

export type RunUsageInput = {
  args: UsageArgs;
  storageRoot: string;
  now?: number;
};

const resolveCutoff = (args: UsageArgs, now: number): string | null =>
  args.sinceMs === undefined ? null : new Date(now - args.sinceMs).toISOString();

/**
 * Pure-ish driver: I/O only for reads. Walks either the `--session` fast
 * path or every session under `storageRoot` and rolls each into a
 * {@link UsageSessionRow} via the support helper.
 */
export const runUsage = async (input: RunUsageInput): Promise<UsageReport> => {
  const now = input.now ?? Date.now();
  const cutoffIso = resolveCutoff(input.args, now);
  const sessionIds =
    input.args.sessionId !== undefined
      ? [input.args.sessionId]
      : (await listSessionSummaries(input.storageRoot)).map((s) => s.sessionId);
  const rows: UsageSessionRow[] = [];
  for (const sessionId of sessionIds) {
    const session: SessionRecord | null = await loadSession(input.storageRoot, sessionId);
    if (session === null) continue;
    const envelopes: SessionEventEnvelope[] = await readSessionEventLog(
      input.storageRoot,
      sessionId,
    );
    rows.push(
      buildUsageSessionRow({
        session,
        envelopes,
        ...(cutoffIso !== null ? { cutoffIso } : {}),
      }),
    );
  }
  // Newest-updated first so the common "what did I just run?" case is at
  // the top of the table.
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { args: input.args, sessions: rows, totals: sumUsageTotals(rows) };
};

const resolveFormat = (args: UsageArgs, probe: { isTty: boolean }): UsageFormat =>
  args.format ?? (probe.isTty ? "text" : "json");

export const formatUsageOutput = (report: UsageReport, format: UsageFormat): string => {
  if (format === "json") {
    return JSON.stringify(report);
  }
  return formatUsageReport(report).join("\n");
};

export type RunUsageCommandInput = {
  args: ReadonlyArray<string>;
  repoRoot?: string;
  storageRoot?: string;
  stdoutIsTty?: boolean;
  now?: number;
};

export type RunUsageCommandResult = {
  report?: UsageReport;
  exitCode: number;
  error?: string;
};

/**
 * One-shot CLI entrypoint. Mirrors `runCleanupCommand`: parse → run →
 * format → stdout. Returns an exit code rather than throwing so the
 * dispatcher can surface a typed ErrorResolution.
 */
export const runUsageCommand = async (
  input: RunUsageCommandInput,
): Promise<RunUsageCommandResult> => {
  const parsed = parseUsageArgs(input.args);
  if (!parsed.ok) {
    stdoutWrite(`usage: ${parsed.error}\n`);
    return { exitCode: 2, error: parsed.error };
  }
  const storageRoot = storageRootFor(input.repoRoot, input.storageRoot);
  const report = await runUsage({
    args: parsed.args,
    storageRoot,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const format = resolveFormat(parsed.args, { isTty: input.stdoutIsTty ?? false });
  stdoutWrite(`${formatUsageOutput(report, format)}\n`);
  return { report, exitCode: 0 };
};

/**
 * In-shell `/usage` handler. If no `--session` flag is supplied, defaults
 * to the active session so the common case ("how many tokens have I spent
 * in this conversation?") does not require flags. Always text-mode inside
 * the shell — JSON is a CLI-only concession.
 */
export const usageCommandSpec: HostCommandSpec = {
  name: "usage",
  group: "system",
  description: "Token + attempt totals for the active session (use --session <id> for any other).",
  handler: async ({ args, deps }) => {
    const parsed = parseUsageArgs(args);
    if (!parsed.ok) {
      deps.transcript.push({ kind: "assistant", text: `usage: ${parsed.error}`, tone: "error" });
      return;
    }
    const effective: UsageArgs = { ...parsed.args };
    if (effective.sessionId === undefined && deps.appState.activeSessionId !== undefined) {
      effective.sessionId = deps.appState.activeSessionId;
    }
    const storageRoot = storageRootFor(repoRootFor(undefined), undefined);
    const report = await runUsage({ args: effective, storageRoot });
    const format: UsageFormat = effective.format ?? "text";
    if (format === "json") {
      deps.transcript.push({
        kind: "event",
        label: "usage",
        detail: JSON.stringify(report),
      });
      return;
    }
    for (const line of formatUsageReport(report)) {
      deps.transcript.push({ kind: "event", label: "usage", detail: line });
    }
  },
};
