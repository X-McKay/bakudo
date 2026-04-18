import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOneShotReviewEnvelope,
  type OneShotReviewJsonEnvelope,
} from "../../src/host/copilotFlags.js";
import { parseHostArgs } from "../../src/host/parsing.js";
import type { ReviewClassification } from "../../src/resultClassifier.js";

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
