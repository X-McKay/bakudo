/**
 * Phase 5 PR14 — `--json` outputs valid structured data.
 *
 * Required assertion (plan `05-…hardening.md:288`): the `--json` /
 * `--output-format=json` stream is valid JSONL, the terminal line is
 * either `host.review_completed` or `{kind:"error"}`, and no TTY-only
 * code paths are hit (the hard rule at `05-…hardening.md:214-215` — no
 * Ink, no ANSI, no terminal-width dependency).
 *
 * These tests exercise the real {@link JsonBackend} + the CLI layer's
 * `printers.ts` JSON branches. One-shot `bakudo -p "<goal>"
 * --output-format=json` is covered in
 * {@link ../integration/oneShotPrompt.test.ts}; here we verify the
 * adjacent commands (inspect/sessions/status/review/sandbox/logs) stay
 * JSONL when `--json` is set.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ANSI_PATTERN } from "../../src/host/ansi.js";
import {
  buildOneShotReviewEnvelope,
  type OneShotReviewJsonEnvelope,
} from "../../src/host/copilotFlags.js";
import { emitSessionEvent } from "../../src/host/eventLogWriter.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { parseHostArgs, type HostCliArgs } from "../../src/host/parsing.js";
import {
  printLogs,
  printReview,
  printSandbox,
  printSessions,
  printStatus,
} from "../../src/host/printers.js";
import {
  JsonBackend,
  buildJsonErrorEnvelope,
  type JsonErrorEnvelope,
} from "../../src/host/renderers/jsonBackend.js";
import { selectRendererBackend, type RendererStdout } from "../../src/host/rendererBackend.js";
import { createSessionEvent, type SessionEventEnvelope } from "../../src/protocol.js";
import type { ReviewClassification } from "../../src/resultClassifier.js";
import { SessionStore } from "../../src/sessionStore.js";

const captureStdout = (): RendererStdout & { chunks: string[]; tape: () => string } => {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY: false,
    tape: () => chunks.join(""),
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
};

const captureWriter = (): {
  writer: { write: (chunk: string) => boolean };
  chunks: string[];
} => {
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

const reviewed: ReviewClassification = {
  outcome: "success",
  action: "accept",
  reason: "all checks passed",
  retryable: false,
  needsUser: false,
  confidence: "high",
};

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

test("selectRendererBackend: useJson=true returns JsonBackend (mocked non-TTY stdout)", () => {
  const stdout: RendererStdout = { isTTY: false, write: () => true };
  const backend = selectRendererBackend({ useJson: true, stdout });
  assert.ok(backend instanceof JsonBackend, "useJson → JsonBackend");
});

test("selectRendererBackend: useJson=true wins even on TTY (no TTY-only code path)", () => {
  const stdout: RendererStdout = { isTTY: true, write: () => true };
  const backend = selectRendererBackend({ useJson: true, stdout });
  assert.ok(backend instanceof JsonBackend, "--json wins over TTY heuristics");
});

// ---------------------------------------------------------------------------
// One-shot summary envelope
// ---------------------------------------------------------------------------

test("one-shot: --output-format=json parses to copilot.outputFormat === 'json'", () => {
  const args = parseHostArgs(["-p", "run echo hi", "--output-format=json"]);
  assert.equal(args.copilot.outputFormat, "json");
  assert.equal(args.command, "run");
});

test("one-shot: terminal line is review_completed envelope on success", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);
  const sessionId = "session-oneshot-pr14";
  // Simulate a minimal one-shot event tape: two session events + terminal summary.
  backend.emitJsonEnvelope(
    createSessionEvent({
      kind: "user.turn_submitted",
      sessionId,
      actor: "user",
      payload: { prompt: "run echo hi", mode: "build" },
    }),
  );
  backend.emitJsonEnvelope(
    createSessionEvent({
      kind: "host.review_completed",
      sessionId,
      turnId: "turn-1",
      attemptId: "attempt-1",
      actor: "host",
      payload: {
        attemptId: "attempt-1",
        outcome: "success",
        action: "accept",
        reason: "all checks passed",
      },
    }),
  );
  // Terminal line — the one-shot summary emitted by `runNonInteractiveOneShot`.
  stdout.write(`${JSON.stringify(buildOneShotReviewEnvelope(sessionId, reviewed))}\n`);

  const lines = stdout.tape().trimEnd().split("\n");
  // Every line is JSONL — JSON-parseable.
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `line must be JSONL: ${line}`);
  }
  const last = JSON.parse(lines[lines.length - 1]!) as OneShotReviewJsonEnvelope;
  assert.equal(last.kind, "review_completed");
  assert.equal(last.sessionId, sessionId);
});

test("one-shot: terminal line is error envelope on dispatch failure", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);
  const sessionId = "session-oneshot-pr14-err";
  backend.emitJsonEnvelope(
    createSessionEvent({
      kind: "user.turn_submitted",
      sessionId,
      actor: "user",
      payload: { prompt: "run oops", mode: "build" },
    }),
  );
  backend.emitJsonError({
    code: "worker_execution",
    message: "sandbox dispatch failed: abox binary not found",
  });
  const lines = stdout.tape().trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const last = JSON.parse(lines[lines.length - 1]!) as JsonErrorEnvelope;
  assert.equal(last.ok, false);
  assert.equal(last.kind, "error");
  assert.equal(last.error.code, "worker_execution");
  // The expected taxonomy matches `buildJsonErrorEnvelope` output byte-for-byte.
  assert.deepEqual(
    last,
    buildJsonErrorEnvelope({
      code: "worker_execution",
      message: "sandbox dispatch failed: abox binary not found",
    }),
  );
});

test("JSON stream: every line is JSONL, no ANSI leaks from TTY-only paths", () => {
  const stdout = captureStdout();
  const backend = new JsonBackend(stdout);
  const sessionId = "session-no-ansi-leak";
  // Emit a variety of event kinds that, in a text/TTY path, might carry
  // tone-wrapped strings.
  const envelopes: SessionEventEnvelope[] = [
    createSessionEvent({
      kind: "user.turn_submitted",
      sessionId,
      actor: "user",
      payload: { prompt: "run", mode: "build" },
    }),
    createSessionEvent({
      kind: "host.turn_queued",
      sessionId,
      turnId: "turn-x",
      actor: "host",
      payload: { turnId: "turn-x", prompt: "run", mode: "build" },
    }),
    createSessionEvent({
      kind: "host.dispatch_started",
      sessionId,
      turnId: "turn-x",
      attemptId: "attempt-x",
      actor: "host",
      payload: {
        attemptId: "attempt-x",
        goal: "run",
        mode: "build",
        assumeDangerousSkipPermissions: false,
      },
    }),
  ];
  for (const env of envelopes) {
    backend.emitJsonEnvelope(env);
  }
  const body = stdout.tape();
  // Hard rule: JsonBackend must not emit ANSI (no TTY-only code paths).
  assert.equal(body.match(ANSI_PATTERN), null, "JSON backend output contains no ANSI");
  // And `render(frame)` must be a no-op (Phase 5 PR3 contract).
  const priorLen = stdout.chunks.length;
  backend.render({
    mode: "prompt",
    header: { title: "x", mode: "standard", sessionLabel: "s" },
    transcript: [],
    footer: { hints: [] },
    composer: { placeholder: "", mode: "standard", autoApprove: false },
  });
  assert.equal(stdout.chunks.length, priorLen, "render(frame) is a no-op");
});

// ---------------------------------------------------------------------------
// CLI adjacency — sessions / status / review / sandbox / logs under --json
// ---------------------------------------------------------------------------

test("printSessions --json: every line is JSONL with sessionId/status", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-adj-sessions-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-adj-1",
      goal: "adjacent sessions",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "completed",
    });
    await store.createSession({
      sessionId: "session-adj-2",
      goal: "adjacent sessions 2",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "running",
    });

    const cap = captureWriter();
    const code = await withCapturedStdout(cap.writer, () => printSessions(baseArgs(root)));
    assert.equal(code, 0);
    const body = cap.chunks.join("");
    assert.equal(body.match(ANSI_PATTERN), null, "no ANSI in --json stream");
    const lines = body.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.sessionId, "string");
      assert.equal(typeof parsed.status, "string");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("printStatus --json (with sessionId): emits a single-line full record", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-adj-status-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-adj-status",
      goal: "adjacent status",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "running",
    });

    const cap = captureWriter();
    const args = {
      ...baseArgs(root),
      command: "status" as const,
      sessionId: "session-adj-status",
    };
    const code = await withCapturedStdout(cap.writer, () => printStatus(args));
    assert.equal(code, 0);
    const body = cap.chunks.join("");
    assert.equal(body.match(ANSI_PATTERN), null, "no ANSI in --json stream");
    const lines = body.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.sessionId, "session-adj-status");
    assert.ok(Array.isArray(parsed.turns));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("printLogs --json: emits JSONL envelopes with sessionId preserved on every line", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-adj-logs-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-adj-logs",
      goal: "logs under json",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
    });
    for (let i = 0; i < 4; i += 1) {
      await emitSessionEvent(
        root,
        "session-adj-logs",
        createSessionEvent({
          kind: "host.dispatch_started",
          sessionId: "session-adj-logs",
          turnId: "turn-1",
          attemptId: `attempt-${i}`,
          actor: "host",
          payload: {
            attemptId: `attempt-${i}`,
            goal: "noop",
            mode: "build",
            assumeDangerousSkipPermissions: false,
          },
        }),
      );
    }
    const cap = captureWriter();
    const args = {
      ...baseArgs(root),
      command: "logs" as const,
      sessionId: "session-adj-logs",
    };
    const code = await withCapturedStdout(cap.writer, () => printLogs(args));
    assert.equal(code, 0);
    const body = cap.chunks.join("");
    assert.equal(body.match(ANSI_PATTERN), null, "no ANSI in --json stream");
    const lines = body.trim().split("\n");
    assert.equal(lines.length, 4);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.sessionId, "session-adj-logs");
      assert.equal(typeof parsed.kind, "string");
      // Every envelope carries the session-event schema version.
      assert.equal(parsed.schemaVersion, 2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("printReview --json: exits non-zero sentinel when no reviewed result, surfaces message only", async () => {
  // Without an attempt, `printReview` throws. We just check the throw shape —
  // our contract is that the error path stays non-ANSI / non-TTY. The one-shot
  // path for dispatch failures is covered by `emitJsonError` above.
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-adj-review-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-adj-review",
      goal: "no result",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
    });
    const cap = captureWriter();
    const args = {
      ...baseArgs(root),
      command: "review" as const,
      sessionId: "session-adj-review",
    };
    await assert.rejects(
      () => withCapturedStdout(cap.writer, () => printReview(args)),
      /no (turn|reviewed)/u,
    );
    // No partial output should have leaked; even if it did, it must be ANSI-free.
    const body = cap.chunks.join("");
    assert.equal(body.match(ANSI_PATTERN), null, "no ANSI on error path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("printSandbox --json: throws cleanly when no turn exists, no ANSI partial output", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-json-adj-sandbox-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-adj-sandbox",
      goal: "no turn",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
    });
    const cap = captureWriter();
    const args = {
      ...baseArgs(root),
      command: "sandbox" as const,
      sessionId: "session-adj-sandbox",
    };
    await assert.rejects(
      () => withCapturedStdout(cap.writer, () => printSandbox(args)),
      /no turn/u,
    );
    const body = cap.chunks.join("");
    assert.equal(body.match(ANSI_PATTERN), null, "no ANSI on error path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --json alias parity
// ---------------------------------------------------------------------------

test("parseHostArgs: --json is alias for --output-format=json across commands", () => {
  const sessions = parseHostArgs(["sessions", "--json"]);
  assert.equal(sessions.copilot.outputFormat, "json");
  assert.equal(sessions.command, "sessions");

  const inspect = parseHostArgs(["status", "--json"]);
  assert.equal(inspect.copilot.outputFormat, "json");
  assert.equal(inspect.command, "status");

  const review = parseHostArgs(["review", "session-xyz", "--output-format=json"]);
  assert.equal(review.copilot.outputFormat, "json");
  assert.equal(review.command, "review");
});
