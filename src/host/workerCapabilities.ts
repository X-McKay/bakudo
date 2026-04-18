/**
 * Phase 6 Workstream 3 — Host/Worker Version Negotiation.
 *
 * Probes a worker (currently the `abox` binary) for its declared
 * {@link WorkerCapabilities}, caches the result per-runtime so we pay the
 * sub-second probe at most once per `bakudo` invocation, and exposes a pure
 * `negotiateAttemptAgainstCapabilities` helper the dispatcher calls before
 * sending the spec to the worker.
 *
 * Hard rule (plan 06 §W3 line 267): mismatch errors must happen *before*
 * dispatch, not halfway through execution. This module raises
 * {@link WorkerProtocolMismatchError} (exit code 4) at the negotiation seam
 * inside {@link ABoxTaskRunner.runAttempt}.
 *
 * Fallback (plan 820–828, amended 2026-04-18 — see
 * `plans/bakudo-ux/phase-6-w3-capability-probe-finding.md`): if the probe
 * exits non-zero or its stdout fails to parse as the
 * {@link WorkerCapabilities} JSON shape, the host falls back to its own
 * declared capability set. This reflects the invariant that bakudo ships
 * both host and worker-in-rootfs today — what the host can compile, the
 * shipped worker can accept. Successful probes returning a restrictive
 * shape still take precedence, so mismatches remain detectable whenever
 * they are observable.
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

import type { AttemptSpec } from "../attemptProtocol.js";
import {
  BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION,
  createSessionEvent,
  hostDefaultFallbackCapabilities,
  type SessionEventEnvelope,
  type WorkerCapabilities,
} from "../protocol.js";
import { WorkerProtocolMismatchError } from "./errors.js";

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Narrow `execFile` signature shared with `doctorAboxProbe`. Mirrors that
 * file's pattern so unit tests can hand in a stub without matching the full
 * `promisify(execFile)` overload surface.
 */
export type CapabilitiesExecFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding?: BufferEncoding },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsync: CapabilitiesExecFn = promisify(execFile) as unknown as CapabilitiesExecFn;

/** Default probe timeout. Short enough that a missing flag fails fast. */
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

export type ProbeOutcome = {
  capabilities: WorkerCapabilities;
  /**
   * Free-form diagnostic message. Populated when the probe fell back to the
   * host-default capability set. Currently carried into
   * {@link WorkerProtocolMismatchError.details} so post-mortem surfaces
   * (`inspect`, JSON envelope) keep the reason. Session-event emission
   * (`worker.capability_probe_failed` via `host.event_skipped`) is deferred
   * to Wave 6c observability — see `plans/bakudo-ux/phase-6-w3-capability-probe-finding.md`.
   */
  fallbackReason?: string;
  /** Raw stdout for debugging when parse fails (`source === "fallback_host_default"`). */
  rawOutput?: string;
};

export type ProbeWorkerCapabilitiesInput = {
  bin: string;
  execFn?: CapabilitiesExecFn;
  timeoutMs?: number;
};

/**
 * Validate that a parsed JSON value matches the {@link WorkerCapabilities}
 * shape. Returns the typed value on success or `null` so callers can drop
 * into the fallback path with one branch.
 */
const validateCapabilitiesJson = (value: unknown): WorkerCapabilities | null => {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const versions = obj.protocolVersions;
  const kinds = obj.taskKinds;
  const engines = obj.executionEngines;
  if (!Array.isArray(versions) || !versions.every((v) => typeof v === "number")) {
    return null;
  }
  if (!Array.isArray(kinds) || !kinds.every((v) => typeof v === "string")) {
    return null;
  }
  if (!Array.isArray(engines) || !engines.every((v) => typeof v === "string")) {
    return null;
  }
  return {
    protocolVersions: versions as number[],
    taskKinds: kinds as string[],
    executionEngines: engines as string[],
    source: "probe",
  };
};

/**
 * Run the worker capability probe (`<bin> --capabilities`) and parse its
 * stdout. On any failure (nonzero exit, timeout, parse error) returns the
 * host-default fallback per the amended A6 contract.
 */
export const probeWorkerCapabilities = async (
  input: ProbeWorkerCapabilitiesInput,
): Promise<ProbeOutcome> => {
  const execFn = input.execFn ?? execFileAsync;
  const timeout = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  try {
    const { stdout } = await execFn(input.bin, ["--capabilities"], {
      timeout,
      windowsHide: true,
      encoding: "utf8",
    });
    const text = String(stdout).trim();
    if (text.length === 0) {
      return {
        capabilities: hostDefaultFallbackCapabilities(),
        fallbackReason: "worker --capabilities produced empty stdout",
        rawOutput: "",
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        capabilities: hostDefaultFallbackCapabilities(),
        fallbackReason: `worker --capabilities stdout is not JSON: ${message}`,
        rawOutput: text,
      };
    }
    const validated = validateCapabilitiesJson(parsed);
    if (validated === null) {
      return {
        capabilities: hostDefaultFallbackCapabilities(),
        fallbackReason:
          "worker --capabilities JSON is missing protocolVersions/taskKinds/executionEngines",
        rawOutput: text,
      };
    }
    return { capabilities: validated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      capabilities: hostDefaultFallbackCapabilities(),
      fallbackReason: `worker --capabilities probe failed: ${message}`,
    };
  }
};

