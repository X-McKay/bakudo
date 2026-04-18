import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import {
  answerApprovalDialog,
  launchApprovalDialog,
  launchRecoveryDialog,
  launchSessionPickerDialog,
  parseApprovalChoice,
  type ApprovalRequest,
  type DialogDispatcher,
} from "../../src/host/dialogLauncher.js";
import { resetPromptResolvers } from "../../src/host/promptResolvers.js";

/**
 * Phase 4 PR7 — dialogLauncher round-trip and mutual-exclusion tests.
 */

const makeDispatcher = (): DialogDispatcher => {
  let state: HostAppState = initialHostAppState();
  return {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
};

const sampleRequest: ApprovalRequest = {
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  tool: "shell",
  argument: "git push origin main",
  policySnapshot: { agent: "standard", composerMode: "standard", autopilot: false },
};

test("launchApprovalDialog: resolves with allow_once when user answers 1", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const pending = launchApprovalDialog(dispatcher, sampleRequest, "git push:*");
  // Allow the producer to enqueue before we answer.
  await Promise.resolve();
  const id = answerApprovalDialog(dispatcher, "1");
  assert.ok(id !== null, "expected a pending approval_prompt to resolve");
  const choice = await pending;
  assert.equal(choice.kind, "allow_once");
  assert.equal(dispatcher.getState().promptQueue.length, 0);
});

test("launchApprovalDialog: resolves with allow_always and carries the pattern", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const pending = launchApprovalDialog(dispatcher, sampleRequest, "git push:*");
  await Promise.resolve();
  answerApprovalDialog(dispatcher, "2");
  const choice = await pending;
  assert.equal(choice.kind, "allow_always");
  if (choice.kind === "allow_always") {
    assert.equal(choice.pattern, "git push:*");
  }
});

test("launchApprovalDialog: resolves with deny when user answers 3", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const pending = launchApprovalDialog(dispatcher, sampleRequest, "git push:*");
  await Promise.resolve();
  answerApprovalDialog(dispatcher, "3");
  const choice = await pending;
  assert.equal(choice.kind, "deny");
});

test("launchApprovalDialog: resolves with show_context when user answers 4", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const pending = launchApprovalDialog(dispatcher, sampleRequest, "git push:*");
  await Promise.resolve();
  answerApprovalDialog(dispatcher, "4");
  const choice = await pending;
  assert.equal(choice.kind, "show_context");
});

test("launchApprovalDialog: unknown input collapses to deny", () => {
  assert.deepEqual(parseApprovalChoice("nonsense", "p"), { kind: "deny" });
  assert.deepEqual(parseApprovalChoice("", "p"), { kind: "deny" });
  assert.deepEqual(parseApprovalChoice("5", "p"), { kind: "deny" });
});

test("launchApprovalDialog: mutual exclusion — second launch stays pending until the first resolves", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();

  const firstPromise = launchApprovalDialog(dispatcher, sampleRequest, "git push:*");
  await Promise.resolve();
  // Second launch while the first is on the queue.
  const secondPromise = launchApprovalDialog(
    dispatcher,
    { ...sampleRequest, argument: "rm -rf /tmp/foo" },
    "rm:*",
  );
  await Promise.resolve();

  const queue = dispatcher.getState().promptQueue;
  assert.equal(queue.length, 2, "both prompts should sit on the queue simultaneously");
  assert.equal(queue[0]?.kind, "approval_prompt");
  assert.equal(queue[1]?.kind, "approval_prompt");

  // Only the head resolves first.
  const firstId = queue[0]!.id;
  const secondId = queue[1]!.id;

  // Race: attach a timeout guard to prove the second promise hasn't resolved.
  const stillPending = await Promise.race([
    secondPromise.then(() => "resolved" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
  ]);
  assert.equal(stillPending, "pending", "second dialog must not resolve while first is pending");

  // Resolve the first prompt by id (not through dispatcher — head is second
  // only AFTER the first dequeues). We use the direct resolver for both.
  const { answerPrompt } = await import("../../src/host/promptResolvers.js");
  assert.equal(answerPrompt(firstId, "1"), true);
  const firstChoice = await firstPromise;
  assert.equal(firstChoice.kind, "allow_once");

  // Now the second dequeues and can resolve.
  assert.equal(answerPrompt(secondId, "3"), true);
  const secondChoice = await secondPromise;
  assert.equal(secondChoice.kind, "deny");
});

test("launchApprovalDialog: dequeues the prompt regardless of outcome", async () => {
  resetPromptResolvers();
  const dispatcher = makeDispatcher();
  const pending = launchApprovalDialog(dispatcher, sampleRequest, "git push:*");
  await Promise.resolve();
  answerApprovalDialog(dispatcher, "3");
  await pending;
  assert.equal(dispatcher.getState().promptQueue.length, 0);
});

test("launchRecoveryDialog: stub throws not-implemented", async () => {
  const dispatcher = makeDispatcher();
  await assert.rejects(
    launchRecoveryDialog(dispatcher, {
      sessionId: "s",
      turnId: "t",
      reason: "failed",
    }),
    /not implemented/,
  );
});

test("launchSessionPickerDialog: stub throws not-implemented", async () => {
  const dispatcher = makeDispatcher();
  await assert.rejects(
    launchSessionPickerDialog(dispatcher, { purpose: "resume" }),
    /not implemented/,
  );
});
