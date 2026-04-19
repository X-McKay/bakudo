/**
 * Phase 6 Workstream 9 — Error Taxonomy and Exit Semantics.
 *
 * Single source of truth for bakudo's 9 user-visible error classes, stable
 * exit codes, and the JSON error envelope shape. Every caller surfacing an
 * error routes through this module so the hard rule holds:
 *   same error → stable exit code → stable JSON → stable plain-text.
 *
 * Exit-code policy (plan 529-537, 766-780): 0 success, 1 failure, 2 blocked,
 * 3 policy-denied, 4 protocol-mismatch, 5 session-corruption, 130 SIGINT.
 *
 * Extensibility hooks: {@link classifyError} is the multi-tier A6.3 entry;
 * {@link RenderedError} is the A6.4 component shape; {@link OtelSource} is
 * the A6.12 vocabulary. Sharp-edge copy is tightened in `errorCopy.ts` and
 * applied at the rendering seam (Wave 6d A6.10).
 */

import { tightenRenderedError } from "./errorCopy.js";

/**
 * Stable exit codes. Numeric constants are the single source of truth; the
 * 9 error classes below map each class to one of these values.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  BLOCKED: 2,
  POLICY_DENIED: 3,
  PROTOCOL_MISMATCH: 4,
  SESSION_CORRUPTION: 5,
  SIGINT: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Stable error-code strings used in the JSON envelope and in plain-text
 * rendering. Keys align with the exit-code table in the plan. Consumers of
 * `--output-format=json` match on these strings.
 */
export type BakudoErrorCode =
  | "user_input"
  | "policy_denied"
  | "approval_denied"
  | "approval_required"
  | "worker_protocol_mismatch"
  | "worker_execution"
  | "session_corruption"
  | "session_lock"
  | "artifact_persistence"
  | "recovery_required";

/**
 * OpenTelemetry source vocabulary (A6.12). Stable, Claude-Code-compatible
 * labels so external observers can correlate error decisions without
 * re-classifying. The first five align with Claude Code; the last five are
 * bakudo extensions covering territory Claude Code doesn't name.
 */
export type OtelSource =
  | "config"
  | "hook"
  | "user_temporary"
  | "user_permanent"
  | "user_reject"
  | "policy"
  | "protocol"
  | "system"
  | "external"
  | "unknown";

/**
 * The structured record every error renders to. A6.4 ("Error-As-Component
 * Rendering") consumes this in TUI mode; `--output-format=json` serializes
 * {@link JsonErrorEnvelope} which wraps the same fields.
 */
export type RenderedError = {
  /** Classifier tag. For a `BakudoError` this is the class name. */
  class: string;
  /** Stable exit-code-table key (see {@link BakudoErrorCode}). */
  code: BakudoErrorCode | string;
  /** Numeric exit code a process should return for this error. */
  exitCode: ExitCode;
  /** User-facing message. */
  message: string;
  /** Optional actionable hint rendered alongside the message. */
  recoveryHint?: string;
  /** OTel vocabulary slot (see {@link OtelSource}). */
  otelSource: OtelSource;
  /** Free-form structured details surfaced in the JSON envelope. */
  details?: Record<string, unknown>;
  /** Optional retry affordance for A6.4 RenderedError component. */
  retryAction?: { id: string; label: string };
};

/**
 * JSON error envelope emitted on the `--output-format=json` stream on a
 * terminal dispatch failure. Shape matches plan lines 547-562.
 *
 * `kind: "error"` is the single source of truth: every `{kind:"error"}` line
 * the host emits on the JSONL stream MUST be this shape, whether produced
 * by a typed `BakudoError` or by an untyped throw that the classifier
 * wrapped for rendering.
 */
