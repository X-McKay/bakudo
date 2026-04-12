import test from "node:test";
import assert from "node:assert/strict";

import { ABoxAdapter } from "../../src/aboxAdapter.js";

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
      "bakudo-stream-one-1",
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
  assert.equal(result.metadata?.["taskId"], "bakudo-s2-1");
});
