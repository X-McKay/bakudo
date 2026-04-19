import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ABoxAdapter } from "../../src/aboxAdapter.js";
import { buildAboxShellCommandArgs } from "../../src/host/sandboxLifecycle.js";
import { DEFAULT_ENV_POLICY, filterEnv } from "../../src/host/envPolicy.js";

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: string | null;
  kill: (signal?: string | number) => boolean;
};

const createMockChildProcess = (): MockChildProcess => {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal?: string | number) => {
    child.signalCode =
      typeof signal === "string" ? signal : signal === undefined ? null : String(signal);
    return true;
  };
  return child;
};

const EPHEMERAL_PROFILE = {
  agentBackend: "codex exec --dangerously-bypass-approvals-and-sandbox",
  sandboxLifecycle: "ephemeral" as const,
  mergeStrategy: "none" as const,
};

const runAndCaptureSpawnEnv = async (
  aboxBin: string,
  env: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> => {
  let capturedEnv: Record<string, string> | undefined;
  const child = createMockChildProcess();
  const spawnFn = ((_file: string, _args: readonly string[], options: { env?: unknown }) => {
    capturedEnv = options.env as Record<string, string> | undefined;
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as never;

  const taskId = "bakudo-f-04";
  const adapter = new ABoxAdapter(aboxBin, undefined, spawnFn);
  const result = await adapter.spawnLive(
    buildAboxShellCommandArgs(taskId, "echo ok", EPHEMERAL_PROFILE),
    5,
    {},
    env,
    { taskId },
  );
  assert.equal(result.ok, true);
  return capturedEnv;
};

test("F-04: injects host PATH for unqualified aboxBin resolution", async () => {
  const hostPath = process.env.PATH;
  assert.notEqual(hostPath, undefined, "test host must define PATH");

  const filteredEnv = filterEnv(
    {
      PATH: "/guest/path/should/not/survive",
      HOME: "/home/al",
      SECRET_TOKEN: "redacted",
    },
    DEFAULT_ENV_POLICY,
  );

  assert.deepEqual(filteredEnv, {});
  const capturedEnv = await runAndCaptureSpawnEnv("abox", filteredEnv);
  assert.deepEqual(capturedEnv, { PATH: hostPath });
});

test("F-04: does not inject PATH when aboxBin is absolute", async () => {
  const filteredEnv = filterEnv(
    {
      PATH: "/guest/path/should/not/survive",
      HOME: "/home/al",
    },
    DEFAULT_ENV_POLICY,
  );

  assert.deepEqual(filteredEnv, {});
  const capturedEnv = await runAndCaptureSpawnEnv("/usr/local/bin/abox", filteredEnv);
  assert.deepEqual(capturedEnv, {});
});

test("F-04: host PATH injection does not mutate the caller env", async () => {
  const hostPath = process.env.PATH;
  assert.notEqual(hostPath, undefined, "test host must define PATH");

  const callerEnv = {
    PATH: "/guest/path/should/stay-local",
    WORKER_FLAG: "enabled",
  };
  const before = { ...callerEnv };

  const capturedEnv = await runAndCaptureSpawnEnv("abox", callerEnv);

  assert.notEqual(capturedEnv, callerEnv);
  assert.deepEqual(capturedEnv, {
    PATH: hostPath,
    WORKER_FLAG: "enabled",
  });
  assert.deepEqual(callerEnv, before);
});
