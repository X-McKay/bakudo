/**
 * Phase 6 Wave 6c PR8 — `bakudo chronicle` + `/chronicle`.
 *
 * Cross-session append-only event-log query. Plan reference:
 * `plans/bakudo-ux/06-rollout-reliability-and-operability.md` lines 782–791.
 *
 * This module is the thin driver: it resolves the storage root, walks the
 * set of sessions (either a single `--session <id>` or every session under
 * the repo's storage tree), fans out to
 * {@link readSessionEventLog} via the timeline query surface, and hands the
 * merged envelope stream to {@link filterChronicle}. All parse/filter logic
 * lives in `chronicleSupport.ts` so the driver stays within the 400-LOC cap
 * and so every pure helper is unit-testable without touching disk.
 */

import type { HostCommandSpec } from "../commandRegistry.js";
import { buildJsonErrorEnvelope } from "../errors.js";
import { stdoutWrite } from "../io.js";
import { storageRootFor, repoRootFor } from "../orchestration.js";
import { listSessionSummaries, readSessionEventLog } from "../timeline.js";
import type { SessionEventEnvelope } from "../../protocol.js";
import { argvRequestsJson } from "./jsonFormatDetection.js";
import {
  filterChronicle,
  formatChronicleRow,
  formatChronicleText,
  parseChronicleArgs,
  type ChronicleArgs,
  type ChronicleFormat,
} from "./chronicleSupport.js";

/**
 * Default row cap when the caller does not pass `--limit`. Chosen so that
 * even a noisy cross-session walk stays interactive-friendly while still
 * surfacing enough rows to be useful.
 */
export const DEFAULT_CHRONICLE_LIMIT = 200;

/** Default `--since` when invoked as an in-shell slash command. */
export const DEFAULT_INSHELL_SINCE_MS = 24 * 60 * 60 * 1000;

export type LoadChronicleEnvelopesInput = {
  storageRoot: string;
  /** Single-session shortcut. When absent, every session is loaded. */
  sessionId?: string;
};

/**
 * Load + flatten all session event envelopes in the storage root. The
 * returned list preserves the per-session NDJSON write order and then
 * sorts across sessions by timestamp ascending so filters see a single
 * stable chronological stream. Tolerant of missing files (empty list).
 */
export const loadChronicleEnvelopes = async (
  input: LoadChronicleEnvelopesInput,
): Promise<SessionEventEnvelope[]> => {
  const sessionIds =
    input.sessionId !== undefined
      ? [input.sessionId]
      : (await listSessionSummaries(input.storageRoot)).map((s) => s.sessionId);
  const all: SessionEventEnvelope[] = [];
  for (const sessionId of sessionIds) {
    const envelopes = await readSessionEventLog(input.storageRoot, sessionId);
    all.push(...envelopes);
  }
  all.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return all;
};

export type RunChronicleInput = {
  args: ChronicleArgs;
  storageRoot: string;
  now?: number;
};

export type ChronicleReport = {
  args: ChronicleArgs;
  envelopes: SessionEventEnvelope[];
  matched: number;
};

/**
 * Pure-ish driver: I/O only for reads. Applies the `--session` fast path
 * before walking the rest of the storage root, filters, and caps at
 * `args.limit ?? DEFAULT_CHRONICLE_LIMIT`.
 */
