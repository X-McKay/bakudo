import { randomUUID } from "node:crypto";

import { buildOneShotReviewEnvelope } from "./copilotFlags.js";
import { classifyError } from "./errors.js";
import {
  createSessionEventLogWriter,
  emitUserTurnSubmitted,
  type JsonEventSink,
} from "./eventLogWriter.js";
import { getBaseStdout, stdoutWrite } from "./io.js";
import { promptForApproval, requiresSandboxApproval, storageRootFor } from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";
import { printRunSummary, reviewedOutcomeExitCode } from "./printers.js";
import { JsonBackend } from "./renderers/jsonBackend.js";
import type { RendererStdout } from "./rendererBackend.js";
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
 * Build a `JsonBackend` bound to the current stdout. Phase 5 PR3: used to
 * tee the session event log to stdout during a `--output-format=json`
 * one-shot run. The backend's `render(frame)` path is a no-op by contract;
 * we only use `emitJsonEnvelope` / `emitJsonError` here.
 */
const createOneShotJsonBackend = (): JsonBackend => {
  const stdout = getBaseStdout() as unknown as RendererStdout;
  return new JsonBackend(stdout);
};

/**
 * Non-interactive one-shot: routes through the v2 sessionController
 * pipeline. Extracted from `interactive.ts` (Phase 5 PR11) so that file
 * stays under the 400-line cap now that the JSON summary + Copilot flag
 * plumbing lives here.
 *
 * Phase 5 PR3: when `--output-format=json` is active, the one-shot path
 * builds a `JsonBackend` tee that fans every session event envelope to
 * stdout as the dispatch unfolds. The terminal stdout line is the
 * `buildOneShotReviewEnvelope` summary on success, or a
 * `JsonBackend.emitJsonError` envelope on dispatch failure.
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
  const useJson = args.copilot.outputFormat === "json";
  const jsonBackend: JsonBackend | undefined = useJson ? createOneShotJsonBackend() : undefined;
  const sink: JsonEventSink | undefined = jsonBackend;

  try {
    // Pre-dispatch pump — tee through the sink so automation callers see
    // the `user.turn_submitted` / `host.turn_queued` lines before any worker
    // envelopes arrive.
    await emitUserTurnSubmitted(storageRoot, sessionId, goal, args.mode, sink);

    const result = await createAndRunFirstTurn(goal, withSession, {
      ...(sink !== undefined
        ? {
            sink,
            eventLogWriterFactory: (sroot, sid) =>
              createSessionEventLogWriter(sroot, sid, { sink }),
          }
        : {}),
    });

    if (useJson) {
      emitOneShotJsonSummary(result.session.sessionId, result.reviewed);
    } else {
      printRunSummary(result.session, result.reviewed);
    }
    return reviewedOutcomeExitCode(result.reviewed);
  } catch (error) {
    // Phase 6 W9: route the throw through the multi-tier classifier so the
    // emitted `{kind:"error"}` line — and the returned exit code — always
    // match the stable error taxonomy in `./errors.ts`.
    const rendered = classifyError(error);
    if (jsonBackend !== undefined) {
      jsonBackend.emitJsonError({
        code: rendered.code,
        message: rendered.message,
        ...(rendered.details !== undefined ? { details: rendered.details } : {}),
      });
      return rendered.exitCode;
    }
    throw error;
  }
};
