/**
 * Phase 6 W5 — `ABoxTaskRunner` env-filter integration tests.
 *
 * Plan 06 §W5 line 344 ("`bakudo/src/aboxTaskRunner.ts` — route the env
 * through `filterEnv`") + acceptance criterion 388. Under the default empty
 * allowlist, the worker spawn receives NO host env at all; with an explicit
 * allowlist, only the named vars pass through.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { ABoxAdapter } from "../../src/aboxAdapter.js";
import { ABoxTaskRunner } from "../../src/aboxTaskRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { DEFAULT_ENV_POLICY, resolveEnvPolicy, type EnvPolicy } from "../../src/host/envPolicy.js";
import type { ProbeOutcome } from "../../src/host/workerCapabilities.js";
import { hostDefaultFallbackCapabilities } from "../../src/protocol.js";

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

/** Helper: collect the env that was passed to `spawn` across one runAttempt. */
const runAndCaptureSpawnEnv = async (
  envPolicy: EnvPolicy,
  hostEnv: Record<string, string | undefined>,
): Promise<Record<string, string> | undefined> => {
  let capturedEnv: Record<string, string> | undefined;
  const spawnFn = ((_file: string, _args: readonly string[], options: { env?: unknown }) => {
    capturedEnv = options.env as Record<string, string> | undefined;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
      exitCode: number | null;
      signalCode: string | null;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => undefined;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as never;

  const adapter = new ABoxAdapter("/tmp/abox", undefined, undefined, spawnFn);
  const provider = async (): Promise<ProbeOutcome> => ({
    capabilities: hostDefaultFallbackCapabilities(),
  });
  const runner = new ABoxTaskRunner(adapter, provider, envPolicy, () => hostEnv);
  await runner.runAttempt(buildSpec());
  return capturedEnv;
};

// ---------------------------------------------------------------------------
// Default policy — empty allowlist, nothing survives
// ---------------------------------------------------------------------------

test("runAttempt: default env policy passes an empty env to spawn (no host leak)", async () => {
  const captured = await runAndCaptureSpawnEnv(DEFAULT_ENV_POLICY, {
    PATH: "/usr/bin",
    HOME: "/home/u",
    GITHUB_TOKEN: "ghp_x",
    SESSION_ID: "sess-42",
  });
  assert.deepEqual(captured, {});
});

test("runAttempt: default env policy scrubs even obvious secret names", async () => {
  const captured = await runAndCaptureSpawnEnv(DEFAULT_ENV_POLICY, {
    GITHUB_TOKEN: "ghp_xxx",
    AWS_SECRET_ACCESS_KEY: "shh",
    OPENAI_API_KEY: "sk-xxx",
  });
  assert.deepEqual(captured, {});
});

// ---------------------------------------------------------------------------
// Opt-in allowlist
// ---------------------------------------------------------------------------

test("runAttempt: explicit allowlist forwards only the named vars", async () => {
  const policy = resolveEnvPolicy({ configAllowlist: ["MY_VAR", "LANG"] });
  const captured = await runAndCaptureSpawnEnv(policy, {
    MY_VAR: "hello",
    LANG: "en_US.UTF-8",
    GITHUB_TOKEN: "ghp_xxx",
    PATH: "/usr/bin",
  });
  assert.deepEqual(captured, { MY_VAR: "hello", LANG: "en_US.UTF-8" });
});

test("runAttempt: allowlist cannot override the deny-pattern guard", async () => {
  const policy = resolveEnvPolicy({ configAllowlist: ["GITHUB_TOKEN", "PATH"] });
  const captured = await runAndCaptureSpawnEnv(policy, {
    GITHUB_TOKEN: "ghp_xxx",
    PATH: "/usr/bin",
  });
  assert.deepEqual(captured, { PATH: "/usr/bin" });
});
