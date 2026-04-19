import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EXIT_CODES } from "../../src/host/errors.js";
import { withCapturedStdout } from "../../src/host/io.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { runNonInteractiveOneShot } from "../../src/host/oneShotRun.js";

const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

const baseArgs = (storageRoot: string): HostCliArgs =>
  ({
    command: "run",
    config: "config/default.json",
    aboxBin: "abox",
    repo: ".",
    mode: "build",
    yes: false,
    shell: "bash",
    timeoutSeconds: 120,
    maxOutputBytes: 256 * 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    storageRoot,
    copilot: { prompt: "hello", outputFormat: "json", allowAllTools: false },
  }) as HostCliArgs;

test("F-05 acceptance: -p --output-format=json with denying policy emits one approval_required JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-f-05-integ-"));
  try {
    const { writer, chunks } = capture();
    const exit = await withCapturedStdout(writer, () => runNonInteractiveOneShot(baseArgs(root)));

    assert.equal(exit, EXIT_CODES.BLOCKED);
    const lines = chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "expected at least one JSONL line");
    for (const line of lines) {
      assert.ok(line.startsWith("{"), `non-JSONL line: ${line}`);
    }
    const approvals = lines
      .map((line) => JSON.parse(line) as { error?: { code?: string } })
      .filter((entry) => entry.error?.code === "approval_required");
    assert.equal(approvals.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
