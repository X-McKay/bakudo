/**
 * Phase 6 Wave 6d A6.10 — Error-Message Hardening.
 *
 * Extracted from `src/host/errors.ts` (kept under 400 LOC) so the rendered
 * message / hint copy can grow without pressuring the taxonomy module.
 *
 * Purpose: tighten the four sharp edges called out in
 * `plans/bakudo-ux/06-rollout-reliability-and-operability.md:951-961`:
 *
 *   1. Permission / approval state transitions — rule id + scope + precedence.
 *   2. Session save/load failures — disk-full vs corrupted vs migration.
 *   3. Worker/host protocol mismatch — probe-success vs host-default fallback.
 *   4. Configuration-inheritance disputes — `doctor --explain-config` wired in
 *      `src/host/commands/doctor.ts`, not here.
 *
 * Lock-in 18/19 (phase-6-mid handoff): the error taxonomy classes and
 * JSON envelope shape are STABLE. This module only enriches `message` and
 * `recoveryHint` strings — it never changes `code`, `exitCode`, or
 * `details` key names.
 */

import type { BakudoErrorCode, RenderedError } from "./errors.js";
// Types only — keeps this module free of runtime imports from errors.ts so
// the reverse dependency (errors.ts → errorCopy.ts) has no cycle.

/**
 * Source of a worker-capability surface, mirrored from
 * `src/protocol.ts:WorkerCapabilities.source`. Kept as a local literal so
 * this module does not re-import the worker-capabilities type just for a
 * string-lookup.
 */
type WorkerCapabilitiesSource = "probe" | "fallback_host_default";

/**
 * Tier-2-ish errno-code lookup on an arbitrary error cause. Stays permissive
 * — the caller has already decided this detail carries a `cause`; we just
 * extract `.code` if present.
 */