export type JsonErrorEnvelope = {
  ok: false;
  kind: "error";
  error: {
    code: BakudoErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type JsonErrorEnvelopeInput = {
  code: BakudoErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
};

/**
 * Pure builder for {@link JsonErrorEnvelope}. Kept pure (no stdout, no
 * imports from jsonBackend) so tests and the one-shot dispatch path share
 * one shape with no import cycles.
 */
export const buildJsonErrorEnvelope = (input: JsonErrorEnvelopeInput): JsonErrorEnvelope => ({
  ok: false,
  kind: "error",
  error: {
    code: input.code,
    message: input.message,
    ...(input.details !== undefined ? { details: input.details } : {}),
  },
});

/**
 * Build the envelope from an already-classified {@link RenderedError}.
 * Phase 6 Wave 6d A6.10: message is tightened via {@link tightenRenderedError}
 * at the rendering seam; lock-in 19 envelope shape stays unchanged.
 */
export const jsonErrorEnvelopeFrom = (rendered: RenderedError): JsonErrorEnvelope => {
  const tight = tightenRenderedError(rendered);
  return buildJsonErrorEnvelope({
    code: tight.code,
    message: tight.message,
    ...(tight.details !== undefined ? { details: tight.details } : {}),
  });
};

// ---------------------------------------------------------------------------
// Base class + options
// ---------------------------------------------------------------------------

export type BakudoErrorOptions = {
  message?: string;
  details?: Record<string, unknown>;
  recoveryHint?: string;
  cause?: unknown;
};

/**
 * Base for every bakudo-tagged error. Subclasses pin `code`, `exitCode`,
 * `otelSource`, and a default `recoveryHint` so call sites can throw with
 * only a message (or even bare) and still produce a stable envelope.
 */
export abstract class BakudoError extends Error {
  abstract readonly code: BakudoErrorCode;
  abstract readonly exitCode: ExitCode;
  abstract readonly otelSource: OtelSource;
  readonly recoveryHint?: string;
  readonly details?: Record<string, unknown>;

  constructor(defaultMessage: string, options: BakudoErrorOptions = {}) {
    super(
      options.message ?? defaultMessage,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = this.constructor.name;
    if (options.recoveryHint !== undefined) {
      this.recoveryHint = options.recoveryHint;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  /** Convert this error to the {@link RenderedError} shape for rendering. */
  toRendered(): RenderedError {
    const rendered: RenderedError = {
      class: this.name,
      code: this.code,
      exitCode: this.exitCode,
      message: this.message,
      otelSource: this.otelSource,
    };
    const hint = this.recoveryHint ?? this.defaultRecoveryHint();
    if (hint !== undefined) {
      rendered.recoveryHint = hint;
    }
    if (this.details !== undefined) {
      rendered.details = this.details;
    }
    return rendered;
  }

  /** Subclass-provided default hint (used when `recoveryHint` not supplied). */
  protected defaultRecoveryHint(): string | undefined {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Required 9 error classes (plan lines 515-527)
// ---------------------------------------------------------------------------

/** Malformed CLI args or invalid interactive input. Exit 1. */
export class UserInputError extends BakudoError {
  readonly code = "user_input" as const;
  readonly exitCode = EXIT_CODES.FAILURE;
  readonly otelSource: OtelSource = "external";
  protected override defaultRecoveryHint(): string {
    return "Re-run with valid arguments. See `bakudo --help` or `bakudo <cmd> --help`.";
  }
}

/** Permission deny-rule matched. Exit 3. */
export class PolicyDeniedError extends BakudoError {
  readonly code = "policy_denied" as const;
  readonly exitCode = EXIT_CODES.POLICY_DENIED;
  readonly otelSource: OtelSource = "policy";
  protected override defaultRecoveryHint(): string {
    return "Adjust the approach to avoid the denied pattern, or update policy rules.";
  }
}

/** Approval was denied (by user, hook, or `--no-ask-user`). Exit 2. */
export class ApprovalDeniedError extends BakudoError {
  readonly code = "approval_denied" as const;
  readonly exitCode = EXIT_CODES.BLOCKED;
  readonly otelSource: OtelSource = "user_reject";
  protected override defaultRecoveryHint(): string {
    return "Re-run with a different approach or grant the requested approval.";
  }
}

/** Worker protocol version incompatible with host. Exit 4. */
export class WorkerProtocolMismatchError extends BakudoError {
  readonly code = "worker_protocol_mismatch" as const;
  readonly exitCode = EXIT_CODES.PROTOCOL_MISMATCH;
  readonly otelSource: OtelSource = "protocol";
  protected override defaultRecoveryHint(): string {
    return "Upgrade abox or downgrade bakudo so the protocol versions overlap.";
  }
}

/** Worker ran but produced a terminal failure. Exit 1. */
export class WorkerExecutionError extends BakudoError {
  readonly code = "worker_execution" as const;
  readonly exitCode = EXIT_CODES.FAILURE;
  readonly otelSource: OtelSource = "external";
  protected override defaultRecoveryHint(): string {
    return "Inspect worker logs, then decide whether to retry or narrow the task.";
  }
}

/** Session JSONL corrupted or schema-invalid. Exit 5. */
export class SessionCorruptionError extends BakudoError {
  readonly code = "session_corruption" as const;
  readonly exitCode = EXIT_CODES.SESSION_CORRUPTION;
  readonly otelSource: OtelSource = "system";
  protected override defaultRecoveryHint(): string {
    return "Restore from a backup or start a fresh session; see `bakudo doctor`.";
  }
}

/** Another process already holds the session lock. Exit 5. */
export class SessionLockError extends BakudoError {
  readonly code = "session_lock" as const;
  readonly exitCode = EXIT_CODES.SESSION_CORRUPTION;
  readonly otelSource: OtelSource = "system";
  protected override defaultRecoveryHint(): string {
    return "Close the other bakudo process using this session or remove a stale lock file.";
  }
}

/** Artifact could not be written (disk full, perms, quota). Exit 1. */
export class ArtifactPersistenceError extends BakudoError {
  readonly code = "artifact_persistence" as const;
  readonly exitCode = EXIT_CODES.FAILURE;
  readonly otelSource: OtelSource = "system";
  protected override defaultRecoveryHint(): string {
    return "Free disk space or fix permissions on the bakudo data directory.";
  }
}

/** Session cannot proceed without manual repair. Exit 5. */
export class RecoveryRequiredError extends BakudoError {
  readonly code = "recovery_required" as const;
  readonly exitCode = EXIT_CODES.SESSION_CORRUPTION;
  readonly otelSource: OtelSource = "system";
  protected override defaultRecoveryHint(): string {
    return "Run `bakudo doctor` for guidance, then resume once the underlying issue is fixed.";
  }
}

// ---------------------------------------------------------------------------
// Classifier (A6.3 multi-tier)
// ---------------------------------------------------------------------------

/** Extract an errno-ish code from a Node.js system error (Tier 2). */
const getErrnoCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Classify any thrown value into a {@link RenderedError}.
 *
 * Tier 1 — bakudo-tagged `BakudoError` subclass (the 9 from this module).
 * Tier 2 — Node.js / system errno codes (e.g. `ENOENT`, `EACCES`).
 * Tier 3 — `error.name` set by third-party libraries (survives minification).
 * Tier 4 — fallback (`Error`, otelSource `unknown`).
 *
 * Every rendered error carries a stable `exitCode` and `code`, so downstream
 * callers never have to re-inspect the original throw.
 */
export const classifyError = (error: unknown): RenderedError => {
  // Tier 1
  if (error instanceof BakudoError) {
    return error.toRendered();
  }
  // Tier 2
  const errno = getErrnoCode(error);
  if (errno !== undefined) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      class: `Error:${errno}`,
      code: "worker_execution",
      exitCode: EXIT_CODES.FAILURE,
      message,
      otelSource: "system",
    };
  }
  // Tier 3
  if (
    error instanceof Error &&
    typeof error.name === "string" &&
    error.name.length > 3 &&
    error.name !== "Error"
  ) {
    return {
      class: error.name.slice(0, 60),
      code: "worker_execution",
      exitCode: EXIT_CODES.FAILURE,
      message: error.message,
      otelSource: "external",
    };
  }
  // Tier 4
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return {
    class: "Error",
    code: "worker_execution",
    exitCode: EXIT_CODES.FAILURE,
    message,
    otelSource: "unknown",
  };
};

/** Numeric exit code for any thrown value (shorthand for `classifyError(e).exitCode`). */
export const exitCodeFor = (error: unknown): ExitCode => classifyError(error).exitCode;

/**
 * Plain-text single-block rendering for {@link RenderedError}. Used by the
 * plain-mode backend and by any non-JSON error surface (e.g. stderr on a
 * fatal throw). Deliberately ANSI-free — TTY backends layer color on top.
 *
 * Shape:
 *
 *   Error [<code>]: <message>
 *   Hint: <recoveryHint>
 */
export const renderErrorPlain = (rendered: RenderedError): string => {
  // Wave 6d A6.10: tighten at the rendering seam; taxonomy is untouched.
  const tight = tightenRenderedError(rendered);
  const head = `Error [${tight.code}]: ${tight.message}`;
  const hint = tight.recoveryHint;
  return hint === undefined ? head : `${head}\nHint: ${hint}`;
};
