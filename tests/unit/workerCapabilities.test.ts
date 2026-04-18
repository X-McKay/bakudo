/**
 * Phase 6 W3 — Worker capability probe + negotiation unit tests.
 *
 * Covers:
 *  - Plan §W3 acceptance criteria 271–274 (incompatible combinations fail
 *    fast, with actionable error messages).
 *  - Plan §W3 hard rules 265–269 (mismatch before dispatch; message names
 *    host + worker versions and a suggested resolution).
 *  - Plan A6.6 fallback (820–828): probe failure ⇒ assume v1 baseline,
 *    surface diagnostic, only `explicit_command` proceeds.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { WorkerProtocolMismatchError } from "../../src/host/errors.js";
import {
  __resetWorkerCapabilitiesCacheForTests,
  getCachedWorkerCapabilities,
  negotiateAttemptAgainstCapabilities,
  probeWorkerCapabilities,
  type CapabilitiesExecFn,
} from "../../src/host/workerCapabilities.js";
import {
  BAKUDO_HOST_EXECUTION_ENGINES,
  BAKUDO_HOST_PROTOCOL_VERSIONS,
  BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION,
  BAKUDO_HOST_TASK_KINDS,
  hostDefaultFallbackCapabilities,
} from "../../src/protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "sess-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "do work",
  instructions: [],
  cwd: "/repo",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 30, maxOutputBytes: 1000, heartbeatIntervalMs: 1000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

const stubExec = (
  responder: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
): CapabilitiesExecFn => {
  return ((file: string, args: readonly string[]) => responder(file, args)) as CapabilitiesExecFn;
};

// ---------------------------------------------------------------------------
// probeWorkerCapabilities
// ---------------------------------------------------------------------------

test("probeWorkerCapabilities: parses a well-formed JSON capabilities reply", async () => {
  const execFn = stubExec(async (_file, args) => {
    assert.deepEqual(args, ["--capabilities"]);
    return {
      stdout: JSON.stringify({
        protocolVersions: [1, 3],
        taskKinds: ["assistant_job", "explicit_command", "verification_check"],
        executionEngines: ["agent_cli", "shell"],
      }),
      stderr: "",
    };
  });

  const outcome = await probeWorkerCapabilities({ bin: "abox", execFn });

  assert.equal(outcome.capabilities.source, "probe");
  assert.deepEqual(outcome.capabilities.protocolVersions, [1, 3]);
  assert.equal(outcome.fallbackReason, undefined);
});

test("probeWorkerCapabilities: nonzero exit → host-default fallback with diagnostic reason", async () => {
  const execFn = stubExec(async () => {
    const error = Object.assign(new Error("Command failed: abox --capabilities"), {
      code: 2,
    });
    throw error;
  });

  const outcome = await probeWorkerCapabilities({ bin: "abox", execFn });

  assert.equal(outcome.capabilities.source, "fallback_host_default");
  assert.deepEqual(outcome.capabilities.protocolVersions, [...BAKUDO_HOST_PROTOCOL_VERSIONS]);
  assert.deepEqual(outcome.capabilities.taskKinds, [...BAKUDO_HOST_TASK_KINDS]);
  assert.deepEqual(outcome.capabilities.executionEngines, [...BAKUDO_HOST_EXECUTION_ENGINES]);
  assert.match(outcome.fallbackReason ?? "", /probe failed/);
});

test("probeWorkerCapabilities: empty stdout → fallback with empty-output reason", async () => {
  const execFn = stubExec(async () => ({ stdout: "  \n", stderr: "" }));
  const outcome = await probeWorkerCapabilities({ bin: "abox", execFn });
  assert.equal(outcome.capabilities.source, "fallback_host_default");
  assert.match(outcome.fallbackReason ?? "", /empty stdout/);
});

test("probeWorkerCapabilities: non-JSON stdout → fallback with parse reason", async () => {
  const execFn = stubExec(async () => ({ stdout: "not json", stderr: "" }));
  const outcome = await probeWorkerCapabilities({ bin: "abox", execFn });
  assert.equal(outcome.capabilities.source, "fallback_host_default");
  assert.match(outcome.fallbackReason ?? "", /not JSON/);
  assert.equal(outcome.rawOutput, "not json");
});

test("probeWorkerCapabilities: JSON missing required arrays → fallback", async () => {
  const execFn = stubExec(async () => ({
    stdout: JSON.stringify({ protocolVersions: [1] }),
    stderr: "",
  }));
  const outcome = await probeWorkerCapabilities({ bin: "abox", execFn });
  assert.equal(outcome.capabilities.source, "fallback_host_default");
  assert.match(outcome.fallbackReason ?? "", /missing/);
});

test("probeWorkerCapabilities: array elements with wrong type → fallback", async () => {
  const execFn = stubExec(async () => ({
    stdout: JSON.stringify({
      protocolVersions: ["one", "two"],
      taskKinds: ["explicit_command"],
      executionEngines: ["shell"],
    }),
    stderr: "",
  }));
  const outcome = await probeWorkerCapabilities({ bin: "abox", execFn });
  assert.equal(outcome.capabilities.source, "fallback_host_default");
});

// ---------------------------------------------------------------------------
// getCachedWorkerCapabilities (per-runtime cache)
// ---------------------------------------------------------------------------

test("getCachedWorkerCapabilities: probes once per bin per runtime", async () => {
  __resetWorkerCapabilitiesCacheForTests();
  let calls = 0;
  const execFn = stubExec(async () => {
    calls += 1;
    return {
      stdout: JSON.stringify({
        protocolVersions: [3],
        taskKinds: ["assistant_job"],
        executionEngines: ["agent_cli"],
      }),
      stderr: "",
    };
  });

  const a = await getCachedWorkerCapabilities({ bin: "abox-bin-A", execFn });
  const b = await getCachedWorkerCapabilities({ bin: "abox-bin-A", execFn });
  const c = await getCachedWorkerCapabilities({ bin: "abox-bin-B", execFn });

  assert.equal(calls, 2, "one probe per distinct bin path");
  assert.equal(a.capabilities, b.capabilities, "same bin returns the same outcome instance");
  assert.notEqual(a.capabilities, c.capabilities);
});

// ---------------------------------------------------------------------------
// negotiateAttemptAgainstCapabilities — Hard Rules 265-269
// ---------------------------------------------------------------------------

test("negotiate: matching protocol + kind + engine → returns normally", () => {
  const spec = buildSpec();
  assert.doesNotThrow(() => {
    negotiateAttemptAgainstCapabilities({
      spec,
      capabilities: {
        protocolVersions: [BAKUDO_HOST_REQUIRED_PROTOCOL_VERSION],
        taskKinds: ["assistant_job"],
        executionEngines: ["agent_cli"],
        source: "probe",
      },
    });
  });
});

test("negotiate: protocol mismatch → WorkerProtocolMismatchError naming both sides", () => {
  const spec = buildSpec();
  assert.throws(
    () =>
      negotiateAttemptAgainstCapabilities({
        spec,
        capabilities: {
          protocolVersions: [1],
          taskKinds: ["assistant_job"],
          executionEngines: ["agent_cli"],
          source: "probe",
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof WorkerProtocolMismatchError);
      // Plan rule 268: message lists host version, worker version, and a
      // suggested resolution (carried via recoveryHint).
      assert.match(err.message, /v3/, "host required version visible");
      assert.match(err.message, /\[1\]/, "worker advertised versions visible");
      const rendered = err.toRendered();
      assert.equal(rendered.exitCode, 4, "exit code 4 (PROTOCOL_MISMATCH)");
      assert.match(rendered.recoveryHint ?? "", /[Uu]pgrade|[Dd]owngrade/);
      assert.equal(rendered.details?.mismatchKind, "protocol_version");
      return true;
    },
  );
});

test("negotiate: unsupported task kind → WorkerProtocolMismatchError (task_kind)", () => {
  // Worker speaks v3 (so protocol check passes) but only advertises
  // explicit_command — the host's `assistant_job` request must be rejected
  // via the task_kind branch.
  const spec = buildSpec({ taskKind: "assistant_job" });
  assert.throws(
    () =>
      negotiateAttemptAgainstCapabilities({
        spec,
        capabilities: {
          protocolVersions: [3],
          taskKinds: ["explicit_command"],
          executionEngines: ["shell", "agent_cli"],
          source: "probe",
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof WorkerProtocolMismatchError);
      assert.match(err.message, /assistant_job/);
      const rendered = err.toRendered();
      assert.equal(rendered.details?.mismatchKind, "task_kind");
      assert.equal(rendered.details?.workerCapabilitiesSource, "probe");
      return true;
    },
  );
});

test("negotiate: host-default fallback lets assistant_job dispatch proceed (2026-04-18 amendment)", () => {
  // Plan amendment (see phase-6-w3-capability-probe-finding.md): when the
  // probe fails, the host falls back to its own declared capability set.
  // Dispatch proceeds; the fallback diagnostic is still carried for
  // operator visibility if a *later* check surfaces an issue.
  const spec = buildSpec({ taskKind: "assistant_job" });
  assert.doesNotThrow(() =>
    negotiateAttemptAgainstCapabilities({
      spec,
      capabilities: hostDefaultFallbackCapabilities(),
      fallbackReason: "worker --capabilities probe failed: ENOENT",
    }),
  );
});

test("negotiate: host-default fallback still rejects specs with an unknown task kind", () => {
  // Guard against a future drift where the spec references a task kind the
  // host itself doesn't advertise — the fallback is permissive, not blind.
  // Cast: the spec type constrains taskKind to the compile-time union, but
  // the negotiator defends at runtime against drift.
  const spec = buildSpec({ taskKind: "not_a_real_kind" as AttemptSpec["taskKind"] });
  assert.throws(
    () =>
      negotiateAttemptAgainstCapabilities({
        spec,
        capabilities: hostDefaultFallbackCapabilities(),
        fallbackReason: "worker --capabilities probe failed: ENOENT",
      }),
    (err: unknown) => {
      assert.ok(err instanceof WorkerProtocolMismatchError);
      const rendered = err.toRendered();
      assert.equal(rendered.details?.workerCapabilitiesSource, "fallback_host_default");
      assert.equal(rendered.details?.fallbackReason, "worker --capabilities probe failed: ENOENT");
      assert.match(rendered.recoveryHint ?? "", /rebuild the rootfs/);
      return true;
    },
  );
});

test("negotiate: unsupported execution engine → WorkerProtocolMismatchError (execution_engine)", () => {
  const spec = buildSpec({
    taskKind: "explicit_command",
    execution: { engine: "agent_cli" },
  });
  assert.throws(
    () =>
      negotiateAttemptAgainstCapabilities({
        spec,
        capabilities: {
          protocolVersions: [3],
          taskKinds: ["explicit_command"],
          executionEngines: ["shell"], // missing "agent_cli"
          source: "probe",
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof WorkerProtocolMismatchError);
      const rendered = err.toRendered();
      assert.equal(rendered.details?.mismatchKind, "execution_engine");
      assert.match(err.message, /agent_cli/);
      return true;
    },
  );
});