const extractCauseCode = (cause: unknown): string | undefined => {
  if (cause === null || typeof cause !== "object") return undefined;
  const candidate = (cause as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Build the precedence rationale fragment for a policy deny. `deny` always
 * wins over `allow` and `ask` in bakudo's permission evaluator (see
 * `plans/bakudo-ux/03-agent-abox-contract-and-permissions.md` — "deny
 * wins"). Surface that rule explicitly so the user understands why a more
 * specific allow did not take effect.
 */
const policyPrecedenceFragment = (details: Record<string, unknown> | undefined): string => {
  const beatAllow = details?.beatAllow === true;
  if (beatAllow) {
    return " deny always wins over allow/ask, even when a more specific allow matched first.";
  }
  return " deny-rule precedence is terminal; no further evaluation runs.";
};

/**
 * Build the scope clause when we have it. Scope examples: `"shell"`,
 * `"network"`, `"filesystem.write"`.
 */
const policyScopeClause = (details: Record<string, unknown> | undefined): string => {
  const scope = details?.scope;
  return typeof scope === "string" && scope.length > 0 ? ` (scope: ${scope})` : "";
};

/**
 * Build the rule-id clause. Example: ``[rule `net.deny.public`]``.
 */
const policyRuleClause = (details: Record<string, unknown> | undefined): string => {
  const ruleId = details?.ruleId;
  return typeof ruleId === "string" && ruleId.length > 0 ? ` [rule \`${ruleId}\`]` : "";
};

/**
 * Tighten a {@link PolicyDeniedError} rendering. Surfaces the rule id + scope
 * + "deny always wins" rationale so users understand *which* rule matched
 * and *why* it beat any allow in scope.
 *
 * Conservative: if neither `ruleId` nor `scope` is present on details, the
 * rendering passes through unchanged. This preserves the pre-hardening
 * copy for untyped throws or for errors built before W9's details shape
 * stabilised, so existing fixtures (and the taxonomy test suite) are not
 * disrupted.
 *
 * Mutates neither the input nor any shared state — returns a new partial
 * `{message, recoveryHint}` pair that the renderer layer merges back in.
 */
export const renderPolicyDeniedCopy = (
  rendered: RenderedError,
): Pick<RenderedError, "message" | "recoveryHint"> => {
  const details = rendered.details;
  const hasRule = typeof details?.ruleId === "string" && (details.ruleId as string).length > 0;
  const hasScope = typeof details?.scope === "string" && (details.scope as string).length > 0;
  const hasBeatAllow = details?.beatAllow === true;
  if (!hasRule && !hasScope && !hasBeatAllow) {
    return {
      message: rendered.message,
      ...(rendered.recoveryHint !== undefined ? { recoveryHint: rendered.recoveryHint } : {}),
    };
  }
  const rule = policyRuleClause(details);
  const scope = policyScopeClause(details);
  const precedence = policyPrecedenceFragment(details);
  const message = `${rendered.message}${rule}${scope}.${precedence}`;
  const hintBase =
    rendered.recoveryHint ??
    "Adjust the approach to avoid the denied pattern, or update policy rules.";
  return { message, recoveryHint: hintBase };
};

/**
 * Derive a session-failure sub-classification from a cause `.code`. Stable
 * buckets: `disk_full`, `corrupted`, `migration`, `lock_busy`, `unknown`.
 */
export type SessionFailureFlavor =
  | "disk_full"
  | "corrupted"
  | "migration"
  | "lock_busy"
  | "unknown";

export const classifySessionFailure = (
  details: Record<string, unknown> | undefined,
): SessionFailureFlavor => {
  const direct =
    typeof details?.flavor === "string" ? (details.flavor as SessionFailureFlavor) : undefined;
  if (
    direct === "disk_full" ||
    direct === "corrupted" ||
    direct === "migration" ||
    direct === "lock_busy"
  ) {
    return direct;
  }
  const cause = details?.cause;
  const code = extractCauseCode(cause);
  if (code === "ENOSPC" || code === "EDQUOT") return "disk_full";
  if (code === "EACCES" || code === "EPERM") return "corrupted";
  // Phase 6 A6.10 edge #2: distinguish the in-progress migration state. The
  // migration event id is stable (plan 06 line 816) — we accept it either
  // as `details.migration` (true) or as `details.cause.name === "host.migration_v1_to_v2"`.
  if (details?.migration === true) return "migration";
  if (
    cause !== null &&
    typeof cause === "object" &&
    typeof (cause as { name?: unknown }).name === "string" &&
    (cause as { name: string }).name === "host.migration_v1_to_v2"
  ) {
    return "migration";
  }
  // JSON parse failure surfaces as Error.name SyntaxError.
  if (
    cause !== null &&
    typeof cause === "object" &&
    (cause as { name?: unknown }).name === "SyntaxError"
  ) {
    return "corrupted";
  }
  return "unknown";
};

const SESSION_FLAVOR_PHRASE: Record<SessionFailureFlavor, string> = {
  disk_full: "disk full",
  corrupted: "corrupted session data",
  migration: "migration incomplete",
  lock_busy: "lock held by another process",
  unknown: "unrecoverable session state",
};

const SESSION_FLAVOR_HINT: Record<SessionFailureFlavor, string> = {
  disk_full:
    "Free disk space (or raise the quota) and retry; the session record is intact if the write never completed.",
  corrupted:
    "Back up `<sessionDir>/session.json` and `events.ndjson`, then run `bakudo doctor` to diagnose; recover from the most recent healthy turn.",
  migration:
    "Re-run the last command after the `host.migration_v1_to_v2` event completes; a partial migration left the session between the v1 and v2 layouts.",
  lock_busy:
    "Close the other bakudo process using this session, or remove the stale `.lock` file and re-run.",
  unknown: "Run `bakudo doctor` for guidance, then resume once the underlying issue is fixed.",
};

/**
 * Tighten the copy for the three session-centric classes — distinguishing
 * disk-full, corrupted, migration-in-progress, lock-busy paths via the
 * cause's errno / error name. See plan 06 line 958.
 *
 * Conservative: when no actionable flavor is detected, the message and
 * hint pass through unchanged so legacy call sites (and the W9 taxonomy
 * fixture tests that do not supply `details`) keep their pre-hardening
 * copy.
 */
export const renderSessionFailureCopy = (
  rendered: RenderedError,
): Pick<RenderedError, "message" | "recoveryHint"> => {
  const flavor = classifySessionFailure(rendered.details);
  if (flavor === "unknown") {
    return {
      message: rendered.message,
      ...(rendered.recoveryHint !== undefined ? { recoveryHint: rendered.recoveryHint } : {}),
    };
  }
  const phrase = SESSION_FLAVOR_PHRASE[flavor];
  const message = `${rendered.message} — ${phrase}`;
  // For a known flavor we override the generic subclass-default hint with
  // the flavor-specific guidance — this is the whole point of edge #2. If
  // the caller explicitly overrode the hint with a non-default string, we
  // can't tell from this seam (lock-in 18 keeps details shape frozen), so
  // we always prefer the flavor-specific guidance.
  const hint = SESSION_FLAVOR_HINT[flavor];
  return { message, recoveryHint: hint };
};

/**
 * Tighten the copy for {@link WorkerProtocolMismatchError}. The error class
 * is reused for two distinct situations (plan 06 §"Worker Capability Probe
 * Fallback", amended 2026-04-18):
 *
 *   - `source: "probe"` — the worker advertised a restrictive capability
 *     shape via `--capabilities`. Hard rule 267 path.
 *   - `source: "fallback_host_default"` — probe failed; host fell back to
 *     its own declared set, and dispatch then still rejected the spec
 *     (so the shipped worker has drifted from the host).
 *
 * The rendered message calls this out verbatim so operators stop conflating
 * the two cases — carryover #6's `worker.capability_probe_failed` emitter
 * will eventually carry the failure reason alongside, but the host-side
 * copy must already tell them apart today.
 */
export const renderProtocolMismatchCopy = (
  rendered: RenderedError,
): Pick<RenderedError, "message" | "recoveryHint"> => {
  const details = rendered.details;
  const source = details?.workerCapabilitiesSource as WorkerCapabilitiesSource | undefined;
  if (source === "fallback_host_default") {
    const reason = typeof details?.fallbackReason === "string" ? details.fallbackReason : undefined;
    const reasonClause = reason === undefined ? "" : ` (probe-failure reason: ${reason})`;
    return {
      message: `${rendered.message} [source: host-default fallback — the \`--capabilities\` probe did not return a shape${reasonClause}]`,
      recoveryHint:
        rendered.recoveryHint ??
        "Worker did not advertise capabilities via `--capabilities`; host fell back to its declared set. If dispatch still rejects the spec, the shipped worker has drifted from the host — rebuild the rootfs (`just rebuild-rootfs`) or align bakudo versions.",
    };
  }
  if (source === "probe") {
    return {
      message: `${rendered.message} [source: probe — the worker advertised this restrictive shape via \`--capabilities\`]`,
      recoveryHint:
        rendered.recoveryHint ??
        "Upgrade abox or downgrade bakudo so the protocol versions overlap.",
    };
  }
  return {
    message: rendered.message,
    ...(rendered.recoveryHint !== undefined ? { recoveryHint: rendered.recoveryHint } : {}),
  };
};

/**
 * Apply the sharp-edge copy tightening for a given error code. Pure: the
 * input is a classified {@link RenderedError}; the return value is a new
 * record with tightened `message` / `recoveryHint` (other fields preserved).
 *
 * Codes we do not tighten pass through unchanged so the renderer surface
 * stays uniform.
 */
export const tightenRenderedError = (rendered: RenderedError): RenderedError => {
  const code = rendered.code as BakudoErrorCode;
  switch (code) {
    case "policy_denied": {
      const { message, recoveryHint } = renderPolicyDeniedCopy(rendered);
      return { ...rendered, message, ...(recoveryHint !== undefined ? { recoveryHint } : {}) };
    }
    case "session_corruption":
    case "artifact_persistence":
    case "recovery_required": {
      const { message, recoveryHint } = renderSessionFailureCopy(rendered);
      return { ...rendered, message, ...(recoveryHint !== undefined ? { recoveryHint } : {}) };
    }
    case "worker_protocol_mismatch": {
      const { message, recoveryHint } = renderProtocolMismatchCopy(rendered);
      return { ...rendered, message, ...(recoveryHint !== undefined ? { recoveryHint } : {}) };
    }
    default:
      return rendered;
  }
};
