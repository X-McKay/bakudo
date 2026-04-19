import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ABoxAdapter } from "../../src/aboxAdapter.js";

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

test("ABoxAdapter uses abox run with a valid ephemeral task", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execFn = async (
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args });
    return { stdout: "ok", stderr: "" };
  };

  const adapter = new ABoxAdapter("/tmp/abox", "/work/repo", execFn as never);
  const result = await adapter.runInStream("stream/one", "echo hello", 5);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.deepEqual(firstCall, {
    file: "/tmp/abox",
    args: [
      "--repo",
      "/work/repo",
      "run",
      "--task",
      "bakudo-stream-one",
      "--ephemeral",
      "--",
      "bash",
      "-lc",
      "echo hello",
    ],
  });
});

test("ABoxAdapter returns task metadata on failures", async () => {
  const execFn = async (): Promise<{ stdout: string; stderr: string }> => {
    const error = new Error("boom") as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    error.code = 2;
    error.stdout = "";
    error.stderr = "abox failed";
    throw error;
  };

  const adapter = new ABoxAdapter("abox", undefined, execFn as never);
  const result = await adapter.runInStream("s2", "echo hello", 5);

  assert.equal(result.ok, false);
  assert.match(result.output, /abox failed/);
  assert.equal(result.metadata?.["taskId"], "bakudo-s2");
});

test("ABoxAdapter streams live output events and aggregates the final result", async () => {
  const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
  const child = createMockChildProcess();
  const spawnFn = ((file: string, args: readonly string[], options: unknown) => {
    calls.push({ file, args, options });
    queueMicrotask(() => {
      child.stdout.emit("data", "hello ");
      child.stderr.emit("data", "warn");
      child.stdout.emit("data", "world");
      child.emit("close", 0, null);
    });
    return child;
  }) as never;

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const adapter = new ABoxAdapter("/tmp/abox", "/work/repo", undefined, spawnFn);
  const result = await adapter.runInStreamLive("stream one", "echo hello", 5, {
    onStdout: (chunk) => stdoutChunks.push(chunk),
    onStderr: (chunk) => stderrChunks.push(chunk),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    file: "/tmp/abox",
    args: [
      "--repo",
      "/work/repo",
      "run",
      "--task",
      "bakudo-stream-one",
      "--ephemeral",
      "--",
      "bash",
      "-lc",
      "echo hello",
    ],
    options: {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  assert.deepEqual(stdoutChunks, ["hello ", "world"]);
  assert.deepEqual(stderrChunks, ["warn"]);
  assert.equal(result.ok, true);
  assert.equal(result.output, "hello world\nwarn");
  assert.deepEqual(result.metadata, {
    errorType: "ok",
    code: "0",
    signal: "",
    cmd: [
      "/tmp/abox",
      "--repo",
      "/work/repo",
      "run",
      "--task",
      "bakudo-stream-one",
      "--ephemeral",
      "--",
      "bash",
      "-lc",
      "echo hello",
    ],
    taskId: "bakudo-stream-one",
  });
});

test("ABoxAdapter run options can disable --ephemeral", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execFn = async (
    file: string,
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ file, args });
    return { stdout: "ok", stderr: "" };
  };

  const adapter = new ABoxAdapter("/tmp/abox", "/work/repo", execFn as never);
  const result = await adapter.runInStream("stream/preserved", "echo hello", 5, {
    taskId: "bakudo-attempt-42",
    ephemeral: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    file: "/tmp/abox",
    args: [
      "--repo",
      "/work/repo",
      "run",
      "--task",
      "bakudo-attempt-42",
      "--",
      "bash",
      "-lc",
      "echo hello",
    ],
  });
});
