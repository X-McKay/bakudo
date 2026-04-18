/**
 * Phase 6 Wave 6c PR8 — pure helpers for `bakudo chronicle` / `/chronicle`.
 *
 * Plan reference: `plans/bakudo-ux/06-rollout-reliability-and-operability.md`
 * lines 782–791. The command queries the Phase 2 append-only session-event
 * store (`<sessionDir>/events.ndjson`) across sessions and supports:
 *
 *   bakudo chronicle --since 7d
 *   bakudo chronicle --tool shell
 *   bakudo chronicle --approval denied
 *   bakudo chronicle --session <id>
 *
 * Filters are ANDed together. Split from `chronicle.ts` so the driver stays
 * under the 400-line cap and so every parse/filter path is pure-testable.
 *
 * Lock-ins honoured:
 *   - Lock-in 6: readers only; no new envelope kinds.
 *   - Lock-in 9: the driver delegates all I/O to `src/host/timeline.ts`.
 *   - Lock-in 12: `--format json` is TTY-independent; this module emits
 *     strings only.
 *   - Lock-in 27: the slash command stays visible across every `--ui` mode
 *     because it is an operator tool, not a UX-specific surface.
 */

import { parseDurationMs } from "../retentionPolicy.js";
import type { SessionEventEnvelope } from "../../protocol.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export type ChronicleFormat = "text" | "json";

export type ChronicleArgs = {
  /** Restrict to envelopes with `timestamp >= now - sinceMs`. */
  sinceMs?: number;
  /** Restrict to envelopes whose payload references the named tool. */
  tool?: string;
  /**
   * Restrict to `host.approval_*` envelopes whose `decision` matches this
   * value. "denied" matches both `denied` and `auto_denied`; "approved"
   * matches both `approved` and `auto_approved`.
   */
  approval?: "approved" | "denied";
  /** Restrict to a single session id. */
  sessionId?: string;
  /** Output format override (defaults decided by the caller). */
  format?: ChronicleFormat;
  /** Cap on emitted rows; defaults to 200 in the driver when unset. */
  limit?: number;
};

export type ParseChronicleArgsResult =
  | { ok: true; args: ChronicleArgs }
  | { ok: false; error: string };

const FORMAT_VALUES: readonly ChronicleFormat[] = ["text", "json"];

const APPROVAL_VALUES = ["approved", "denied"] as const;

/**
 * Parse `chronicle` argv into {@link ChronicleArgs}. Returns a structured
 * error rather than throwing so the host shell can surface a single
 * ErrorResolution without unwinding the dispatch loop.
 */
export const parseChronicleArgs = (argv: ReadonlyArray<string>): ParseChronicleArgsResult => {
  const args: ChronicleArgs = {};
  const readValue = (arg: string, next: string | undefined, name: string): string | null => {
    if (arg.includes("=")) {
      return arg.slice(name.length + 1);
    }
    return next ?? null;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
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
    if (arg === "--tool" || arg.startsWith("--tool=")) {
      const value = readValue(arg, argv[i + 1], "--tool");
      if (value === null) return { ok: false, error: "--tool requires a value" };
      args.tool = value;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--approval" || arg.startsWith("--approval=")) {
      const value = readValue(arg, argv[i + 1], "--approval");
      if (value === null) return { ok: false, error: "--approval requires a value" };
      if (!(APPROVAL_VALUES as readonly string[]).includes(value)) {
        return {
          ok: false,
          error: `invalid --approval value: ${value} (expected approved|denied)`,
        };
      }
      args.approval = value as "approved" | "denied";
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--session" || arg.startsWith("--session=")) {
      const value = readValue(arg, argv[i + 1], "--session");
      if (value === null) return { ok: false, error: "--session requires a session id" };
      args.sessionId = value;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = readValue(arg, argv[i + 1], "--format");
      if (value === null) return { ok: false, error: "--format requires a value" };
      if (!(FORMAT_VALUES as readonly string[]).includes(value)) {
        return { ok: false, error: `invalid --format value: ${value} (expected text|json)` };
      }
      args.format = value as ChronicleFormat;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = readValue(arg, argv[i + 1], "--limit");
      if (value === null) return { ok: false, error: "--limit requires a positive integer" };
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `invalid --limit: ${value}` };
      }
      args.limit = n;
      if (!arg.includes("=")) i += 1;
      continue;
    }
    return { ok: false, error: `unknown chronicle flag: ${arg}` };
  }
  return { ok: true, args };
};

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Recursively walk a JSON-shaped payload and return `true` when any string
 * leaf equals `tool` (case-insensitive). Used as a tolerant match so the
 * `--tool` filter catches both approval events (`payload.request.tool`) and
 * any future producer that embeds the tool name elsewhere.
 */
