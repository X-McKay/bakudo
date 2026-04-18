/**
 * Phase 6 Workstream 9 — Error Taxonomy tests.
 *
 * Required assertions (plan `06-...md:563-567` + reference-informed
 * additions at 766-781):
 *
 *   1. Same error → same exit code (Hard Rule).
 *   2. Same error → same JSON shape (Hard Rule).
 *   3. Same error → same plain-text explanation with code + hint (Hard Rule).
 *   4. Every one of the 9 required classes resolves to the exit code
 *      dictated by the policy table.
 *   5. JSON envelope emitted by `JsonBackend.emitJsonError` matches the
 *      shape at plan lines 547-562 exactly.
 *   6. `--json` path surfaces the same exit code as the plain path for the
 *      same underlying error class.
 *   7. The multi-tier classifier (A6.3) handles Tier 1 (`BakudoError`
 *      subclass) today and leaves Tier 2/3/4 reachable.
 *   8. The OTel source vocabulary (A6.12) is attached to every rendered
 *      error and uses the Claude-Code-compatible labels.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalDeniedError,
  ArtifactPersistenceError,
  BakudoError,
  buildJsonErrorEnvelope,
  classifyError,
  exitCodeFor,
  EXIT_CODES,
  jsonErrorEnvelopeFrom,
  PolicyDeniedError,
  RecoveryRequiredError,
  renderErrorPlain,
  SessionCorruptionError,
  SessionLockError,
  UserInputError,
  WorkerExecutionError,
  WorkerProtocolMismatchError,
  type BakudoErrorCode,
  type JsonErrorEnvelope,
  type OtelSource,
  type RenderedError,
} from "../../src/host/errors.js";
import { JsonBackend } from "../../src/host/renderers/jsonBackend.js";
import { PlainBackend } from "../../src/host/renderers/plainBackend.js";
import type { RendererStdout } from "../../src/host/rendererBackend.js";

const captureStdout = (): RendererStdout & { chunks: string[]; tape: () => string } => {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY: false,
    tape: () => chunks.join(""),
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
};

type Ctor = new (defaultMessage: string) => BakudoError;

const CLASS_TABLE: {
  ctor: Ctor;
  name: string;
  code: BakudoErrorCode;
  exitCode: number;
  otelSource: OtelSource;
}[] = [
  {
    ctor: UserInputError as unknown as Ctor,
    name: "UserInputError",
    code: "user_input",
    exitCode: EXIT_CODES.FAILURE,
    otelSource: "external",
  },
  {
    ctor: PolicyDeniedError as unknown as Ctor,
    name: "PolicyDeniedError",
    code: "policy_denied",
    exitCode: EXIT_CODES.POLICY_DENIED,
    otelSource: "policy",
  },
  {
    ctor: ApprovalDeniedError as unknown as Ctor,
    name: "ApprovalDeniedError",
    code: "approval_denied",
    exitCode: EXIT_CODES.BLOCKED,
    otelSource: "user_reject",
  },
  {
    ctor: WorkerProtocolMismatchError as unknown as Ctor,
    name: "WorkerProtocolMismatchError",
    code: "worker_protocol_mismatch",
    exitCode: EXIT_CODES.PROTOCOL_MISMATCH,
    otelSource: "protocol",
  },
  {
    ctor: WorkerExecutionError as unknown as Ctor,
    name: "WorkerExecutionError",
    code: "worker_execution",
    exitCode: EXIT_CODES.FAILURE,
    otelSource: "external",
  },
  {
    ctor: SessionCorruptionError as unknown as Ctor,
    name: "SessionCorruptionError",
    code: "session_corruption",
    exitCode: EXIT_CODES.SESSION_CORRUPTION,
    otelSource: "system",
  },
  {
    ctor: SessionLockError as unknown as Ctor,
    name: "SessionLockError",
    code: "session_lock",
    exitCode: EXIT_CODES.SESSION_CORRUPTION,
    otelSource: "system",
  },
  {
    ctor: ArtifactPersistenceError as unknown as Ctor,
    name: "ArtifactPersistenceError",
    code: "artifact_persistence",
    exitCode: EXIT_CODES.FAILURE,
    otelSource: "system",
  },
  {
    ctor: RecoveryRequiredError as unknown as Ctor,
    name: "RecoveryRequiredError",
    code: "recovery_required",
    exitCode: EXIT_CODES.SESSION_CORRUPTION,
    otelSource: "system",
  },
];

// ---------------------------------------------------------------------------
// Exit-code policy (plan lines 529-537 + 766-780)
// ---------------------------------------------------------------------------

test("EXIT_CODES: the stable policy constants match the plan table", () => {
  assert.equal(EXIT_CODES.SUCCESS, 0);
  assert.equal(EXIT_CODES.FAILURE, 1);
  assert.equal(EXIT_CODES.BLOCKED, 2);
  assert.equal(EXIT_CODES.POLICY_DENIED, 3);
  assert.equal(EXIT_CODES.PROTOCOL_MISMATCH, 4);
  assert.equal(EXIT_CODES.SESSION_CORRUPTION, 5);
  assert.equal(EXIT_CODES.SIGINT, 130);
});

// ---------------------------------------------------------------------------
// Class → code / exitCode / otelSource / class name (1:1 acceptance)
// ---------------------------------------------------------------------------

for (const entry of CLASS_TABLE) {
  test(`${entry.name}: carries the expected code, exitCode, otelSource, and class tag`, () => {
    const err = new entry.ctor("a default message") as BakudoError;
    assert.ok(err instanceof BakudoError, "inherits from BakudoError");
    assert.equal(err.name, entry.name);
    assert.equal(err.code, entry.code);
    assert.equal(err.exitCode, entry.exitCode);
    assert.equal(err.otelSource, entry.otelSource);
    // Every class provides a default recoveryHint so plain rendering always
    // has something actionable.
    const rendered = err.toRendered();
    assert.equal(typeof rendered.recoveryHint, "string");
    assert.ok((rendered.recoveryHint ?? "").length > 0);
  });
}

test("BakudoError: options.message overrides the default message", () => {
  const err = new UserInputError("default", { message: "custom copy" });
  assert.equal(err.message, "custom copy");
});

test("BakudoError: options.recoveryHint overrides the subclass default", () => {
  const err = new UserInputError("default", { recoveryHint: "do this instead" });
  const rendered = err.toRendered();
  assert.equal(rendered.recoveryHint, "do this instead");
});

test("BakudoError: details are surfaced in the rendered record", () => {
  const details = { hostProtocol: 3, workerProtocols: [1, 2] };
  const err = new WorkerProtocolMismatchError("mismatch", { details });
  assert.deepEqual(err.toRendered().details, details);
});

// ---------------------------------------------------------------------------
// Multi-tier classifier (A6.3 hook)
// ---------------------------------------------------------------------------

test("classifyError Tier 1: returns the BakudoError's own rendered record", () => {
  const err = new PolicyDeniedError("rule `git push` matched");
  const rendered = classifyError(err);
  assert.equal(rendered.class, "PolicyDeniedError");
  assert.equal(rendered.code, "policy_denied");
  assert.equal(rendered.exitCode, EXIT_CODES.POLICY_DENIED);
  assert.equal(rendered.otelSource, "policy");
});

test("classifyError Tier 2: Node errno → class `Error:<errno>`, system otelSource", () => {
  const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  const rendered = classifyError(err);
  assert.equal(rendered.class, "Error:ENOENT");
  assert.equal(rendered.otelSource, "system");
  assert.equal(rendered.exitCode, EXIT_CODES.FAILURE);
});

test("classifyError Tier 3: third-party error.name survives bundling", () => {
  const err = new Error("boom from the library");
  err.name = "LibraryProtocolError";
  const rendered = classifyError(err);
  assert.equal(rendered.class, "LibraryProtocolError");
  assert.equal(rendered.otelSource, "external");
  assert.equal(rendered.exitCode, EXIT_CODES.FAILURE);
});

test("classifyError Tier 4: unknown throw falls back to `Error` / `unknown`", () => {
  const rendered = classifyError("bare string throw");
  assert.equal(rendered.class, "Error");
  assert.equal(rendered.otelSource, "unknown");
  assert.equal(rendered.exitCode, EXIT_CODES.FAILURE);
  assert.equal(rendered.message, "bare string throw");
});

test("exitCodeFor: shorthand for classifyError().exitCode across tiers", () => {
  assert.equal(exitCodeFor(new PolicyDeniedError("x")), EXIT_CODES.POLICY_DENIED);
  assert.equal(exitCodeFor(new SessionCorruptionError("x")), EXIT_CODES.SESSION_CORRUPTION);
  assert.equal(exitCodeFor(new WorkerProtocolMismatchError("x")), EXIT_CODES.PROTOCOL_MISMATCH);
  assert.equal(exitCodeFor(new Error("plain")), EXIT_CODES.FAILURE);
});

// ---------------------------------------------------------------------------
// JSON envelope shape (plan lines 547-562) — single source of truth
// ---------------------------------------------------------------------------

test("buildJsonErrorEnvelope: shape matches the plan (ok:false, kind:error, nested error)", () => {
  const envelope = buildJsonErrorEnvelope({
    code: "worker_protocol_mismatch",
    message: "Host protocol v3 is not supported by the worker.",
    details: { hostProtocol: 3, workerProtocols: [1, 2] },
  });
  assert.deepEqual(envelope, {
    ok: false,
    kind: "error",
    error: {
      code: "worker_protocol_mismatch",
      message: "Host protocol v3 is not supported by the worker.",
      details: { hostProtocol: 3, workerProtocols: [1, 2] },
    },
  });
});

test("buildJsonErrorEnvelope: omits `details` when the caller does not supply any", () => {
  const envelope = buildJsonErrorEnvelope({ code: "user_input", message: "x" });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.kind, "error");
  assert.equal(envelope.error.code, "user_input");
  assert.equal(envelope.error.details, undefined);
});

test("jsonErrorEnvelopeFrom: a RenderedError builds the same envelope as the raw builder", () => {
  const err = new PolicyDeniedError("rule `git push` matched", {
    details: { rule: "git push" },
  });
  const rendered = err.toRendered();
  const viaRendered = jsonErrorEnvelopeFrom(rendered);
  const viaRaw = buildJsonErrorEnvelope({
    code: rendered.code,
    message: rendered.message,
    ...(rendered.details !== undefined ? { details: rendered.details } : {}),
  });
  assert.deepEqual(viaRendered, viaRaw);
});

for (const entry of CLASS_TABLE) {
  test(`${entry.name}: JSON envelope carries the stable code`, () => {
    const err = new entry.ctor("m") as BakudoError;
    const envelope = jsonErrorEnvelopeFrom(err.toRendered());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.kind, "error");
    assert.equal(envelope.error.code, entry.code);
  });
}

// ---------------------------------------------------------------------------
// Plain-text rendering: Error [<code>]: <message>\nHint: <hint>
// ---------------------------------------------------------------------------

test("renderErrorPlain: includes code and hint when both are present", () => {
  const rendered: RenderedError = {
    class: "PolicyDeniedError",
    code: "policy_denied",
    exitCode: 3,
    message: "write to /etc/passwd rejected",
    otelSource: "policy",
    recoveryHint: "avoid the denied pattern",
  };
  const out = renderErrorPlain(rendered);
  assert.equal(
    out,
    "Error [policy_denied]: write to /etc/passwd rejected\nHint: avoid the denied pattern",
  );
});

test("renderErrorPlain: omits the hint block when recoveryHint is undefined", () => {
  const rendered: RenderedError = {
    class: "Error",
    code: "worker_execution",
    exitCode: 1,
    message: "boom",
    otelSource: "unknown",
  };
  assert.equal(renderErrorPlain(rendered), "Error [worker_execution]: boom");
});

test("PlainBackend.renderError: writes a single `Error [code]: ...\\nHint: ...` block with trailing newline", () => {
  const stdout = captureStdout();
  const backend = new PlainBackend(stdout);
  backend.renderError(
    new ApprovalDeniedError("user declined", {
      details: { tool: "shell_write" },
    }),
  );
  const tape = stdout.tape();
  assert.ok(tape.endsWith("\n"));
  assert.ok(tape.includes("Error [approval_denied]: user declined"));
  assert.ok(tape.includes("Hint: "));
});

test("PlainBackend.renderError: routes an untyped throw through the classifier", () => {
  const stdout = captureStdout();
  const backend = new PlainBackend(stdout);
  backend.renderError(new Error("plain error"));
  const tape = stdout.tape();
  // Tier 4 classifier maps to the generic worker_execution code.
  assert.ok(tape.includes("Error [worker_execution]: plain error"));
});

// ---------------------------------------------------------------------------
// --json path exits with the right code for the same underlying error
// ---------------------------------------------------------------------------

for (const entry of CLASS_TABLE) {
  test(`${entry.name}: --json path emits envelope + the --plain path returns the same exit code`, () => {
    const err = new entry.ctor("unified") as BakudoError;

    // JSON path: use JsonBackend to emit and parse the NDJSON line back.
    const jsonStdout = captureStdout();
    const backend = new JsonBackend(jsonStdout);
    backend.emitJsonError({ code: err.code, message: err.message });
    const line = jsonStdout.chunks[0]!;
    assert.ok(line.endsWith("\n"), "one NDJSON line with trailing newline");
    const parsed = JSON.parse(line.trimEnd()) as JsonErrorEnvelope;
    assert.equal(parsed.ok, false);
    assert.equal(parsed.kind, "error");
    assert.equal(parsed.error.code, entry.code);

    // Same error → same exit code on the plain path (via exitCodeFor).
    assert.equal(exitCodeFor(err), entry.exitCode);
    // And the plain renderer carries the matching `code` string.
    const plainStdout = captureStdout();
    const plainBackend = new PlainBackend(plainStdout);
    plainBackend.renderError(err);
    assert.ok(plainStdout.tape().includes(`[${entry.code}]`));
  });
}

// ---------------------------------------------------------------------------
// Hard Rule: class → (code, exitCode, JSON shape, plain-text) are 1:1 stable
// ---------------------------------------------------------------------------

test("Hard Rule: same class always produces the same exit code + JSON shape + plain-text line", () => {
  const first = new WorkerProtocolMismatchError("v3 vs [1,2]", {
    details: { hostProtocol: 3, workerProtocols: [1, 2] },
  });
  const second = new WorkerProtocolMismatchError("v3 vs [1,2]", {
    details: { hostProtocol: 3, workerProtocols: [1, 2] },
  });

  assert.equal(exitCodeFor(first), exitCodeFor(second));
  assert.deepEqual(
    jsonErrorEnvelopeFrom(first.toRendered()),
    jsonErrorEnvelopeFrom(second.toRendered()),
  );
  assert.equal(renderErrorPlain(first.toRendered()), renderErrorPlain(second.toRendered()));
});
