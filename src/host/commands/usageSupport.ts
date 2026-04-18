/**
 * Phase 6 Wave 6c PR8 — pure helpers for `bakudo usage` / `/usage`.
 *
 * A6.8 "usage reporter": per-session token and attempt totals rolled up
 * from the Phase 2 append-only event log and the v2 session record. No
 * new envelope kinds are introduced (lock-in 6); the reader is tolerant of
 * payloads that do or do not carry token accounting.
 *
 * Token sources consulted (in precedence order, first non-zero wins):
 *   1. `SessionEventEnvelope.payload.tokens` — an object with optional
 *      `{ prompt, completion, total }` numeric fields. Bakudo's worker
 *      does not emit this today; honoured when a future worker does.
 *   2. `SessionEventEnvelope.payload.usage` — same shape as OpenAI-style
 *      usage blocks.
 *   3. `SessionAttemptRecord.metadata.tokens` / `.usage` — workers that
 *      record tokens on the attempt rather than in a live event.
 *
 * When no source is populated, totals are zero; the table still surfaces
 * session / turn / attempt counts so operators can see activity without
 * a token accounting backend.
 */

import { parseDurationMs } from "../retentionPolicy.js";
import type { SessionEventEnvelope } from "../../protocol.js";
import type { SessionAttemptRecord, SessionRecord } from "../../sessionTypes.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export type UsageFormat = "text" | "json";

export type UsageArgs = {
  /** Restrict the report to a single session id. */
  sessionId?: string;
  /** Only count data whose timestamp is >= now - sinceMs. */
  sinceMs?: number;
  /** Output format override; caller picks the default (TTY → text). */
  format?: UsageFormat;
};

export type ParseUsageArgsResult = { ok: true; args: UsageArgs } | { ok: false; error: string };

const FORMAT_VALUES: readonly UsageFormat[] = ["text", "json"];

/**
 * Parse `usage` argv into {@link UsageArgs}. Same shape as
 * {@link parseChronicleArgs}: structured-error return for clean shell
 * dispatch, supports both `--foo value` and `--foo=value` forms.
 */
export const parseUsageArgs = (argv: ReadonlyArray<string>): ParseUsageArgsResult => {
  const args: UsageArgs = {};
  const readValue = (arg: string, next: string | undefined, name: string): string | null => {
    if (arg.includes("=")) return arg.slice(name.length + 1);
    return next ?? null;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--session" || arg.startsWith("--session=")) {
      const value = readValue(arg, argv[i + 1], "--session");
      if (value === null) return { ok: false, error: "--session requires a session id" };
      args.sessionId = value;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const value = readValue(arg, argv[i + 1], "--since");
      if (value === null) return { ok: false, error: "--since requires a duration" };
      const ms = parseDurationMs(value);
      if (ms === null) {
        return { ok: false, error: `invalid duration: ${value} (try 7d, 24h, 30m, 15s)` };
      }
      args.sinceMs = ms;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = readValue(arg, argv[i + 1], "--format");
      if (value === null) return { ok: false, error: "--format requires a value" };
      if (!(FORMAT_VALUES as readonly string[]).includes(value)) {
        return { ok: false, error: `invalid --format value: ${value} (expected text|json)` };
      }
      args.format = value as UsageFormat;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    return { ok: false, error: `unknown usage flag: ${arg}` };
  }
  return { ok: true, args };
};

// ---------------------------------------------------------------------------
// Token extraction (tolerant)
// ---------------------------------------------------------------------------

export type TokenTotals = {
  prompt: number;
  completion: number;
  total: number;
};

const emptyTokens = (): TokenTotals => ({ prompt: 0, completion: 0, total: 0 });

const coerceNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return 0;
};

/**
 * Extract a {@link TokenTotals} from any object that structurally matches
 * an OpenAI-style usage block or bakudo's own `tokens` field. Missing keys
 * default to zero. Falls back to zero on malformed input.
 */
export const extractTokenTotals = (source: unknown): TokenTotals => {
  if (source === null || typeof source !== "object") return emptyTokens();
  const rec = source as Record<string, unknown>;
  const prompt = coerceNumber(rec.prompt ?? rec.promptTokens ?? rec.prompt_tokens);
  const completion = coerceNumber(rec.completion ?? rec.completionTokens ?? rec.completion_tokens);
  const explicitTotal = coerceNumber(rec.total ?? rec.totalTokens ?? rec.total_tokens);
  const total = explicitTotal > 0 ? explicitTotal : prompt + completion;
  return { prompt, completion, total };
};

const addTotals = (a: TokenTotals, b: TokenTotals): TokenTotals => ({
  prompt: a.prompt + b.prompt,
  completion: a.completion + b.completion,
  total: a.total + b.total,
});

/**
 * Pull token totals out of a single envelope's payload. Looks at
 * `payload.tokens` first, then `payload.usage`.
 */
export const tokensFromEnvelope = (envelope: SessionEventEnvelope): TokenTotals => {
  const payload = envelope.payload as Record<string, unknown>;
  const fromTokens = extractTokenTotals(payload.tokens);
  if (fromTokens.total > 0) return fromTokens;
  return extractTokenTotals(payload.usage);
};

