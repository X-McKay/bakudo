import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../../src/cli.js";
import { withCapturedStdout } from "../../src/host/io.js";

const captureStdoutAndStderr = async <T>(
  fn: () => Promise<T>,
): Promise<{ result: T | string; stdout: string; stderr: string }> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutWriter = {
    write: (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    },
  };
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    let result: T | string;
    try {
      result = await withCapturedStdout(stdoutWriter, fn);
    } catch (error) {
      result = error instanceof Error ? error.message : String(error);
    }
    return {
      result,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.stderr.write = origStderrWrite;
  }
};

test("F-14: bakudo --foobar produces an error naming --foobar", async () => {
  const { stdout, stderr, result } = await captureStdoutAndStderr(() => runCli(["--foobar"]));
  const combined = `${stdout}\n${stderr}\n${typeof result === "string" ? result : ""}`;
  assert.match(combined, /--foobar/u);
  assert.doesNotMatch(combined, /missing required argument --goal/u);
});
