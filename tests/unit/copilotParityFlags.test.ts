import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState, type HostAppState } from "../../src/host/appState.js";
import {
  AUTOPILOT_CONTINUE_LIMIT_MESSAGE,
  createAutopilotContinueTracker,
  currentAutopilotDepth,
  incrementAutopilotContinue,
  resetAutopilotContinue,
  shouldHaltAutopilot,
} from "../../src/host/autopilotContinueTracker.js";
import {
  applyCopilotSideEffects,
  shouldBufferStream,
  shouldUseJsonOutput,
} from "../../src/host/copilotFlags.js";
import {
  isNoAskUserEnabled,
  launchApprovalDialog,
  noAskUserErrorMessage,
  resetNoAskUser,
  setNoAskUser,
  type ApprovalRequest,
  type DialogDispatcher,
} from "../../src/host/dialogLauncher.js";
import { DEFAULT_MAX_AUTOPILOT_CONTINUES, parseHostArgs } from "../../src/host/parsing.js";
import { resetPromptResolvers } from "../../src/host/promptResolvers.js";
import {
  applyPlainDiffTransform,
  isPlainDiffEnabled,
  resetPlainDiff,
  setPlainDiff,
} from "../../src/host/sessionArtifactWriter.js";
import { selectRendererBackend } from "../../src/host/rendererBackend.js";
import { JsonBackend } from "../../src/host/renderers/jsonBackend.js";