const tokensFromAttempt = (attempt: SessionAttemptRecord): TokenTotals => {
  const meta = attempt.metadata;
  if (meta === undefined) return emptyTokens();
  const record = meta as Record<string, unknown>;
  const fromTokens = extractTokenTotals(record.tokens);
  if (fromTokens.total > 0) return fromTokens;
  return extractTokenTotals(record.usage);
};

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

export type UsageSessionRow = {
  sessionId: string;
  title: string;
  status: string;
  turns: number;
  attempts: number;
  tokens: TokenTotals;
  agentProfiles: string[];
  updatedAt: string;
};

export type UsageReport = {
  args: UsageArgs;
  sessions: UsageSessionRow[];
  totals: TokenTotals;
};

const agentProfileFor = (attempt: SessionAttemptRecord): string | undefined => {
  const meta = attempt.metadata;
  if (meta === undefined) return undefined;
  const value = (meta as Record<string, unknown>).agentProfile;
  return typeof value === "string" ? value : undefined;
};

export type BuildUsageRowInput = {
  session: SessionRecord;
  envelopes: ReadonlyArray<SessionEventEnvelope>;
  cutoffIso?: string | null;
};

/**
 * Roll up totals for a single session. Accepts the session record (for
 * structural counts) and the envelope stream (for live token accounting).
 * `cutoffIso` is the result of `new Date(now - sinceMs).toISOString()`;
 * when non-null, envelopes and attempts strictly older than the cutoff are
 * dropped from the token totals (counts always reflect the full record).
 */
export const buildUsageSessionRow = (input: BuildUsageRowInput): UsageSessionRow => {
  const { session, envelopes, cutoffIso } = input;
  const attempts = session.turns.flatMap((t) => t.attempts);
  const profiles = Array.from(
    new Set(
      attempts
        .map(agentProfileFor)
        .filter((value): value is string => value !== undefined && value.length > 0),
    ),
  );
  let tokens: TokenTotals = emptyTokens();
  for (const envelope of envelopes) {
    if (envelope.sessionId !== session.sessionId) continue;
    if (cutoffIso !== null && cutoffIso !== undefined && envelope.timestamp < cutoffIso) continue;
    tokens = addTotals(tokens, tokensFromEnvelope(envelope));
  }
  if (tokens.total === 0) {
    // Fall back to attempt metadata so sessions without live events still
    // surface meaningful numbers.
    for (const attempt of attempts) {
      tokens = addTotals(tokens, tokensFromAttempt(attempt));
    }
  }
  return {
    sessionId: session.sessionId,
    title: session.title,
    status: session.status,
    turns: session.turns.length,
    attempts: attempts.length,
    tokens,
    agentProfiles: profiles,
    updatedAt: session.updatedAt,
  };
};

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

const padRight = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

const padLeft = (value: string, width: number): string =>
  value.length >= width ? value : " ".repeat(width - value.length) + value;

/**
 * Human-readable rendering of a {@link UsageReport}. Returns one line per
 * array entry so the slash-command path can push each as a transcript
 * event without a manual `\n` split.
 */
export const formatUsageReport = (report: UsageReport): string[] => {
  const lines: string[] = [];
  const filters: string[] = [];
  if (report.args.sessionId !== undefined) filters.push(`session=${report.args.sessionId}`);
  if (report.args.sinceMs !== undefined) filters.push(`since=${report.args.sinceMs}ms`);
  lines.push(
    `bakudo usage — ${report.sessions.length} session(s)${filters.length === 0 ? "" : ` [${filters.join(" ")}]`}`,
  );
  if (report.sessions.length === 0) {
    lines.push("  (no sessions match the filters)");
    return lines;
  }
  const idWidth = Math.max(10, ...report.sessions.map((s) => s.sessionId.length));
  const titleWidth = Math.max(5, ...report.sessions.map((s) => Math.min(40, s.title.length)));
  lines.push(
    `  ${padRight("session", idWidth)} ${padRight("title", titleWidth)} ${padLeft("turns", 5)} ${padLeft("attempts", 8)} ${padLeft("prompt", 10)} ${padLeft("completion", 12)} ${padLeft("total", 10)}`,
  );
  for (const row of report.sessions) {
    const title =
      row.title.length > titleWidth ? `${row.title.slice(0, titleWidth - 1)}…` : row.title;
    lines.push(
      `  ${padRight(row.sessionId, idWidth)} ${padRight(title, titleWidth)} ${padLeft(String(row.turns), 5)} ${padLeft(String(row.attempts), 8)} ${padLeft(String(row.tokens.prompt), 10)} ${padLeft(String(row.tokens.completion), 12)} ${padLeft(String(row.tokens.total), 10)}`,
    );
  }
  lines.push(
    `  totals: prompt=${report.totals.prompt} completion=${report.totals.completion} total=${report.totals.total}`,
  );
  return lines;
};

export const sumUsageTotals = (rows: ReadonlyArray<UsageSessionRow>): TokenTotals =>
  rows.reduce((acc, row) => addTotals(acc, row.tokens), emptyTokens());
