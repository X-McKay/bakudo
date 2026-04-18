import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOneShotReviewEnvelope,
  type OneShotReviewJsonEnvelope,
} from "../../src/host/copilotFlags.js";
import { parseHostArgs } from "../../src/host/parsing.js";
import {
  buildJsonErrorEnvelope,
  JsonBackend,
  type JsonErrorEnvelope,
} from "../../src/host/renderers/jsonBackend.js";
import type { RendererStdout } from "../../src/host/rendererBackend.js";
import type { ReviewClassification } from "../../src/resultClassifier.js";
import { createSessionEvent, type SessionEventEnvelope } from "../../src/protocol.js";

/**
 * Phase 5 PR11 — one-shot `-p` + `--output-format=json` wiring.
 *
 * We do not spin up an abox sandbox here (that requires the binary and
 * worker image). Instead we verify the wiring end-to-end at the CLI layer:
 *
 * 1. `parseHostArgs` resolves `-p` + `--output-format=json` to a runnable
 *    HostCliArgs that one-shots against `run`.
 * 2. `buildOneShotReviewEnvelope` produces a JSON-parsable line ending in
 *    a `review_completed` envelope that matches the promised schema.
 *
 * Together these cover the "emits JSONL envelopes ending in a
 * review_completed event" contract in the plan.
 */

test("one-shot: bakudo -p 'goal' --output-format=json wires run + json output", () => {
  const args = parseHostArgs(["-p", "run echo hello", "--output-format=json"]);
  assert.equal(args.command, "run");
  assert.equal(args.goal, "run echo hello");
  assert.equal(args.copilot.prompt, "run echo hello");
  assert.equal(args.copilot.outputFormat, "json");
});

test("one-shot: JSON envelope matches review_completed shape", () => {
  const reviewed: ReviewClassification = {
    outcome: "success",
    action: "accept",
    reason: "all checks passed",
    retryable: false,
    needsUser: false,
    confidence: "high",
  };
  const envelope = buildOneShotReviewEnvelope("session-oneshot-1", reviewed);
  const expected: OneShotReviewJsonEnvelope = {
    kind: "review_completed",
    sessionId: "session-oneshot-1",
    outcome: "success",
    action: "accept",
    reason: "all checks passed",
    needsUser: false,
    retryable: false,
    confidence: "high",
  };
  assert.deepEqual(envelope, expected);

  // JSONL round-trip: one line, JSON-parseable, kind === "review_completed".
  const line = JSON.stringify(envelope);
  const parsed = JSON.parse(line) as OneShotReviewJsonEnvelope;
  assert.equal(parsed.kind, "review_completed");
  assert.equal(parsed.sessionId, "session-oneshot-1");
  assert.equal(parsed.outcome, "success");
});

test("one-shot: --allow-all-tools combined with -p parses to autopilot intent", () => {
  const args = parseHostArgs(["-p", "refactor X", "--allow-all-tools"]);
  assert.equal(args.command, "run");
  assert.equal(args.copilot.allowAllTools, true);
  // `--yes` stays orthogonal; the composer-mode collapse happens inside
  // `sessionController.resolveAutoApprove`, not during parsing.
  assert.equal(args.yes, false);
});

test("one-shot: stream=off + plain-diff + no-ask-user parse without errors", () => {
  const args = parseHostArgs(["-p", "run tests", "--stream=off", "--plain-diff", "--no-ask-user"]);
  assert.equal(args.copilot.streamOff, true);
  assert.equal(args.copilot.plainDiff, true);
  assert.equal(args.copilot.noAskUser, true);
});

/**
 * Phase 5 PR3 — stream-structure assertions for `--output-format=json`.
 *
 * We can't spin up an abox sandbox here, so we simulate the one-shot stdout
 * tape by concatenating the lines the JsonBackend would have written (one
 * per envelope) and verifying the end-state invariants: every intermediate
 * line is a valid JSONL session-event envelope, and the last line is the
 * flat `review_completed` envelope the task contract promises.
 */

