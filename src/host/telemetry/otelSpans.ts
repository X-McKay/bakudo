/**
 * Phase 6 Wave 6c PR7 / A6.1 — local-only OpenTelemetry span instrumentation.
 *
 * Plan 06 lines 854-871. Bakudo records spans for local consumption at
 * `~/.local/share/bakudo/log/spans-{iso}.json`. Export over OTLP is opt-in
 * via `OTEL_EXPORTER_OTLP_ENDPOINT` — bakudo never phones home by default.
 *
 * Span shape (plan lines 862-867):
 *
 *   1. Per-turn  — root span  : bakudo.session.id, bakudo.turn.id,
 *                               bakudo.agent_profile
 *   2. Per-attempt — child    : bakudo.attempt.id, bakudo.task_kind,
 *                               bakudo.sandbox_task_id, bakudo.exit_code
 *   3. Hook executions as span EVENTS (not child spans — keeps the trace
 *      flat and readable, matching Copilot v1.0.12).
 *   4. Custom attributes: bakudo.time_to_first_event_ms,
 *      bakudo.dropped_event_batches, bakudo.policy_decision_count.
 *
 * The on-disk JSON payload mirrors the OTLP-JSON encoding so downstream
 * observers can consume the files with an off-the-shelf OTLP-JSON parser.
 * This is a minimal local writer — the `@opentelemetry/*` SDK packages are
 * NOT dependencies of bakudo so we avoid the shim. When a real SDK lands in
 * a later phase this module adapts via the same surface.
 *
 * Rotation: keep 10 most recent `spans-{iso}.json` files (plan §A6.1 L1).
 */

import { readdir, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { bakudoLogDir } from "./xdgPaths.js";

/** Default retention count for span files. */
export const SPAN_FILES_KEEP = 10 as const;

const SPAN_FILE_PREFIX = "spans-";
const SPAN_FILE_SUFFIX = ".json";

const safeIsoForFilename = (iso: string): string => iso.replace(/[:.]/gu, "-");

/**
 * Attribute-value types allowed on a span. Keeps the surface narrow —
 * matches the OTLP-JSON `anyValue` subset we actually emit.
 */
export type SpanAttrValue = string | number | boolean;

/**
 * One structured event on a span. Plan §A6.1 L3 — hooks become events, not
 * child spans.
 */
export type SpanEvent = {
  name: string;
  timestampMs: number;
  attributes?: Readonly<Record<string, SpanAttrValue>>;
};

/**
 * The in-memory shape of a finished span. Matches the subset of OTLP the
 * local writer serialises; enough to be an OTLP-JSON-compatible record once
 * wrapped in the resource/scope envelope at flush time.
 */
export type FinishedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, SpanAttrValue>;
  events: SpanEvent[];
  status: "ok" | "error";
};

/**
 * An in-flight span. Callers hold this and call `end` when the operation
 * completes. Events accumulate on the span; attributes may be set at any
 * time before `end`.
 */
export type SpanHandle = {
  readonly traceId: string;
  readonly spanId: string;
  setAttr: (key: string, value: SpanAttrValue) => void;
  addEvent: (event: SpanEvent) => void;
  end: (status?: "ok" | "error") => FinishedSpan;
};

const newId = (length: number): string => {
  // Hex-ish identifier using `Math.random` — deterministic enough for local
  // correlation. Cryptographic randomness is not required for trace ids.
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * 16)] ?? "0";
  }
  return out;
};

/** Start a brand-new root span. */
export const startSpan = (input: {
  name: string;
  traceId?: string;
  parentSpanId?: string;
  attributes?: Readonly<Record<string, SpanAttrValue>>;
  clock?: () => number;
}): SpanHandle => {
  const clock = input.clock ?? Date.now;
  const traceId = input.traceId ?? newId(32);
  const spanId = newId(16);
  const startTimeMs = clock();
  const attributes: Record<string, SpanAttrValue> = { ...(input.attributes ?? {}) };
  const events: SpanEvent[] = [];
  let ended = false;
  let endTimeMs = startTimeMs;
  let status: "ok" | "error" = "ok";
  const handle: SpanHandle = {
    traceId,
    spanId,
    setAttr: (key, value) => {
      if (ended) return;
      attributes[key] = value;
    },
    addEvent: (event) => {
      if (ended) return;
      events.push(event);
    },
    end: (finalStatus) => {
      if (!ended) {
        ended = true;
        endTimeMs = clock();
        if (finalStatus !== undefined) status = finalStatus;
      }
      return {
        traceId,
        spanId,
        ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
        name: input.name,
        startTimeMs,
        endTimeMs,
        attributes,
        events,
        status,
      };
    },
  };
  return handle;
};

/**
 * OTLP-JSON resourceSpans envelope. Minimal but shape-stable so a future
 * real OTLP exporter can pick this file up as-is.
 */
export type OtlpJsonPayload = {
  resourceSpans: [
    {
      resource: { attributes: ReadonlyArray<{ key: string; value: { stringValue: string } }> };
      scopeSpans: [
        {
          scope: { name: string; version?: string };
          spans: ReadonlyArray<OtlpSpan>;
        },
      ];
    },
  ];
};

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: ReadonlyArray<{ key: string; value: OtlpAttrValue }>;
  events: ReadonlyArray<{
    timeUnixNano: string;
    name: string;
    attributes: ReadonlyArray<{ key: string; value: OtlpAttrValue }>;
  }>;
  status: { code: 1 | 2 };
};

type OtlpAttrValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

const toOtlpAttrValue = (v: SpanAttrValue): OtlpAttrValue => {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (Number.isInteger(v)) return { intValue: String(v) };
  return { doubleValue: v };
};