export const runChronicle = async (input: RunChronicleInput): Promise<ChronicleReport> => {
  const all = await loadChronicleEnvelopes({
    storageRoot: input.storageRoot,
    ...(input.args.sessionId !== undefined ? { sessionId: input.args.sessionId } : {}),
  });
  const filtered = filterChronicle({
    envelopes: all,
    args: input.args,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const limit = input.args.limit ?? DEFAULT_CHRONICLE_LIMIT;
  const capped = filtered.slice(0, limit);
  return { args: input.args, envelopes: capped, matched: filtered.length };
};

const resolveFormat = (args: ChronicleArgs, probe: { isTty: boolean }): ChronicleFormat =>
  args.format ?? (probe.isTty ? "text" : "json");

/**
 * Format a {@link ChronicleReport} for stdout. JSON mode emits one envelope
 * per line (NDJSON-style) so downstream tools can `jq` a stream without
 * buffering the whole report. Text mode returns a header + row list.
 */
export const formatChronicleReport = (report: ChronicleReport, format: ChronicleFormat): string => {
  if (format === "json") {
    return report.envelopes.map((e) => JSON.stringify(e)).join("\n");
  }
  return formatChronicleText(report.envelopes, report.args).join("\n");
};

export type RunChronicleCommandInput = {
  args: ReadonlyArray<string>;
  repoRoot?: string;
  storageRoot?: string;
  stdoutIsTty?: boolean;
  now?: number;
};

export type RunChronicleCommandResult = {
  report?: ChronicleReport;
  exitCode: number;
  error?: string;
};

/**
 * One-shot CLI entrypoint. Mirrors `runCleanupCommand` / `runDoctorCommand`:
 * parse → run → format → write. Returns an exit code rather than throwing
 * so the distribution dispatcher can surface a typed ErrorResolution.
 */
export const runChronicleCommand = async (
  input: RunChronicleCommandInput,
): Promise<RunChronicleCommandResult> => {
  const parsed = parseChronicleArgs(input.args);
  if (!parsed.ok) {
    // Wave 6c PR8 review (lock-in 19) — when the caller requested
    // `--format=json` (or is running non-TTY which implies machine-readable
    // per lock-in 12), surface the parse error through the canonical
    // `{ok:false, kind:"error", error:{...}}` envelope instead of the plain
    // line. The plain-text path is preserved for interactive TTY callers.
    if (argvRequestsJson(input.args, input.stdoutIsTty)) {
      const envelope = buildJsonErrorEnvelope({ code: "user_input", message: parsed.error });
      stdoutWrite(`${JSON.stringify(envelope)}\n`);
    } else {
      stdoutWrite(`chronicle: ${parsed.error}\n`);
    }
    return { exitCode: 2, error: parsed.error };
  }
  const storageRoot = storageRootFor(input.repoRoot, input.storageRoot);
  const report = await runChronicle({
    args: parsed.args,
    storageRoot,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const format = resolveFormat(parsed.args, { isTty: input.stdoutIsTty ?? false });
  const body = formatChronicleReport(report, format);
  stdoutWrite(body.length > 0 ? `${body}\n` : "");
  return { report, exitCode: 0 };
};

/**
 * In-shell `/chronicle` handler. Defaults to `--since 24h --session <current>`
 * per the Wave 6c PR8 spec so the common case ("what just happened in my
 * turn?") does not require flags.
 */
export const chronicleCommandSpec: HostCommandSpec = {
  name: "chronicle",
  group: "system",
  description:
    "Query the append-only event log across sessions (filters: --since, --tool, --approval, --session).",
  handler: async ({ args, deps }) => {
    const parsed = parseChronicleArgs(args);
    if (!parsed.ok) {
      deps.transcript.push({
        kind: "assistant",
        text: `chronicle: ${parsed.error}`,
        tone: "error",
      });
      return;
    }
    const effective: ChronicleArgs = { ...parsed.args };
    if (effective.sessionId === undefined && deps.appState.activeSessionId !== undefined) {
      effective.sessionId = deps.appState.activeSessionId;
    }
    if (effective.sinceMs === undefined) {
      effective.sinceMs = DEFAULT_INSHELL_SINCE_MS;
    }
    const storageRoot = storageRootFor(repoRootFor(undefined), undefined);
    const report = await runChronicle({ args: effective, storageRoot });
    const format: ChronicleFormat = effective.format ?? "text";
    if (format === "json") {
      for (const envelope of report.envelopes) {
        deps.transcript.push({
          kind: "event",
          label: "chronicle",
          detail: JSON.stringify(envelope),
        });
      }
      return;
    }
    const header = `chronicle — ${report.matched} match(es), showing ${report.envelopes.length}`;
    deps.transcript.push({ kind: "event", label: "chronicle", detail: header });
    for (const envelope of report.envelopes) {
      deps.transcript.push({
        kind: "event",
        label: "chronicle",
        detail: formatChronicleRow(envelope),
      });
    }
  },
};