const payloadReferencesTool = (payload: unknown, tool: string): boolean => {
  const needle = tool.toLowerCase();
  const visit = (node: unknown): boolean => {
    if (typeof node === "string") return node.toLowerCase() === needle;
    if (Array.isArray(node)) return node.some(visit);
    if (node !== null && typeof node === "object") {
      return Object.values(node as Record<string, unknown>).some(visit);
    }
    return false;
  };
  return visit(payload);
};

const envelopeHasApprovalDecision = (
  envelope: SessionEventEnvelope,
  wanted: "approved" | "denied",
): boolean => {
  // Only `host.approval_resolved` carries a decision verdict; `*_requested`
  // envelopes carry no decision yet and therefore never match an
  // approval-decision filter.
  if (envelope.kind !== "host.approval_resolved") return false;
  const decision = (envelope.payload as { decision?: unknown }).decision;
  if (typeof decision !== "string") return false;
  if (wanted === "denied") return decision === "denied" || decision === "auto_denied";
  return decision === "approved" || decision === "auto_approved";
};

export type FilterChronicleInput = {
  envelopes: ReadonlyArray<SessionEventEnvelope>;
  args: ChronicleArgs;
  /** `Date.now()` override for deterministic tests. */
  now?: number;
};

/**
 * Apply every filter in {@link ChronicleArgs} to a flat envelope stream.
 * Filters are ANDed. The result preserves original append order (NDJSON
 * write order is already chronological; callers that want
 * newest-first should reverse after.).
 */
export const filterChronicle = ({
  envelopes,
  args,
  now = Date.now(),
}: FilterChronicleInput): SessionEventEnvelope[] => {
  const cutoff = args.sinceMs !== undefined ? new Date(now - args.sinceMs).toISOString() : null;
  const out: SessionEventEnvelope[] = [];
  for (const envelope of envelopes) {
    if (args.sessionId !== undefined && envelope.sessionId !== args.sessionId) continue;
    if (cutoff !== null && envelope.timestamp < cutoff) continue;
    if (args.approval !== undefined && !envelopeHasApprovalDecision(envelope, args.approval)) {
      continue;
    }
    if (args.tool !== undefined && !payloadReferencesTool(envelope.payload, args.tool)) continue;
    out.push(envelope);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

/**
 * Compact single-line text rendering of an envelope suitable for the TTY
 * chronicle view. The driver prepends a header + trailing summary; this
 * helper covers the per-row body so row formatting stays in one place.
 */
export const formatChronicleRow = (envelope: SessionEventEnvelope): string => {
  const parts: string[] = [envelope.timestamp, envelope.kind, envelope.actor];
  parts.push(`session=${envelope.sessionId}`);
  if (envelope.turnId !== undefined) parts.push(`turn=${envelope.turnId}`);
  if (envelope.attemptId !== undefined) parts.push(`attempt=${envelope.attemptId}`);
  const detail = chronicleDetailFor(envelope);
  if (detail !== "") parts.push(truncate(detail, 160));
  return parts.join(" | ");
};

const chronicleDetailFor = (envelope: SessionEventEnvelope): string => {
  const payload = envelope.payload as Record<string, unknown>;
  switch (envelope.kind) {
    case "host.approval_requested": {
      const req = payload.request as { tool?: string; displayCommand?: string } | undefined;
      if (req === undefined) return "";
      return `tool=${req.tool ?? "?"} cmd=${req.displayCommand ?? ""}`;
    }
    case "host.approval_resolved": {
      const decision = payload.decision;
      return typeof decision === "string" ? `decision=${decision}` : "";
    }
    case "user.turn_submitted": {
      const prompt = payload.prompt;
      return typeof prompt === "string" ? `prompt=${truncate(prompt, 80)}` : "";
    }
    case "host.dispatch_started": {
      const goal = payload.goal;
      return typeof goal === "string" ? `goal=${truncate(goal, 80)}` : "";
    }
    default:
      return "";
  }
};

/**
 * Build the text-mode output lines. Header first, then one line per row,
 * then a trailing summary. Callers join with `\n`.
 */
export const formatChronicleText = (
  envelopes: ReadonlyArray<SessionEventEnvelope>,
  args: ChronicleArgs,
): string[] => {
  const lines: string[] = [];
  const filters: string[] = [];
  if (args.sessionId !== undefined) filters.push(`session=${args.sessionId}`);
  if (args.sinceMs !== undefined) filters.push(`since=${args.sinceMs}ms`);
  if (args.tool !== undefined) filters.push(`tool=${args.tool}`);
  if (args.approval !== undefined) filters.push(`approval=${args.approval}`);
  if (args.limit !== undefined) filters.push(`limit=${args.limit}`);
  const suffix = filters.length === 0 ? "" : ` [${filters.join(" ")}]`;
  lines.push(`bakudo chronicle — ${envelopes.length} event(s)${suffix}`);
  for (const envelope of envelopes) lines.push(`  ${formatChronicleRow(envelope)}`);
  return lines;
};
