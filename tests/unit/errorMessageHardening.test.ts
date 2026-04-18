/**
 * Phase 6 Wave 6d PR13 — A6.10 Error-Message Hardening.
 *
 * One golden-string test per sharp edge called out in plan 06 line 951-961.
 * Per plan line 960: "Output: a regression test fixture per error class with
 * a golden message string." Where the golden text naturally includes a
 * stable prefix/suffix from the caller's own message, the test uses a
 * regex instead of an exact string — this is called out in each case.
 *
 * Lock-in 18/19 (phase-6-mid handoff) — these tests verify that `message`
 * and `recoveryHint` copy is tightened WITHOUT reshaping `code`, `exitCode`,
 * `otelSource`, or the JSON envelope. The last three fields are spot-checked
 * alongside each golden to keep the canary obvious.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactPersistenceError,
  EXIT_CODES,
  PolicyDeniedError,
  RecoveryRequiredError,
  SessionCorruptionError,
  WorkerProtocolMismatchError,
  buildJsonErrorEnvelope,
  jsonErrorEnvelopeFrom,
  renderErrorPlain,
} from "../../src/host/errors.js";
import {
  classifySessionFailure,
  renderPolicyDeniedCopy,
  renderProtocolMismatchCopy,
  renderSessionFailureCopy,
  tightenRenderedError,
} from "../../src/host/errorCopy.js";
import { explainConfigKey, runExplainConfig } from "../../src/host/explainConfig.js";
import { loadConfigCascade } from "../../src/host/config.js";

// ---------------------------------------------------------------------------
// Edge #1 — Permission / approval state transitions
// ---------------------------------------------------------------------------

test("A6.10 #1: PolicyDeniedError surfaces rule-id + scope + deny-precedence rationale", () => {
  const err = new PolicyDeniedError("blocked `git push`", {
    details: { ruleId: "net.deny.public", scope: "network", beatAllow: true },
  });
  const plain = renderErrorPlain(err.toRendered());
  // Golden (exact): the rendered line MUST contain the rule id, scope, and
  // the explicit "deny always wins" rationale. Exact match — this is the
  // public-facing surface for a policy-deny bug report.
  assert.equal(
    plain,
    "Error [policy_denied]: blocked `git push` [rule `net.deny.public`] (scope: network). deny always wins over allow/ask, even when a more specific allow matched first.\nHint: Adjust the approach to avoid the denied pattern, or update policy rules.",
  );
  // Canary: lock-in 18 — code + exitCode unchanged.
  assert.equal(err.code, "policy_denied");
  assert.equal(err.exitCode, EXIT_CODES.POLICY_DENIED);
});

test("A6.10 #1: PolicyDeniedError without beatAllow uses the terminal-precedence phrasing", () => {
  const err = new PolicyDeniedError("blocked pattern", {
    details: { ruleId: "fs.deny.etc", scope: "filesystem.write" },
  });
  const copy = renderPolicyDeniedCopy(err.toRendered());
  // Regex: message already carries the user's input prefix, which we don't
  // want to hard-code in the golden; we only pin the tightened suffix.
  assert.match(
    copy.message ?? "",
    /\[rule `fs\.deny\.etc`\] \(scope: filesystem\.write\)\. deny-rule precedence is terminal; no further evaluation runs\./u,
  );
});

test("A6.10 #1: canary — JSON envelope shape stays (ok:false, kind:error, nested)", () => {
  const err = new PolicyDeniedError("blocked", {
    details: { ruleId: "r1", scope: "shell", beatAllow: true },
  });
  const envelope = jsonErrorEnvelopeFrom(err.toRendered());
  assert.equal(envelope.ok, false);
  assert.equal(envelope.kind, "error");
  assert.equal(envelope.error.code, "policy_denied");
  // details are preserved verbatim (lock-in 18) — only `message` is tightened.
  assert.deepEqual(envelope.error.details, {
    ruleId: "r1",
    scope: "shell",
    beatAllow: true,
  });
});

// ---------------------------------------------------------------------------
// Edge #2 — Session save/load failures (disk-full vs corrupted vs migration)
// ---------------------------------------------------------------------------

test("A6.10 #2: ArtifactPersistenceError with ENOSPC → 'disk full' in rendered copy", () => {
  const cause = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  const err = new ArtifactPersistenceError("could not write artifact", {
    details: { cause },
  });
  const plain = renderErrorPlain(err.toRendered());
  // Regex: the em-dash clause is the load-bearing golden; the leading user
  // message + trailing hint include dynamic detail we do not want to pin.
  assert.match(plain, /^Error \[artifact_persistence\]: could not write artifact — disk full\n/u);
  assert.match(plain, /Hint: Free disk space/u);
});

test("A6.10 #2: SessionCorruptionError with SyntaxError cause → 'corrupted session data'", () => {
  const cause = new SyntaxError("Unexpected token }");
  const err = new SessionCorruptionError("session rejected by loader", {
    details: { cause },
  });
  const plain = renderErrorPlain(err.toRendered());
  assert.match(
    plain,
    /^Error \[session_corruption\]: session rejected by loader — corrupted session data\n/u,
  );
});

test("A6.10 #2: RecoveryRequiredError with migration flag → 'migration incomplete'", () => {
  const err = new RecoveryRequiredError("resume blocked", { details: { migration: true } });
  const plain = renderErrorPlain(err.toRendered());
  assert.match(plain, /^Error \[recovery_required\]: resume blocked — migration incomplete\n/u);
  assert.match(plain, /host\.migration_v1_to_v2/u);
});

test("A6.10 #2: classifySessionFailure dispatches on cause code + flavor hints", () => {
  assert.equal(
    classifySessionFailure({ cause: Object.assign(new Error("x"), { code: "ENOSPC" }) }),
    "disk_full",
  );
  assert.equal(
    classifySessionFailure({ cause: Object.assign(new Error("x"), { code: "EDQUOT" }) }),
    "disk_full",
  );
  assert.equal(classifySessionFailure({ cause: new SyntaxError("bad json") }), "corrupted");
  assert.equal(classifySessionFailure({ migration: true }), "migration");
  assert.equal(classifySessionFailure({ flavor: "lock_busy" }), "lock_busy");
  assert.equal(classifySessionFailure({}), "unknown");
  assert.equal(classifySessionFailure(undefined), "unknown");
});

test("A6.10 #2: renderSessionFailureCopy is a no-op when flavor is unknown (regression guard)", () => {
  const err = new SessionCorruptionError("generic failure");
  const { message } = renderSessionFailureCopy(err.toRendered());
  // No em-dash suffix — the unknown-flavor path MUST NOT tighten so existing
  // fixtures and the taxonomy tests that omit `cause` keep their prior copy.
  assert.equal(message, "generic failure");
});

// ---------------------------------------------------------------------------
// Edge #3 — Worker/host protocol mismatch (probe vs host-default fallback)
// ---------------------------------------------------------------------------

test("A6.10 #3: WorkerProtocolMismatchError from a probe success says 'source: probe'", () => {
  const err = new WorkerProtocolMismatchError(
    "Host requires protocol v3 but worker advertises [1, 2].",
    {
      details: {
        mismatchKind: "protocol_version",
        workerCapabilitiesSource: "probe",
      },
    },
  );
  const plain = renderErrorPlain(err.toRendered());
  // Golden substring — the `source: probe` phrase is the entire point of
  // this hardening. Regex because the leading user message is not pinned.
  assert.match(
    plain,
    /\[source: probe — the worker advertised this restrictive shape via `--capabilities`\]/u,
  );
});

test("A6.10 #3: WorkerProtocolMismatchError from host-default fallback says so + includes reason", () => {
  const err = new WorkerProtocolMismatchError("Worker does not support task kind `plan`.", {
    details: {
      mismatchKind: "task_kind",
      workerCapabilitiesSource: "fallback_host_default",
      fallbackReason: "probe timed out after 2s",
    },
  });
  const plain = renderErrorPlain(err.toRendered());
  // Regex: the probe-failure reason is dynamic; we pin the fallback-specific
  // phrasing + the reason-clause format.
  assert.match(
    plain,
    /\[source: host-default fallback — the `--capabilities` probe did not return a shape \(probe-failure reason: probe timed out after 2s\)\]/u,
  );
});

test("A6.10 #3: tightening is a no-op when the workerCapabilitiesSource detail is absent", () => {
  const err = new WorkerProtocolMismatchError("mismatch", { details: { mismatchKind: "x" } });
  const copy = renderProtocolMismatchCopy(err.toRendered());
  assert.equal(copy.message, "mismatch");
});

// ---------------------------------------------------------------------------
// Edge #4 — Configuration-inheritance disputes (`doctor --explain-config`)
// ---------------------------------------------------------------------------

test("A6.10 #4: explainConfigKey reports the highest-precedence layer for a repo-configured key", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "bakudo-explain-"));
  try {
    const repoRoot = tmp;
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    await writeFile(
      join(repoRoot, ".bakudo", "config.json"),
      JSON.stringify({ logLevel: "debug" }),
      "utf8",
    );
    const cascade = await loadConfigCascade(repoRoot, {});
    const report = explainConfigKey(cascade.layers, "logLevel");
    assert.equal(report.effectiveValue, "debug");
    // Origin layer must be the repo layer (highest-precedence real file here).
    assert.match(report.layerSource ?? "", /^repo \(/u);
    // The cascade always includes `defaults` at the bottom, so `checkedLayers`
    // starts at the winning layer but may not have traversed to defaults.
    assert.ok(report.checkedLayers.length >= 1);
    assert.equal(report.checkedLayers[0], report.layerSource);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("A6.10 #4: explainConfigKey falls back to defaults layer when no user override exists", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "bakudo-explain-"));
  try {
    // No repo .bakudo — only the compiled defaults are in play.
    const cascade = await loadConfigCascade(tmp, {});
    const report = explainConfigKey(cascade.layers, "logLevel");
    // Compiled default for `logLevel` is `"default"` (see config.ts).
    assert.equal(report.effectiveValue, "default");
    assert.equal(report.layerSource, "defaults");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("A6.10 #4: explainConfigKey returns null layer when the key is not in any layer", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "bakudo-explain-"));
  try {
    const cascade = await loadConfigCascade(tmp, {});
    const report = explainConfigKey(cascade.layers, "nonexistent.path");
    assert.equal(report.layerSource, null);
    assert.equal(report.effectiveValue, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("A6.10 #4: runExplainConfig writes a JSON report to stdout when useJson is true", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "bakudo-explain-"));
  try {
    const chunks: string[] = [];
    const proc = (
      globalThis as unknown as {
        process: { stdout: { write: (chunk: string) => boolean } };
      }
    ).process;
    const original = proc.stdout.write.bind(proc.stdout);
    proc.stdout.write = (chunk: string) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      const report = await runExplainConfig({ repoRoot: tmp, key: "logLevel", useJson: true });
      assert.equal(report.effectiveValue, "default");
    } finally {
      proc.stdout.write = original;
    }
    assert.equal(chunks.length, 1);
    const parsed = JSON.parse(chunks[0] as string) as { key: string };
    assert.equal(parsed.key, "logLevel");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Canary — lock-in 18/19 envelope shape unchanged
// ---------------------------------------------------------------------------

test("A6.10 canary: buildJsonErrorEnvelope shape (ok:false, kind:error, nested) untouched", () => {
  // Lock-in 19: a wave's worth of copy hardening must not reshape the
  // envelope. This is a direct repeat of the W9 taxonomy canary so that a
  // single red test in A6.10 turns on the envelope-shape regression lamp.
  const envelope = buildJsonErrorEnvelope({
    code: "worker_protocol_mismatch",
    message: "m",
    details: { k: 1 },
  });
  assert.deepEqual(envelope, {
    ok: false,
    kind: "error",
    error: { code: "worker_protocol_mismatch", message: "m", details: { k: 1 } },
  });
});

test("A6.10 canary: tightenRenderedError preserves class/code/exitCode/otelSource", () => {
  const err = new PolicyDeniedError("denied", {
    details: { ruleId: "r1", scope: "shell", beatAllow: true },
  });
  const rendered = err.toRendered();
  const tight = tightenRenderedError(rendered);
  assert.equal(tight.class, rendered.class);
  assert.equal(tight.code, rendered.code);
  assert.equal(tight.exitCode, rendered.exitCode);
  assert.equal(tight.otelSource, rendered.otelSource);
  assert.deepEqual(tight.details, rendered.details);
});
