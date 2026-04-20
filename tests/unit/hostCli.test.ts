import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseHostArgs,
  reviewedOutcomeExitCode,
  runHostCli,
  shouldUseHostCli,
} from "../../src/hostCli.js";

test("host cli parses run commands and common overrides", () => {
  const args = parseHostArgs([
    "run",
    "fix",
    "the",
    "cli",
    "--mode",
    "plan",
    "--yes",
    "--repo",
    "/tmp/repo",
    "--abox-bin",
    "/usr/local/bin/abox",
    "--storage-root",
    "/tmp/bakudo-state",
    "--timeout-seconds",
    "25",
  ]);

  assert.equal(args.command, "run");
  assert.equal(args.goal, "fix the cli");
  assert.equal(args.mode, "plan");
  assert.equal(args.yes, true);
  assert.equal(args.repo, "/tmp/repo");
  assert.equal(args.aboxBin, "/usr/local/bin/abox");
  assert.equal(args.storageRoot, "/tmp/bakudo-state");
  assert.equal(args.timeoutSeconds, 25);
});

test("host cli parses review and resume commands", () => {
  const buildArgs = parseHostArgs(["build", "ship", "it"]);
  const planArgs = parseHostArgs(["plan", "inspect", "the", "repo"]);
  const reviewArgs = parseHostArgs(["review", "session-1", "task-7"]);
  const resumeArgs = parseHostArgs(["resume", "session-1"]);
  const statusArgs = parseHostArgs(["status", "session-4"]);
  const sessionsArgs = parseHostArgs(["sessions"]);
  const sandboxArgs = parseHostArgs(["sandbox", "session-9", "task-4"]);
  const tasksArgs = parseHostArgs(["tasks", "session-2"]);
  const logsArgs = parseHostArgs(["logs", "session-3", "task-11"]);
  const inspectArgs = parseHostArgs(["inspect", "session-8", "provenance"]);
  const helpArgs = parseHostArgs(["help"]);

  assert.equal(buildArgs.command, "build");
  assert.equal(buildArgs.mode, "build");
  assert.equal(buildArgs.goal, "ship it");
  assert.equal(planArgs.command, "plan");
  assert.equal(planArgs.mode, "plan");
  assert.equal(planArgs.goal, "inspect the repo");
  assert.equal(reviewArgs.command, "review");
  assert.equal(reviewArgs.sessionId, "session-1");
  assert.equal(reviewArgs.taskId, "task-7");
  assert.equal(resumeArgs.command, "resume");
  assert.equal(resumeArgs.sessionId, "session-1");
  assert.equal(statusArgs.command, "status");
  assert.equal(statusArgs.sessionId, "session-4");
  assert.equal(sessionsArgs.command, "sessions");
  assert.equal(sandboxArgs.command, "sandbox");
  assert.equal(sandboxArgs.sessionId, "session-9");
  assert.equal(sandboxArgs.taskId, "task-4");
  assert.equal(tasksArgs.command, "tasks");
  assert.equal(tasksArgs.sessionId, "session-2");
  assert.equal(logsArgs.command, "logs");
  assert.equal(logsArgs.sessionId, "session-3");
  assert.equal(logsArgs.taskId, "task-11");
  assert.equal(inspectArgs.command, "inspect");
  assert.equal(inspectArgs.sessionId, "session-8");
  assert.equal(inspectArgs.inspectTab, "provenance");
  assert.equal(helpArgs.command, "help");
});

test("host cli parses inspect with positional and --session forms", () => {
  const positional = parseHostArgs(["inspect", "session-1", "summary"]);
  const flagged = parseHostArgs(["inspect", "--session", "session-2", "logs"]);
  const defaultTab = parseHostArgs(["inspect", "--session", "session-3"]);

  assert.equal(positional.command, "inspect");
  assert.equal(positional.sessionId, "session-1");
  assert.equal(positional.inspectTab, "summary");

  assert.equal(flagged.command, "inspect");
  assert.equal(flagged.sessionId, "session-2");
  assert.equal(flagged.inspectTab, "logs");

  assert.equal(defaultTab.command, "inspect");
  assert.equal(defaultTab.sessionId, "session-3");
  assert.equal(defaultTab.inspectTab, undefined);
});

