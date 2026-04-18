import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore } from "../../src/sessionStore.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { printSessions, printStatus, printLogs } from "../../src/host/printers.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { emitSessionEvent } from "../../src/host/eventLogWriter.js";
import { createSessionEvent } from "../../src/protocol.js";

const capture = (): { writer: { write: (chunk: string) => boolean }; output: string[] } => {
  const output: string[] = [];
  return {
    output,
    writer: {
      write: (chunk: string) => {
        output.push(chunk);
        return true;
      },
    },
  };
};

const baseArgs = (storageRoot: string): HostCliArgs => ({
  command: "sessions",
  config: "config/default.json",
  aboxBin: "abox",
  mode: "build",
  yes: false,
  shell: "bash",
  timeoutSeconds: 120,
  maxOutputBytes: 256 * 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  copilot: { outputFormat: "json" },
  storageRoot,
});

test("printSessions --json emits valid JSONL of SessionIndexEntry records", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-aaa",
      goal: "first goal",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "completed",
    });
    await store.createSession({
      sessionId: "session-bbb",
      goal: "second goal",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "running",
    });

    const c = capture();
    const args = baseArgs(root);
    const code = await withCapturedStdout(c.writer, () => printSessions(args));
    assert.equal(code, 0);

    const lines = c.output.join("").trim().split("\n");
    assert.equal(lines.length, 2, "two sessions = two JSONL lines");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.sessionId, "string");
      assert.equal(typeof parsed.status, "string");
      assert.equal(typeof parsed.title, "string");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("printStatus --json without sessionId emits JSONL summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-ccc",
      goal: "status goal",
      repoRoot: "/r",
      assumeDangerousSkipPermissions: false,
    });

    const c = capture();
    const args = { ...baseArgs(root), command: "status" as const };
    const code = await withCapturedStdout(c.writer, () => printStatus(args));
    assert.equal(code, 0);

    const lines = c.output.join("").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.sessionId, "session-ccc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("printStatus --json with sessionId emits full SessionRecord", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-ddd",
      goal: "full record",
      repoRoot: "/r",
      assumeDangerousSkipPermissions: false,
      status: "running",
    });

    const c = capture();
    const args = { ...baseArgs(root), command: "status" as const, sessionId: "session-ddd" };
    const code = await withCapturedStdout(c.writer, () => printStatus(args));
    assert.equal(code, 0);

    const lines = c.output.join("").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.sessionId, "session-ddd");
    assert.ok(Array.isArray(parsed.turns), "full record includes turns array");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("printLogs --json emits SessionEventEnvelope JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-eee",
      goal: "log test",
      repoRoot: "/r",
      assumeDangerousSkipPermissions: false,
    });
    // Write three event envelopes.
    for (let i = 0; i < 3; i++) {
      await emitSessionEvent(
        root,
        "session-eee",
        createSessionEvent({
          kind: "host.dispatch_started",
          sessionId: "session-eee",
          turnId: "turn-1",
          attemptId: `attempt-${i}`,
          actor: "host",
          payload: {
            attemptId: `attempt-${i}`,
            goal: "test",
            mode: "build" as const,
            assumeDangerousSkipPermissions: false,
          },
        }),
      );
    }

    const c = capture();
    const args = {
      ...baseArgs(root),
      command: "logs" as const,
      sessionId: "session-eee",
    };
    const code = await withCapturedStdout(c.writer, () => printLogs(args));
    assert.equal(code, 0);

    const lines = c.output.join("").trim().split("\n");
    assert.equal(lines.length, 3, "3 events = 3 JSONL lines");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.sessionId, "session-eee");
      assert.equal(typeof parsed.kind, "string");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseHostArgs: --json is alias for --output-format=json", async () => {
  const { parseHostArgs } = await import("../../src/host/parsing.js");
  const args = parseHostArgs(["sessions", "--json"]);
  assert.equal(args.copilot.outputFormat, "json");
  assert.equal(args.command, "sessions");
});
