/**
 * Phase 6 Wave 6c PR8 — `/usage` + `/chronicle` end-to-end.
 *
 * Drives the CLI entrypoints (`runUsageCommand`, `runChronicleCommand`) and
 * the in-shell slash handlers against a synthetic `<storageRoot>` containing
 * a real `session.json` and `events.ndjson`. Both commands are read-only;
 * the suite asserts on return payloads + captured stdout rather than on
 * side effects.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionStore } from "../../src/sessionStore.js";
import {
  createSessionEvent,
  type SessionEventKind,
  type SessionEventEnvelope,
} from "../../src/protocol.js";
import type { SessionTurnRecord } from "../../src/sessionTypes.js";
import { createSessionEventLogWriter } from "../../src/host/eventLogWriter.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { runChronicleCommand } from "../../src/host/commands/chronicle.js";
import { runUsageCommand } from "../../src/host/commands/usage.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-usage-chronicle-"));

const writer = (): { sink: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    sink: {
      write: (chunk: string): boolean => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

const seedSession = async (
  rootDir: string,
  sessionId: string,
  options: { turns?: number; tokensPerCompletion?: number; approvalDenied?: boolean } = {},
): Promise<void> => {
  const turnCount = options.turns ?? 1;
  const store = new SessionStore(rootDir);
  const turns: SessionTurnRecord[] = [];
  for (let i = 0; i < turnCount; i += 1) {
    turns.push({
      turnId: `turn-${i + 1}`,
      prompt: `prompt ${i + 1}`,
      mode: "build",
      status: "completed",
      attempts: [
        {
          attemptId: `attempt-${i + 1}-a`,
          status: "succeeded",
          metadata: { agentProfile: "default" },
        },
      ],
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:01:00.000Z",
    });
  }
  await store.createSession({
    sessionId,
    goal: `goal for ${sessionId}`,
    repoRoot: "/tmp/repo",
    status: "completed",
    turns,
  });

  // Emit real v2 envelopes — this exercises the same NDJSON writer the
  // production path uses.
  const eventWriter = createSessionEventLogWriter(rootDir, sessionId);
  for (let i = 0; i < turnCount; i += 1) {
    const turnId = `turn-${i + 1}`;
    const attemptId = `attempt-${i + 1}-a`;
    await eventWriter.append(
      createSessionEvent({
        kind: "user.turn_submitted",
        sessionId,
        turnId,
        actor: "user",
        payload: { prompt: `prompt ${i + 1}`, mode: "build" },
      }),
    );
    await eventWriter.append(
      createSessionEvent({
        kind: "host.approval_requested",
        sessionId,
        turnId,
        attemptId,
        actor: "host",
        payload: {
          approvalId: `approval-${i + 1}`,
          request: { tool: "shell", argument: "ls", displayCommand: "ls" },
          policySnapshot: { agent: "default", composerMode: "standard", autopilot: false },
          requestedAt: "2026-04-18T00:00:30.000Z",
        },
      }),
    );
    await eventWriter.append(
      createSessionEvent({
        kind: "host.approval_resolved",
        sessionId,
        turnId,
        attemptId,
        actor: "host",
        payload: {
          approvalId: `approval-${i + 1}`,
          decision: options.approvalDenied === true ? "denied" : "approved",
          decidedBy: "user_prompt",
          matchedRule: {
            ruleId: `rule-${i + 1}`,
            effect: "allow",
            tool: "shell",
            pattern: "*",
            scope: "session",
            source: "agent_profile",
          },
          rationale: "",
          decidedAt: "2026-04-18T00:00:31.000Z",
        },
      }),
    );
    // Token-bearing attempt_completed — exercises the usage command's
    // payload.tokens extraction path.
    await eventWriter.append(
      createSessionEvent({
        kind: "worker.attempt_completed" as SessionEventKind,
        sessionId,
        turnId,
        attemptId,
        actor: "worker",
        payload: {
          attemptId,
          status: "succeeded",
          exitCode: 0,
          tokens: { prompt: 100, completion: options.tokensPerCompletion ?? 50 },
        } as unknown as Record<string, unknown>,
      }),
    );
  }
  await eventWriter.close();
};

// ---------------------------------------------------------------------------
// /usage
// ---------------------------------------------------------------------------

test("bakudo usage --session <id>: text mode renders a table (TTY-default)", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-alpha", { turns: 2 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--session", "session-alpha", "--format", "text"],
        storageRoot: root,
        stdoutIsTty: true,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report?.sessions.length, 1);
      assert.equal(result.report?.sessions[0]?.turns, 2);
      assert.equal(result.report?.sessions[0]?.attempts, 2);
      assert.equal(result.report?.sessions[0]?.tokens.total, 300); // 2 × (100+50)
    });
    const output = cap.chunks.join("");
    assert.match(output, /session-alpha/);
    assert.match(output, /bakudo usage/);
    assert.match(output, /totals:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo usage --format json: emits machine-readable envelope without a TTY", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-json", { turns: 1 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--session", "session-json", "--format", "json"],
        storageRoot: root,
        stdoutIsTty: false, // exercise lock-in 12: json is TTY-independent
      });
      assert.equal(result.exitCode, 0);
    });
    const output = cap.chunks.join("").trim();
    const parsed = JSON.parse(output);
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].sessionId, "session-json");
    assert.equal(parsed.totals.total, 150);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo usage: invalid --format surfaces structured error + exit code 2", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--format", "xml"],
        storageRoot: root,
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.error);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// /chronicle — one test per plan-782-791 filter
// ---------------------------------------------------------------------------

test("bakudo chronicle --since 7d: filters by recency (plan line 786)", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-recent", { turns: 1 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--since", "7d", "--format", "json"],
        storageRoot: root,
      });
      assert.equal(result.exitCode, 0);
      assert.ok((result.report?.envelopes.length ?? 0) > 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle --tool shell: filters to envelopes mentioning the tool (plan line 787)", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-tool", { turns: 1 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--tool", "shell", "--format", "json"],
        storageRoot: root,
      });
      assert.equal(result.exitCode, 0);
      // seedSession emits two envelopes with tool=shell (request + resolved).
      assert.equal(result.report?.matched, 2);
      for (const envelope of result.report?.envelopes ?? []) {
        assert.match(JSON.stringify(envelope), /shell/);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle --approval denied: only surfaces denied resolutions (plan line 788)", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-approved", { approvalDenied: false });
    await seedSession(root, "session-denied", { approvalDenied: true });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--approval", "denied", "--format", "json"],
        storageRoot: root,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report?.matched, 1);
      const envelope = result.report?.envelopes[0] as SessionEventEnvelope | undefined;
      assert.equal(envelope?.kind, "host.approval_resolved");
      assert.equal((envelope?.payload as { decision: string } | undefined)?.decision, "denied");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle --session <id>: restricts to one session (plan line 789)", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-one", { turns: 1 });
    await seedSession(root, "session-two", { turns: 1 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--session", "session-one", "--format", "json"],
        storageRoot: root,
      });
      assert.equal(result.exitCode, 0);
      for (const envelope of result.report?.envelopes ?? []) {
        assert.equal(envelope.sessionId, "session-one");
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle --format json: NDJSON output (one envelope per line, lock-in 12)", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-ndjson", { turns: 1 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--session", "session-ndjson", "--format", "json"],
        storageRoot: root,
        stdoutIsTty: false,
      });
      assert.equal(result.exitCode, 0);
    });
    const body = cap.chunks.join("").trim();
    assert.ok(body.length > 0);
    for (const line of body.split("\n")) {
      const parsed = JSON.parse(line) as { sessionId?: string };
      assert.equal(parsed.sessionId, "session-ndjson");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle: empty storage root is tolerated (no crash, matched=0)", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--format", "json"],
        storageRoot: root,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report?.matched, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle: --limit caps emitted envelopes", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-lots", { turns: 3 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--session", "session-lots", "--limit", "1", "--format", "json"],
        storageRoot: root,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report?.envelopes.length, 1);
      // matched pre-cap should exceed the limit (12 envelopes across 3 turns).
      assert.ok((result.report?.matched ?? 0) > 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wave 6c PR8 review blockers — regression tests
// ---------------------------------------------------------------------------

// B1 — JSON parse-error envelope (lock-in 19).

test("bakudo usage: parse error with --format=json emits the JSON error envelope", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--sinc", "7d", "--format=json"],
        storageRoot: root,
        stdoutIsTty: false,
      });
      assert.equal(result.exitCode, 2);
    });
    const body = cap.chunks.join("").trim();
    const parsed = JSON.parse(body) as {
      ok: boolean;
      kind: string;
      error: { code: string; message: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.kind, "error");
    assert.equal(parsed.error.code, "user_input");
    assert.match(parsed.error.message, /unknown usage flag|--sinc/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo usage: parse error with --format=text keeps the plain-text line", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--sinc", "7d", "--format=text"],
        storageRoot: root,
        stdoutIsTty: true,
      });
      assert.equal(result.exitCode, 2);
    });
    const body = cap.chunks.join("");
    assert.match(body, /^usage:/);
    // Must NOT be a JSON envelope.
    assert.throws(() => JSON.parse(body.trim()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle: parse error with --format=json emits the JSON error envelope", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--sinc", "7d", "--format=json"],
        storageRoot: root,
        stdoutIsTty: false,
      });
      assert.equal(result.exitCode, 2);
    });
    const body = cap.chunks.join("").trim();
    const parsed = JSON.parse(body) as {
      ok: boolean;
      kind: string;
      error: { code: string; message: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.kind, "error");
    assert.equal(parsed.error.code, "user_input");
    assert.match(parsed.error.message, /unknown chronicle flag|--sinc/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle: parse error with --format=text keeps the plain-text line", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--sinc", "7d", "--format=text"],
        storageRoot: root,
        stdoutIsTty: true,
      });
      assert.equal(result.exitCode, 2);
    });
    const body = cap.chunks.join("");
    assert.match(body, /^chronicle:/);
    assert.throws(() => JSON.parse(body.trim()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// B2 — `--session-id` rejected with helpful hint.

test("bakudo usage: --session-id is rejected with 'did you mean --session' hint", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--session-id", "foo"],
        storageRoot: root,
        stdoutIsTty: true,
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.error);
      assert.match(result.error ?? "", /did you mean --session/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo chronicle: --session-id is rejected with 'did you mean --session' hint", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runChronicleCommand({
        args: ["--session-id", "foo"],
        storageRoot: root,
        stdoutIsTty: true,
      });
      assert.equal(result.exitCode, 2);
      assert.ok(result.error);
      assert.match(result.error ?? "", /did you mean --session/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bakudo usage: --session still works (B2 fix does not break the happy path)", async () => {
  const root = await createTempRoot();
  try {
    await seedSession(root, "session-b2-happy", { turns: 1 });
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--session", "session-b2-happy", "--format", "json"],
        storageRoot: root,
        stdoutIsTty: false,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.report?.sessions[0]?.sessionId, "session-b2-happy");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// B2 — end-to-end via parseHostArgs: `bakudo usage --session-id foo` must
// reach `runUsageCommand` with the token in `usageArgs` (not silently sunk
// into `result.sessionId`). This locks in the parsing.ts redirection.

test("parseHostArgs: usage command forwards --session-id to usageArgs (redirected from sessionId)", async () => {
  const { parseHostArgs } = await import("../../src/host/parsing.js");
  const args = parseHostArgs(["usage", "--session-id", "foo"]);
  assert.equal(args.command, "usage");
  assert.equal(args.sessionId, undefined);
  assert.deepEqual(args.usageArgs, ["--session-id", "foo"]);
});

test("parseHostArgs: chronicle command forwards --session-id to chronicleArgs (redirected from sessionId)", async () => {
  const { parseHostArgs } = await import("../../src/host/parsing.js");
  const args = parseHostArgs(["chronicle", "--session-id", "foo"]);
  assert.equal(args.command, "chronicle");
  assert.equal(args.sessionId, undefined);
  assert.deepEqual(args.chronicleArgs, ["--session-id", "foo"]);
});

test("parseHostArgs: --session-id still populates sessionId for non-usage/chronicle commands", async () => {
  const { parseHostArgs } = await import("../../src/host/parsing.js");
  const args = parseHostArgs(["resume", "--session-id", "foo"]);
  assert.equal(args.command, "resume");
  assert.equal(args.sessionId, "foo");
});

// N4 — empty-state JSON integration coverage.

test("bakudo usage --session nonexistent --format=json: empty-state JSON report", async () => {
  const root = await createTempRoot();
  try {
    const cap = writer();
    await withCapturedStdout(cap.sink, async () => {
      const result = await runUsageCommand({
        args: ["--session", "does-not-exist", "--format=json"],
        storageRoot: root,
        stdoutIsTty: false,
      });
      assert.equal(result.exitCode, 0);
    });
    const parsed = JSON.parse(cap.chunks.join("").trim()) as {
      sessions: unknown[];
      totals: { prompt: number; completion: number; total: number };
    };
    assert.deepEqual(parsed.sessions, []);
    assert.deepEqual(parsed.totals, { prompt: 0, completion: 0, total: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