test("host cli command detection prefers the host surface", () => {
  assert.equal(shouldUseHostCli([]), true);
  assert.equal(shouldUseHostCli(["help"]), true);
  assert.equal(shouldUseHostCli(["--help"]), true);
  assert.equal(shouldUseHostCli(["-h"]), true);
  assert.equal(shouldUseHostCli(["build", "fix it"]), true);
  assert.equal(shouldUseHostCli(["plan", "review architecture"]), true);
  assert.equal(shouldUseHostCli(["run", "fix it"]), true);
  assert.equal(shouldUseHostCli(["review", "session-1"]), true);
  assert.equal(shouldUseHostCli(["status"]), true);
  assert.equal(shouldUseHostCli(["sessions"]), true);
  assert.equal(shouldUseHostCli(["sandbox", "session-1"]), true);
  assert.equal(shouldUseHostCli(["tasks", "session-1"]), true);
  assert.equal(shouldUseHostCli(["logs", "session-1"]), true);
  assert.equal(shouldUseHostCli(["inspect", "session-1"]), true);
  assert.equal(shouldUseHostCli(["--session-id", "session-1", "--task-id", "task-1"]), true);
  assert.equal(shouldUseHostCli(["--goal", "echo hi"]), false);
});

test("host cli rejects conflicting modes and unknown options", () => {
  assert.throws(() => parseHostArgs(["plan", "--mode", "build", "inspect"]), /cannot be combined/);
  assert.throws(() => parseHostArgs(["run", "inspect", "--bogus"]), /unknown option: --bogus/);
});

test("host cli validates inspect arity", () => {
  assert.throws(() => parseHostArgs(["inspect"]), /missing session id for inspect/);
  assert.throws(
    () => parseHostArgs(["inspect", "session-1", "summary", "extra"]),
    /inspect accepts a session id and optional tab/,
  );
  assert.throws(
    () => parseHostArgs(["inspect", "--session", "session-1", "summary", "extra"]),
    /inspect accepts at most one positional tab when --session is used/,
  );
});

test("host cli dispatches status and init commands", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bakudo-host-cli-"));
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    const statusCode = await runHostCli(["status", "--storage-root", workspace]);
    const initCode = await runHostCli(["init", "--repo", workspace, "--yes"]);

    assert.equal(statusCode, 0);
    assert.equal(initCode, 0);
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = writes.join("");
  assert.match(output, /No sessions found yet\./);
  assert.match(output, /Wrote .*AGENTS\.md/);

  const agents = await readFile(join(workspace, "AGENTS.md"), "utf8");
  assert.match(agents, /Bakudo Workflow/);
});

// Phase 6 W4 — `bakudo cleanup` reaches its own parser via cleanupArgs.
test("host cli accepts `cleanup` and forwards --dry-run / --older-than / --session", () => {
  const a = parseHostArgs(["cleanup"]);
  assert.equal(a.command, "cleanup");
  assert.deepEqual(a.cleanupArgs, undefined);

  const b = parseHostArgs(["cleanup", "--dry-run"]);
  assert.deepEqual(b.cleanupArgs, ["--dry-run"]);

  const c = parseHostArgs(["cleanup", "--older-than", "30d"]);
  assert.deepEqual(c.cleanupArgs, ["--older-than", "30d"]);

  const d = parseHostArgs(["cleanup", "--session", "session-x"]);
  assert.deepEqual(d.cleanupArgs, ["--session", "session-x"]);
});

test("host cli rejects positional args on cleanup", () => {
  assert.throws(() => parseHostArgs(["cleanup", "extra"]));
});

test("reviewed outcome exit codes are stable", () => {
  assert.equal(
    reviewedOutcomeExitCode({
      outcome: "success",
      action: "accept",
      reason: "ok",
      retryable: false,
      needsUser: false,
      confidence: "high",
    }),
    0,
  );
  assert.equal(
    reviewedOutcomeExitCode({
      outcome: "blocked_needs_user",
      action: "ask_user",
      reason: "approval needed",
      retryable: false,
      needsUser: true,
      confidence: "medium",
    }),
    2,
  );
});