// ---------------------------------------------------------------------------
// Per-runtime cache
// ---------------------------------------------------------------------------

/**
 * Cache slot: one entry per `bin` (the abox binary path) for the lifetime of
 * the host process. The cache stores the in-flight promise so concurrent
 * dispatchers share one probe.
 */
const probeCache = new Map<string, Promise<ProbeOutcome>>();

/** Probe (or return the cached probe outcome for) `bin`. */
export const getCachedWorkerCapabilities = (
  input: ProbeWorkerCapabilitiesInput,
): Promise<ProbeOutcome> => {
  const key = input.bin;
  const existing = probeCache.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const pending = probeWorkerCapabilities(input).catch((error: unknown) => {
    // The probe itself catches errors and returns the fallback, so this
    // branch should be unreachable. We still drop the cache entry on a
    // surprise rejection so a transient host-side bug doesn't poison the
    // session — better to re-probe than to be wedged.
    probeCache.delete(key);
    throw error;
  });
  probeCache.set(key, pending);
  return pending;
};

/** Test helper — clear the per-runtime cache. */
export const __resetWorkerCapabilitiesCacheForTests = (): void => {
  probeCache.clear();
};

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

export type NegotiationContext = {
  /** AttemptSpec the host is about to dispatch. */
  spec: AttemptSpec;
  /** Worker capabilities returned by the probe (or the host-default fallback). */
  capabilities: WorkerCapabilities;
  /**
   * Fallback diagnostic, if the capabilities came from the v1-fallback
   * path. Surfaced in the {@link WorkerProtocolMismatchError} details so
   * `inspect` and `--output-format=json` consumers can read it.
   */
  fallbackReason?: string;
};

const intersect = <T>(a: readonly T[], b: readonly T[]): T[] => {
  const set = new Set(b);
  return a.filter((item) => set.has(item));
};

/**
 * Build a stable suggested-resolution string for a mismatch. Surfaced in the
 * error's `recoveryHint` field — the `inspect` and `--output-format=json`
 * surfaces both render it verbatim.
 */
const suggestResolution = (capabilities: WorkerCapabilities): string => {
  if (capabilities.source === "fallback_host_default") {
    return "Worker did not advertise capabilities via `--capabilities`; host fell back to its declared set. If dispatch still rejects the spec, the shipped worker has drifted from the host — rebuild the rootfs (`just rebuild-rootfs`) or align bakudo versions.";
  }
  return "Upgrade abox or downgrade bakudo so the protocol versions overlap.";
};

/**
 * Negotiate an {@link AttemptSpec} against the worker's capabilities. Returns
 * normally when the worker can handle the spec; throws
 * {@link WorkerProtocolMismatchError} otherwise.
 *
 * The error's `details` carries the host- and worker-side surfaces so the
 * JSON envelope (`--output-format=json`) and `inspect` can render the
 * mismatch without re-deriving anything.
 */
export const negotiateAttemptAgainstCapabilities = (ctx: NegotiationContext): void => {
  const { spec, capabilities, fallbackReason } = ctx;

  const overlap = intersect(
    [BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION as number],
    capabilities.protocolVersions,
  );
  if (overlap.length === 0) {
    throw new WorkerProtocolMismatchError(
      `Host requires protocol v${BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION} but worker advertises [${capabilities.protocolVersions.join(", ")}].`,
      {
        recoveryHint: suggestResolution(capabilities),
        details: {
          mismatchKind: "protocol_version",
          hostProtocolVersion: BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION,
          workerProtocolVersions: capabilities.protocolVersions,
          workerCapabilitiesSource: capabilities.source,
          ...(fallbackReason === undefined ? {} : { fallbackReason }),
        },
      },
    );
  }

  if (!capabilities.taskKinds.includes(spec.taskKind)) {
    throw new WorkerProtocolMismatchError(
      `Worker does not support task kind \`${spec.taskKind}\`. Worker advertises: [${capabilities.taskKinds.join(", ")}].`,
      {
        recoveryHint: suggestResolution(capabilities),
        details: {
          mismatchKind: "task_kind",
          attemptId: spec.attemptId,
          taskKind: spec.taskKind,
          workerTaskKinds: capabilities.taskKinds,
          workerCapabilitiesSource: capabilities.source,
          ...(fallbackReason === undefined ? {} : { fallbackReason }),
        },
      },
    );
  }

  const engine = spec.execution.engine;
  if (!capabilities.executionEngines.includes(engine)) {
    throw new WorkerProtocolMismatchError(
      `Worker does not support execution engine \`${engine}\`. Worker advertises: [${capabilities.executionEngines.join(", ")}].`,
      {
        recoveryHint: suggestResolution(capabilities),
        details: {
          mismatchKind: "execution_engine",
          attemptId: spec.attemptId,
          engine,
          workerExecutionEngines: capabilities.executionEngines,
          workerCapabilitiesSource: capabilities.source,
          ...(fallbackReason === undefined ? {} : { fallbackReason }),
        },
      },
    );
  }
};

