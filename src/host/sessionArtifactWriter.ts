import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ArtifactStore } from "../artifactStore.js";
import { createSessionEvent, type SessionEventKind, type TaskResult } from "../protocol.js";
import { createSessionPaths, sanitizePathSegment } from "../sessionStore.js";
import type { SessionReviewAction, SessionReviewOutcome } from "../sessionTypes.js";
import { stripAnsi } from "./ansi.js";
import {
  ARTIFACT_RECORD_SCHEMA_VERSION,
  type ArtifactKind,
  type ArtifactRecord,
  artifactIdFor,
} from "./artifactStore.js";
import { emitSessionEvent } from "./eventLogWriter.js";

/**
 * Module-scoped flag backing the `--plain-diff` CLI option (Phase 5 PR11).
 * When `true`, diff-kind artifacts are stripped of ANSI escape sequences
 * before persistence so downstream copies (e.g. `bakudo review --json`)
 * produce clean plain text. Reset between one-shot invocations with
 * {@link resetPlainDiff}.
 */
let plainDiffEnabled = false;

export const setPlainDiff = (enabled: boolean): void => {
  plainDiffEnabled = enabled;
};

export const isPlainDiffEnabled = (): boolean => plainDiffEnabled;

export const resetPlainDiff = (): void => {
  plainDiffEnabled = false;
};

/**
 * Apply the `--plain-diff` transformation when (a) the flag is active and
 * (b) the artifact kind is `"diff"`. Other kinds pass through unchanged.
 * Extracted as a pure helper so unit tests can assert on the text shape
 * without touching the filesystem.
 */
export const applyPlainDiffTransform = (kind: ArtifactKind, contents: string): string =>
  plainDiffEnabled && kind === "diff" ? stripAnsi(contents) : contents;

/**
 * Persist a single artifact file alongside (1) the legacy JSON-array
 * registry (`artifactStore.registerArtifact`) and (2) the v2 append-only
 * NDJSON log (`artifactStore.ts` host-side). After both writes succeed we
 * emit a `host.artifact_registered` envelope on the session event log so
 * downstream projectors/hooks can react to the registration.
 *
 * The v2 record's `path` is stored relative to `<storageRoot>/<sessionId>/`
 * so the event log stays portable even when the parent sessions root
 * moves.
 */
export const writeSessionArtifact = async (
  artifactStore: ArtifactStore,
  storageRoot: string,
  sessionId: string,
  turnId: string,
  attemptId: string,
  name: string,
  contents: string,
  kind: ArtifactKind,
  metadata?: Record<string, unknown>,
): Promise<void> => {
  const artifactsDir = artifactStore.artifactDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const safeName = `${sanitizePathSegment(attemptId)}-${name}`;
  const filePath = join(artifactsDir, safeName);
  // `--plain-diff` only touches diff-kind artifacts; other kinds pass through.
  const effectiveContents = applyPlainDiffTransform(kind, contents);
  await writeFile(filePath, effectiveContents, "utf8");

  // Legacy JSON-array registry (Phase 1) — absolute path retained for
  // backward compatibility with consumers that still read
  // `artifacts/index.json` directly.
  await artifactStore.registerArtifact({
    artifactId: `${attemptId}:${name}`,
    sessionId,
    taskId: attemptId,
    kind,
    name,
    path: filePath,
    ...(metadata === undefined ? {} : { metadata }),
  });

  // v2 append-only NDJSON record.
  const { sessionDir } = createSessionPaths(storageRoot, sessionId);
  const relativePath = relative(sessionDir, filePath);
  const record: ArtifactRecord = {
    schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
    artifactId: artifactIdFor(),
    sessionId,
    turnId,
    attemptId,
    kind,
    name,
    path: relativePath,
    createdAt: new Date().toISOString(),
    ...(metadata === undefined ? {} : { metadata }),
  };
  // Wave 6c PR7 review-fix B1: route through the store method so the
  // v2 NDJSON write sees the effective (merged) redaction policy. Calling
  // the free function directly with positional args silently defaults to
  // `DEFAULT_REDACTION_POLICY` and drops config-cascade extras.
  await artifactStore.appendArtifactRecord(sessionId, record);

  // Fire-and-forget short-lived envelope write (same pattern as the
  // pre-dispatch emitters).
  const kindKey: SessionEventKind = "host.artifact_registered";
  await emitSessionEvent(
    storageRoot,
    sessionId,
    createSessionEvent({
      kind: kindKey,
      sessionId,
      turnId,
      attemptId,
      actor: "host",
      payload: {
        artifactId: record.artifactId,
        kind: record.kind,
        name: record.name,
        path: record.path,
        turnId,
        ...(attemptId === undefined ? {} : { attemptId }),
      },
    }),
  );
};

export type ExecutionArtifactBundle = {
  artifactStore: ArtifactStore;
  storageRoot: string;
  sessionId: string;
  turnId: string;
  taskId: string;
  result: TaskResult;
  rawOutput: string;
  ok: boolean;
  workerErrorCount: number;
  sandboxTaskId: unknown;
  aboxCommand: unknown;
  reviewedOutcome: SessionReviewOutcome;
  reviewedAction: SessionReviewAction;
};

export const writeExecutionArtifacts = async (bundle: ExecutionArtifactBundle): Promise<void> => {
  await writeSessionArtifact(
    bundle.artifactStore,
    bundle.storageRoot,
    bundle.sessionId,
    bundle.turnId,
    bundle.taskId,
    "result.json",
    `${JSON.stringify(bundle.result, null, 2)}\n`,
    "result",
    { outcome: bundle.reviewedOutcome },
  );
  await writeSessionArtifact(
    bundle.artifactStore,
    bundle.storageRoot,
    bundle.sessionId,
    bundle.turnId,
    bundle.taskId,
    "worker-output.log",
    `${bundle.rawOutput}\n`,
    "log",
    { ok: bundle.ok, errorCount: bundle.workerErrorCount },
  );
  await writeSessionArtifact(
    bundle.artifactStore,
    bundle.storageRoot,
    bundle.sessionId,
    bundle.turnId,
    bundle.taskId,
    "dispatch.json",
    `${JSON.stringify(
      {
        sandboxTaskId: bundle.sandboxTaskId,
        aboxCommand: bundle.aboxCommand,
        reviewedOutcome: bundle.reviewedOutcome,
        reviewedAction: bundle.reviewedAction,
      },
      null,
      2,
    )}\n`,
    "dispatch",
  );
};
