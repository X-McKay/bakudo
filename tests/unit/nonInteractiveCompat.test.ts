import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { parseHostArgs, runHostCli } from "../../src/hostCli.js";

const captureStdout = async <T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = await fn();
    return { value, output: writes.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
};

const seedV2Session = async (storageRoot: string): Promise<string> => {
  const sessionId = "session-compat";
  const dir = join(storageRoot, sessionId);
  await mkdir(dir, { recursive: true });
  const attempt = {
    attemptId: "attempt-1",
    status: "succeeded",
    request: {
      schemaVersion: 1,
      taskId: "attempt-1",
      sessionId,
      goal: "non-interactive compat",
      mode: "plan",
      assumeDangerousSkipPermissions: false,
    },
    result: {
      schemaVersion: 1,
      taskId: "attempt-1",
      sessionId,
      status: "succeeded",
      summary: "worked",
      finishedAt: "2026-04-15T00:00:00.000Z",
    },
    metadata: { sandboxTaskId: "abox-abc" },
  };
  const session = {
    schemaVersion: 2,
    sessionId,
    repoRoot: ".",
    goal: "non-interactive compat",
    status: "completed",
    assumeDangerousSkipPermissions: false,
    turns: [
      {
        turnId: "turn-1",
        prompt: "non-interactive compat",
        mode: "plan",
        status: "completed",
        attempts: [attempt],
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T00:00:00.000Z",
      },
    ],
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
  };
  await writeFile(join(dir, "session.json"), JSON.stringify(session, null, 2), "utf8");
  return sessionId;
};

test("non-interactive compat: plan command parses as plan mode and stores goal", () => {
  const args = parseHostArgs(["plan", "inspect", "the", "repo"]);
  assert.equal(args.command, "plan");
  assert.equal(args.mode, "plan");
  assert.equal(args.goal, "inspect the repo");
});

test("non-interactive compat: build command parses as build mode and stores goal", () => {
  const args = parseHostArgs(["build", "ship", "it"]);
  assert.equal(args.command, "build");
  assert.equal(args.mode, "build");
  assert.equal(args.goal, "ship it");
});

test("parseHostArgs: accepts copilot-parity flags without erroring", () => {
  const args = parseHostArgs([
    "plan",
    "--prompt",
    "override prompt",
    "--stream=off",
    "--plain-diff",
    "--output-format=json",
    "--allow-all-tools",
    "--no-ask-user",
  ]);
  assert.equal(args.command, "plan");
  assert.equal(args.copilot.prompt, "override prompt");
  assert.equal(args.copilot.streamOff, true);
  assert.equal(args.copilot.plainDiff, true);
  assert.equal(args.copilot.outputFormat, "json");
  assert.equal(args.copilot.allowAllTools, true);
  assert.equal(args.copilot.noAskUser, true);
  assert.equal(args.goal, "override prompt");
});

test("parseHostArgs: -p short flag sets copilot.prompt", () => {
  const args = parseHostArgs(["plan", "-p", "hello"]);
  assert.equal(args.copilot.prompt, "hello");
  assert.equal(args.goal, "hello");
});

test("parseHostArgs: rejects invalid --stream value", () => {
  assert.throws(() => parseHostArgs(["plan", "stuff", "--stream=sideways"]), /invalid --stream/);
});

test("parseHostArgs: rejects invalid --output-format value", () => {
  assert.throws(
    () => parseHostArgs(["plan", "stuff", "--output-format=yaml"]),
    /invalid --output-format/,
  );
});

test("runHostCli: review routes through inspect formatter against a v2 session", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-compat-"));
  const sessionId = await seedV2Session(storageRoot);
  const { value, output } = await captureStdout(() =>
    runHostCli(["review", sessionId, "--storage-root", storageRoot]),
  );
  assert.equal(value, 0);
  // The formatter reorders with Outcome before other fields — sanity check output.
  assert.match(output, /Review/);
  assert.match(output, new RegExp(sessionId));
  assert.match(output, /Outcome/);
  assert.match(output, /success/);
});

test("runHostCli: sandbox command routes through inspect formatter", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-compat-"));
  const sessionId = await seedV2Session(storageRoot);
  const { value, output } = await captureStdout(() =>
    runHostCli(["sandbox", sessionId, "--storage-root", storageRoot]),
  );
  assert.equal(value, 0);
  assert.match(output, /Sandbox/);
  assert.match(output, /abox-abc/);
});

test("runHostCli: logs command succeeds with zero events on a sessionless file", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-compat-"));
  const sessionId = await seedV2Session(storageRoot);
  const { value, output } = await captureStdout(() =>
    runHostCli(["logs", sessionId, "--storage-root", storageRoot]),
  );
  assert.equal(value, 0);
  assert.match(output, /No log events found|Logs/);
});