const captureRendererStdout = (): RendererStdout & { chunks: string[]; tape: () => string } => {
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

const intermediateEnvelopes = (sessionId: string): SessionEventEnvelope[] => [
  createSessionEvent({
    kind: "user.turn_submitted",
    sessionId,
    actor: "user",
    payload: { prompt: "run echo hello", mode: "build" },
  }),
  createSessionEvent({
    kind: "host.turn_queued",
    sessionId,
    turnId: "turn-1",
    actor: "host",
    payload: { turnId: "turn-1", prompt: "run echo hello", mode: "build" },
  }),
  createSessionEvent({
    kind: "host.dispatch_started",
    sessionId,
    turnId: "turn-1",
    attemptId: "attempt-1",
    actor: "host",
    payload: {
      attemptId: "attempt-1",
      goal: "run echo hello",
      mode: "build",
      assumeDangerousSkipPermissions: false,
    },
  }),
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
];

const reviewed: ReviewClassification = {
  outcome: "success",
  action: "accept",
  reason: "all checks passed",
  retryable: false,
  needsUser: false,
  confidence: "high",
};

test("one-shot JSON tape: intermediate lines are valid SessionEventEnvelope JSONL", () => {
  const stdout = captureRendererStdout();
  const backend = new JsonBackend(stdout);
  const sessionId = "session-oneshot-pr3";

  for (const env of intermediateEnvelopes(sessionId)) {
    backend.emitJsonEnvelope(env);
  }
  // Terminal one-shot summary (what runNonInteractiveOneShot emits last).
  const summary = buildOneShotReviewEnvelope(sessionId, reviewed);
  stdout.write(`${JSON.stringify(summary)}\n`);

  const lines = stdout.tape().trimEnd().split("\n");
  assert.equal(lines.length, 5, "4 envelopes + 1 summary = 5 lines");
  for (let i = 0; i < 4; i += 1) {
    const parsed = JSON.parse(lines[i]!) as SessionEventEnvelope;
    assert.equal(parsed.schemaVersion, 2, `line ${i}: v2 envelope`);
    assert.equal(parsed.sessionId, sessionId, `line ${i}: sessionId preserved`);
    assert.equal(typeof parsed.kind, "string");
  }
});

test("one-shot JSON tape: last line is a review_completed envelope on success", () => {
  const stdout = captureRendererStdout();
  const backend = new JsonBackend(stdout);
  const sessionId = "session-oneshot-last-line";

  for (const env of intermediateEnvelopes(sessionId)) {
    backend.emitJsonEnvelope(env);
  }
  const summary = buildOneShotReviewEnvelope(sessionId, reviewed);
  stdout.write(`${JSON.stringify(summary)}\n`);

  const lines = stdout.tape().trimEnd().split("\n");
  const last = JSON.parse(lines[lines.length - 1]!) as OneShotReviewJsonEnvelope;
  assert.equal(last.kind, "review_completed");
  assert.equal(last.sessionId, sessionId);
  assert.equal(last.outcome, "success");
});

test("one-shot JSON tape: dispatch failure emits an error envelope on the last line", () => {
  const stdout = captureRendererStdout();
  const backend = new JsonBackend(stdout);
  const sessionId = "session-oneshot-error";

  // Simulate a partial stream that failed before review.
  backend.emitJsonEnvelope(intermediateEnvelopes(sessionId)[0]!);
  backend.emitJsonEnvelope(intermediateEnvelopes(sessionId)[1]!);
  backend.emitJsonError({
    code: "worker_execution",
    message: "sandbox dispatch failed: abox binary not found",
  });

  const lines = stdout.tape().trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const last = JSON.parse(lines[lines.length - 1]!) as JsonErrorEnvelope;
  assert.equal(last.ok, false);
  assert.equal(last.kind, "error");
  assert.equal(last.error.code, "worker_execution");
  assert.ok(last.error.message.includes("abox binary not found"));
});

test("one-shot error envelope: buildJsonErrorEnvelope matches the emitted shape", () => {
  const stdout = captureRendererStdout();
  const backend = new JsonBackend(stdout);
  backend.emitJsonError({
    code: "approval_denied",
    message: "--no-ask-user blocked an approval",
    details: { tool: "shell_write" },
  });
  const lines = stdout.tape().trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as JsonErrorEnvelope;
  const expected = buildJsonErrorEnvelope({
    code: "approval_denied",
    message: "--no-ask-user blocked an approval",
    details: { tool: "shell_write" },
  });
  assert.deepEqual(parsed, expected);
});