/**
 * Phase 5 PR11 — Copilot-parity flag wiring tests. Each flag in
 * `HostCliArgs.copilot` is exercised at its semantic point:
 *
 * 1. `parseHostArgs` recognizes the argv forms.
 * 2. Side-effect flags (`--no-ask-user`, `--plain-diff`) flip the
 *    module-scoped state via `applyCopilotSideEffects`.
 * 3. `--allow-all-tools` collapses composer mode to autopilot.
 * 4. `--output-format=json` routes through JsonBackend.
 * 5. `--max-autopilot-continues=N` halts after depth N.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseHostArgs: -p <prompt> drives one-shot with no explicit command", () => {
  const args = parseHostArgs(["-p", "echo hello"]);
  assert.equal(args.command, "run");
  assert.equal(args.copilot.prompt, "echo hello");
  // Goal falls back to the prompt so sessionController sees the same text.
  assert.equal(args.goal, "echo hello");
});

test("parseHostArgs: --prompt=<text> also drives one-shot", () => {
  const args = parseHostArgs(["--prompt=ship it"]);
  assert.equal(args.command, "run");
  assert.equal(args.copilot.prompt, "ship it");
  assert.equal(args.goal, "ship it");
});

test("parseHostArgs: --output-format=json and --allow-all-tools parse together", () => {
  const args = parseHostArgs(["run", "echo", "hi", "--output-format=json", "--allow-all-tools"]);
  assert.equal(args.copilot.outputFormat, "json");
  assert.equal(args.copilot.allowAllTools, true);
});

test("parseHostArgs: --stream=off, --plain-diff, --no-ask-user", () => {
  const args = parseHostArgs(["run", "x", "--stream=off", "--plain-diff", "--no-ask-user"]);
  assert.equal(args.copilot.streamOff, true);
  assert.equal(args.copilot.plainDiff, true);
  assert.equal(args.copilot.noAskUser, true);
});

test("parseHostArgs: --max-autopilot-continues=N parses to a positive integer", () => {
  const args = parseHostArgs(["run", "x", "--max-autopilot-continues=3"]);
  assert.equal(args.copilot.maxAutopilotContinues, 3);
});

test("parseHostArgs: --max-autopilot-continues rejects non-positive values", () => {
  assert.throws(
    () => parseHostArgs(["run", "x", "--max-autopilot-continues=0"]),
    /invalid --max-autopilot-continues/,
  );
});

// ---------------------------------------------------------------------------
// applyCopilotSideEffects
// ---------------------------------------------------------------------------

test("applyCopilotSideEffects: --no-ask-user + --plain-diff flip module state and reset", () => {
  resetNoAskUser();
  resetPlainDiff();
  const dispose = applyCopilotSideEffects({ noAskUser: true, plainDiff: true });
  try {
    assert.equal(isNoAskUserEnabled(), true);
    assert.equal(isPlainDiffEnabled(), true);
  } finally {
    dispose();
  }
  assert.equal(isNoAskUserEnabled(), false);
  assert.equal(isPlainDiffEnabled(), false);
});

test("applyCopilotSideEffects: dispose is idempotent and safe with empty flags", () => {
  resetNoAskUser();
  resetPlainDiff();
  const dispose = applyCopilotSideEffects({});
  assert.equal(isNoAskUserEnabled(), false);
  assert.equal(isPlainDiffEnabled(), false);
  dispose();
  dispose();
});

test("shouldUseJsonOutput + shouldBufferStream map from CopilotParityFlags", () => {
  assert.equal(shouldUseJsonOutput({}), false);
  assert.equal(shouldUseJsonOutput({ outputFormat: "json" }), true);
  assert.equal(shouldUseJsonOutput({ outputFormat: "text" }), false);
  assert.equal(shouldBufferStream({}), false);
  assert.equal(shouldBufferStream({ streamOff: true }), true);
});

// ---------------------------------------------------------------------------
// --no-ask-user — launchApprovalDialog throws with the canonical message
// ---------------------------------------------------------------------------

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

test("--no-ask-user: launchApprovalDialog throws with the canonical message", async () => {
  resetPromptResolvers();
  resetNoAskUser();
  setNoAskUser(true);
  try {
    await assert.rejects(
      launchApprovalDialog(makeDispatcher(), sampleRequest, "git push:*"),
      (err: Error) =>
        err.message === noAskUserErrorMessage(sampleRequest.tool, sampleRequest.argument),
    );
  } finally {
    resetNoAskUser();
  }
});

test("--no-ask-user: noAskUserErrorMessage formats the tool/argument", () => {
  assert.equal(
    noAskUserErrorMessage("shell", "rm -rf /"),
    "--no-ask-user: approval required for shell(rm -rf /)",
  );
});

// ---------------------------------------------------------------------------
// --plain-diff — diff artifacts stripped of ANSI; other kinds untouched
// ---------------------------------------------------------------------------

test("--plain-diff: applyPlainDiffTransform strips ANSI from diff-kind artifacts", () => {
  resetPlainDiff();
  setPlainDiff(true);
  try {
    const colored = "\u001B[31m- old\u001B[0m\n\u001B[32m+ new\u001B[0m";
    assert.equal(applyPlainDiffTransform("diff", colored), "- old\n+ new");
    // Non-diff kinds are untouched so logs keep any embedded ANSI.
    assert.equal(applyPlainDiffTransform("log", colored), colored);
  } finally {
    resetPlainDiff();
  }
});

test("--plain-diff: when disabled, diff-kind artifacts pass through unchanged", () => {
  resetPlainDiff();
  const colored = "\u001B[31m- old\u001B[0m";
  assert.equal(applyPlainDiffTransform("diff", colored), colored);
});

// ---------------------------------------------------------------------------
// --output-format=json — selectRendererBackend returns the JsonBackend
// ---------------------------------------------------------------------------

test("--output-format=json: selectRendererBackend returns JsonBackend", () => {
  const chunks: string[] = [];
  const backend = selectRendererBackend({
    useJson: true,
    stdout: {
      isTTY: true,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  });
  assert.ok(backend instanceof JsonBackend, "expected JsonBackend when useJson is true");
});

// ---------------------------------------------------------------------------
// --allow-all-tools — composer-mode collapse
// ---------------------------------------------------------------------------

test("--allow-all-tools: parse sets allowAllTools and does not throw", () => {
  const args = parseHostArgs(["build", "x", "--allow-all-tools"]);
  assert.equal(args.copilot.allowAllTools, true);
  // `--yes` is NOT implied at parse time — the collapse happens in
  // `resolveAutoApprove` inside sessionController. Confirming here that
  // parsing stays orthogonal.
  assert.equal(args.yes, false);
});

// ---------------------------------------------------------------------------
// --max-autopilot-continues — tracker semantics
// ---------------------------------------------------------------------------

test("autopilotContinueTracker: default cap is 10 when flag is absent", () => {
  const tracker = createAutopilotContinueTracker(undefined);
  assert.equal(tracker.cap, DEFAULT_MAX_AUTOPILOT_CONTINUES);
});

test("autopilotContinueTracker: halts after depth exceeds N", () => {
  const tracker = createAutopilotContinueTracker(3);
  const sessionId = "session-autopilot-1";
  // First 3 increments stay under the cap.
  for (let i = 1; i <= 3; i += 1) {
    incrementAutopilotContinue(tracker, sessionId);
    assert.equal(shouldHaltAutopilot(tracker, sessionId, true), null, `depth ${i} should proceed`);
  }
  // Fourth increment exceeds the cap: halt with the canonical message.
  incrementAutopilotContinue(tracker, sessionId);
  const decision = shouldHaltAutopilot(tracker, sessionId, true);
  assert.deepEqual(decision, { halt: true, message: AUTOPILOT_CONTINUE_LIMIT_MESSAGE });
});

test("autopilotContinueTracker: only gates when autopilot is engaged", () => {
  const tracker = createAutopilotContinueTracker(1);
  const sessionId = "session-standard";
  incrementAutopilotContinue(tracker, sessionId);
  incrementAutopilotContinue(tracker, sessionId);
  // Even though depth > cap, autopilot is off so no halt.
  assert.equal(shouldHaltAutopilot(tracker, sessionId, false), null);
  // Flipping on reveals the cap.
  assert.deepEqual(shouldHaltAutopilot(tracker, sessionId, true), {
    halt: true,
    message: AUTOPILOT_CONTINUE_LIMIT_MESSAGE,
  });
});

test("autopilotContinueTracker: resetAutopilotContinue clears the per-session counter", () => {
  const tracker = createAutopilotContinueTracker(2);
  const sessionId = "session-reset";
  incrementAutopilotContinue(tracker, sessionId);
  incrementAutopilotContinue(tracker, sessionId);
  incrementAutopilotContinue(tracker, sessionId);
  assert.equal(currentAutopilotDepth(tracker, sessionId), 3);
  resetAutopilotContinue(tracker, sessionId);
  assert.equal(currentAutopilotDepth(tracker, sessionId), 0);
  assert.equal(shouldHaltAutopilot(tracker, sessionId, true), null);
});

test("autopilotContinueTracker: non-positive cap falls back to the default", () => {
  const tracker = createAutopilotContinueTracker(0);
  assert.equal(tracker.cap, DEFAULT_MAX_AUTOPILOT_CONTINUES);
});