// ---------------------------------------------------------------------------
// Wave 6c PR9 — probe-failure diagnostic (carryover #6)
// ---------------------------------------------------------------------------

/**
 * Payload discriminator for the deferred `worker.capability_probe_failed`
 * diagnostic. Rides on the existing `host.event_skipped` envelope kind per
 * lock-in 6 (no new envelope kinds; diagnostics go via the discriminator
 * pattern W2 + W3 established). The W3 PR carried the `fallbackReason` on
 * {@link ProbeOutcome}; this helper produces the session-event that observers
 * (`inspect`, chronicle, JSON mode) read to learn that the probe fell back.
 */
export const PROBE_FAILED_SKIPPED_KIND = "worker.capability_probe_failed" as const;

export type ProbeFailedEnvelopeInput = {
  sessionId: string;
  turnId?: string;
  attemptId?: string;
  bin: string;
  outcome: ProbeOutcome;
  /** Override timestamp — tests pin this for deterministic goldens. */
  timestamp?: string;
};

/**
 * Build the `host.event_skipped` envelope that reports a probe-failure
 * fallback. Returns `null` when the outcome is from a successful probe —
 * callers treat `null` as "nothing to emit" so dedupe becomes trivial.
 *
 * The payload carries:
 *   skippedKind:    stable discriminator string (see {@link PROBE_FAILED_SKIPPED_KIND})
 *   reason:         free-form fallbackReason from the outcome
 *   bin:            worker bin path that failed the probe (operator-visible)
 *   fallbackSource: capabilities.source on the outcome (always
 *                   `"fallback_host_default"` when the diagnostic fires)
 */
export const buildProbeFailedSkippedEnvelope = (
  input: ProbeFailedEnvelopeInput,
): SessionEventEnvelope | null => {
  if (input.outcome.capabilities.source !== "fallback_host_default") {
    return null;
  }
  const reason = input.outcome.fallbackReason;
  if (reason === undefined || reason.length === 0) {
    return null;
  }
  const payload: Record<string, unknown> = {
    skippedKind: PROBE_FAILED_SKIPPED_KIND,
    reason,
    bin: input.bin,
    fallbackSource: input.outcome.capabilities.source,
  };
  if (input.outcome.rawOutput !== undefined) {
    payload.rawOutput = input.outcome.rawOutput;
  }
  return createSessionEvent({
    kind: "host.event_skipped",
    sessionId: input.sessionId,
    actor: "host",
    payload,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  });
};

/**
 * Narrow callback shape for the writer used by
 * {@link createSessionProbeFailureEmitter}. Mirrors `emitSessionEvent` from
 * `./eventLogWriter.js` without importing it — the indirection keeps the
 * protocol layer import-free of session-store plumbing.
 */
export type ProbeFailureSessionEventWriter = (
  storageRoot: string,
  sessionId: string,
  envelope: SessionEventEnvelope,
) => Promise<void>;

/**
 * Build the runner's `probeFailureEmitter` callback. The factory wraps
 * {@link buildProbeFailedSkippedEnvelope} and a caller-supplied writer, so
 * production construction sites don't repeat the envelope-shape wiring.
 *
 * Fire-and-forget — a failing writer MUST NOT break dispatch.
 */
export const createSessionProbeFailureEmitter = (args: {
  storageRoot: string;
  emitSessionEvent: ProbeFailureSessionEventWriter;
}): ((input: { outcome: ProbeOutcome; bin: string; spec: AttemptSpec }) => void) => {
  const { storageRoot, emitSessionEvent: writeEvent } = args;
  return ({ outcome, bin, spec }) => {
    const envelope = buildProbeFailedSkippedEnvelope({
      sessionId: spec.sessionId,
      ...(spec.turnId !== undefined ? { turnId: spec.turnId } : {}),
      ...(spec.attemptId !== undefined ? { attemptId: spec.attemptId } : {}),
      bin,
      outcome,
    });
    if (envelope === null) {
      return;
    }
    void writeEvent(storageRoot, spec.sessionId, envelope).catch(() => {
      /* swallow — diagnostic emission MUST NOT break dispatch */
    });
  };
};