const toOtlpAttrs = (
  obj: Readonly<Record<string, SpanAttrValue>>,
): ReadonlyArray<{ key: string; value: OtlpAttrValue }> =>
  Object.entries(obj).map(([key, value]) => ({ key, value: toOtlpAttrValue(value) }));

const msToUnixNano = (ms: number): string => `${Math.floor(ms)}000000`;

/** Convert a finished span to its OTLP-JSON wire shape. */
export const toOtlpSpan = (span: FinishedSpan): OtlpSpan => ({
  traceId: span.traceId,
  spanId: span.spanId,
  ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
  name: span.name,
  startTimeUnixNano: msToUnixNano(span.startTimeMs),
  endTimeUnixNano: msToUnixNano(span.endTimeMs),
  attributes: toOtlpAttrs(span.attributes),
  events: span.events.map((event) => ({
    timeUnixNano: msToUnixNano(event.timestampMs),
    name: event.name,
    attributes: event.attributes === undefined ? [] : toOtlpAttrs(event.attributes),
  })),
  status: { code: span.status === "ok" ? 1 : 2 },
});

/** Build the full OTLP-JSON envelope for a batch of finished spans. */
export const buildOtlpPayload = (
  spans: ReadonlyArray<FinishedSpan>,
  serviceName = "bakudo",
  sdkVersion?: string,
): OtlpJsonPayload => ({
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
      },
      scopeSpans: [
        {
          scope: {
            name: "bakudo",
            ...(sdkVersion !== undefined ? { version: sdkVersion } : {}),
          },
          spans: spans.map(toOtlpSpan),
        },
      ],
    },
  ],
});

/** Rotate the span files in `logDir`, keeping at most `keep`. */
export const rotateSpanFiles = async (
  logDir: string,
  keep: number = SPAN_FILES_KEEP,
): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return [];
  }
  const matching = entries.filter(
    (name) => name.startsWith(SPAN_FILE_PREFIX) && name.endsWith(SPAN_FILE_SUFFIX),
  );
  if (matching.length <= keep) return [];
  const stats = await Promise.all(
    matching.map(async (name) => {
      const full = join(logDir, name);
      try {
        const s = await stat(full);
        return { path: full, mtimeMs: s.mtimeMs };
      } catch {
        return { path: full, mtimeMs: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = stats.slice(keep).map((entry) => entry.path);
  for (const path of toRemove) {
    try {
      await unlink(path);
    } catch {
      // Tolerate races.
    }
  }
  return toRemove;
};

/** Count the `spans-*.json` files currently on disk. Used by `bakudo doctor`. */
export const countSpanFilesOnDisk = async (logDir?: string): Promise<number> => {
  const dir = logDir ?? bakudoLogDir();
  try {
    const entries = await readdir(dir);
    return entries.filter(
      (name) => name.startsWith(SPAN_FILE_PREFIX) && name.endsWith(SPAN_FILE_SUFFIX),
    ).length;
  } catch {
    return 0;
  }
};

/**
 * Describe the OTLP endpoint for `bakudo doctor`. Plan line 870:
 *
 *   "OTLP endpoint configured (yes/no with host, never bearer token)"
 *
 * We parse the URL and return `{configured, host}` — the host segment
 * surfaces in doctor output so operators can confirm their export target
 * at a glance. Bearer tokens live in `OTEL_EXPORTER_OTLP_HEADERS` and are
 * NEVER included in the doctor envelope.
 */
export const describeOtlpEndpoint = (
  env: Readonly<Record<string, string | undefined>>,
): { configured: boolean; host?: string } => {
  const raw = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (raw === undefined || raw.trim().length === 0) {
    return { configured: false };
  }
  try {
    const url = new URL(raw);
    return { configured: true, host: url.host };
  } catch {
    // Malformed URL — still "configured" from the user's perspective, but
    // we can't surface a host safely. Return a sanitised marker.
    return { configured: true, host: "<invalid-url>" };
  }
};

/**
 * A simple recorder that finishes spans and buffers them for a later flush.
 * Flush writes one JSON file per batch and rotates older files. Separated
 * from `startSpan` so callers that do not care about persistence (tests,
 * future in-memory probes) can skip the writer.
 */
export class SpanRecorder {
  private readonly spans: FinishedSpan[] = [];
  private droppedBatches = 0;

  public record(span: FinishedSpan): void {
    this.spans.push(span);
  }

  public size(): number {
    return this.spans.length;
  }

  public dropped(): number {
    return this.droppedBatches;
  }

  public incDrop(): void {
    this.droppedBatches += 1;
  }

  /**
   * Flush the buffered spans to `logDir` as `spans-{iso}.json`. Rotates the
   * directory on successful write. Returns the path on success, or `null`
   * when there were no spans to flush.
   */
  public async flush(input?: {
    logDir?: string;
    keep?: number;
    nowIso?: () => string;
  }): Promise<string | null> {
    if (this.spans.length === 0) return null;
    const dir = input?.logDir ?? bakudoLogDir();
    const keep = input?.keep ?? SPAN_FILES_KEEP;
    const isoFn = input?.nowIso ?? ((): string => new Date().toISOString());
    try {
      await mkdir(dir, { recursive: true });
      const path = join(
        dir,
        `${SPAN_FILE_PREFIX}${safeIsoForFilename(isoFn())}${SPAN_FILE_SUFFIX}`,
      );
      const payload = buildOtlpPayload(this.spans);
      await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");
      this.spans.length = 0;
      await rotateSpanFiles(dir, keep);
      return path;
    } catch {
      this.droppedBatches += 1;
      // Keep the spans in the buffer so a later flush can retry. The
      // dropped-batch counter fires exactly once per failed write.
      return null;
    }
  }
}
