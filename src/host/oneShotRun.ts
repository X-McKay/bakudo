import { randomUUID } from "node:crypto";

import { buildOneShotReviewEnvelope } from "./copilotFlags.js";
import { emitUserTurnSubmitted } from "./eventLogWriter.js";
import { stdoutWrite } from "./io.js";
import { promptForApproval, requiresSandboxApproval, storageRootFor } from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";
import { printRunSummary, reviewedOutcomeExitCode } from "./printers.js";
import type { ReviewClassification } from "../resultClassifier.js";
import { createAndRunFirstTurn } from "./sessionController.js";

/**
 * Resolve the effective goal for a one-shot invocation. Prefer the explicit
 * `args.goal` (either positional or `--goal`), then fall back to the
 * Copilot-parity `-p`/`--prompt` value that may have been set without a
 * command-line `run` command.
 */
const resolveOneShotGoal = (args: HostCliArgs): string => args.goal ?? args.copilot.prompt ?? "";

/**
 * Emit the one-shot summary as a JSONL review_completed envelope when
 * `--output-format=json` is active. Mirrors the envelope shape the
 * JsonBackend uses so downstream consumers can parse `bakudo -p ...
 * --output-format=json` output with a single JSON-per-line reader.
 */
const emitOneShotJsonSummary = (sessionId: string, reviewed: ReviewClassification): void => {
  stdoutWrite(`${JSON.stringify(buildOneShotReviewEnvelope(sessionId, reviewed))}\n`);
};

/**
 * Non-interactive one-shot: routes through the v2 sessionController
 * pipeline. Extracted from `interactive.ts` (Phase 5 PR11) so that file
 * stays under the 400-line cap now that the JSON summary + Copilot flag
 * plumbing lives here.
 */
export const runNonInteractiveOneShot = async (args: HostCliArgs): Promise<number> => {
  if (requiresSandboxApproval(args) && !args.yes && args.copilot.allowAllTools !== true) {
    const approved = await promptForApproval(
      `Dispatch a ${args.mode} task into an ephemeral abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Dispatch cancelled.\n");
      return 2;
    }
  }
  const sessionId = args.sessionId ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const withSession: HostCliArgs = { ...args, sessionId };
  const storageRoot = storageRootFor(withSession.repo, withSession.storageRoot);
  const goal = resolveOneShotGoal(args);
  await emitUserTurnSubmitted(storageRoot, sessionId, goal, args.mode);
  const result = await createAndRunFirstTurn(goal, withSession);
  if (args.copilot.outputFormat === "json") {
    emitOneShotJsonSummary(result.session.sessionId, result.reviewed);
  } else {
    printRunSummary(result.session, result.reviewed);
  }
  return reviewedOutcomeExitCode(result.reviewed);
};
