import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import type { ArtifactStore } from "../artifactStore.js";
import { createSessionEvent, type SessionEventKind, type TaskResult } from "../protocol.js";
import { createSessionPaths } from "../sessionStore.js";
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

type ArtifactMetadata = Record<string, unknown>;

type ArtifactProvenance = {
  producer?: string;
  phase?: string;
  role?: string;
  sourceRelativePath?: string;
};

const metadataString = (metadata: ArtifactMetadata | undefined, key: string): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const storageExtensionFor = (name: string): string => {
  const rawExtension = extname(name);
  if (rawExtension.length === 0) {
    return "";
  }
  const safeExtension = rawExtension.replace(/[^A-Za-z0-9.]+/gu, "_");
  return safeExtension === "." ? "" : safeExtension;
};

const artifactStorageKeyFor = (name: string): string =>
  `artifact-${Date.now()}-${randomUUID().slice(0, 8)}${storageExtensionFor(name)}`;

const inferArtifactProducer = (kind: ArtifactKind, metadata: ArtifactMetadata | undefined): string =>
  metadataString(metadata, "producer") ??
  metadataString(metadata, "generatedBy") ??
  (kind === "result" || kind === "log" ? "worker" : "host");

const inferArtifactPhase = (
  kind: ArtifactKind,
  name: string,
  metadata: ArtifactMetadata | undefined,
): string =>
  metadataString(metadata, "phase") ??
  (name === "apply-result.json"
    ? "finalize"
    : kind === "dispatch"
      ? "dispatch"
      : kind === "result" || kind === "log"
        ? "execution"
        : "provenance");

const inferArtifactRole = (
  kind: ArtifactKind,
  name: string,
  metadata: ArtifactMetadata | undefined,
): string =>
  metadataString(metadata, "role") ??
  (name === "changed-files.json"
    ? "changed-files"
    : name === "apply-result.json"
      ? "apply-result"
      : kind);

const deriveArtifactProvenance = (
  kind: ArtifactKind,
  name: string,
  metadata: ArtifactMetadata | undefined,
): ArtifactProvenance => {
  const producer = inferArtifactProducer(kind, metadata);
  const phase = inferArtifactPhase(kind, name, metadata);
  const role = inferArtifactRole(kind, name, metadata);
  const sourceRelativePath =
    metadataString(metadata, "sourceRelativePath") ?? metadataString(metadata, "originalPath");
  return {
    ...(producer === undefined ? {} : { producer }),
    ...(phase === undefined ? {} : { phase }),
    ...(role === undefined ? {} : { role }),
    ...(sourceRelativePath === undefined ? {} : { sourceRelativePath }),
  };
};

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
  const storageKey = artifactStorageKeyFor(name);
  const provenance = deriveArtifactProvenance(kind, name, metadata);
  const filePath = join(artifactsDir, storageKey);
  // `--plain-diff` only touches diff-kind artifacts; other kinds pass through.
  const effectiveContents = applyPlainDiffTransform(kind, contents);
  await writeFile(filePath, effectiveContents, "utf8");

  // Legacy JSON-array registry (Phase 1) — absolute path retained for
  // backward compatibility with consumers that still read
  // `artifacts/index.json` directly.
  await artifactStore.registerArtifact({
    artifactId: storageKey,
    sessionId,
    taskId: attemptId,
    kind,
    name,
    storageKey,
    path: filePath,
    ...(provenance.producer === undefined ? {} : { producer: provenance.producer }),
    ...(provenance.phase === undefined ? {} : { phase: provenance.phase }),
    ...(provenance.role === undefined ? {} : { role: provenance.role }),
    ...(provenance.sourceRelativePath === undefined
      ? {}
      : { sourceRelativePath: provenance.sourceRelativePath }),
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
    storageKey,
    path: relativePath,
    createdAt: new Date().toISOString(),
    ...(provenance.producer === undefined ? {} : { producer: provenance.producer }),
    ...(provenance.phase === undefined ? {} : { phase: provenance.phase }),
    ...(provenance.role === undefined ? {} : { role: provenance.role }),
    ...(provenance.sourceRelativePath === undefined
      ? {}
      : { sourceRelativePath: provenance.sourceRelativePath }),
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
        storageKey,
        name: record.name,
        path: record.path,
        ...(record.producer === undefined ? {} : { producer: record.producer }),
        ...(record.phase === undefined ? {} : { phase: record.phase }),
        ...(record.role === undefined ? {} : { role: record.role }),
        ...(record.sourceRelativePath === undefined
          ? {}
          : { sourceRelativePath: record.sourceRelativePath }),
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
    {
      outcome: bundle.reviewedOutcome,
      generatedBy: "worker",
      producer: "worker",
      phase: "execution",
    },
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
    {
      ok: bundle.ok,
      errorCount: bundle.workerErrorCount,
      generatedBy: "worker",
      producer: "worker",
      phase: "execution",
    },
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
    {
      generatedBy: "host.executeAttempt",
      producer: "host.executeAttempt",
      phase: "dispatch",
    },
  );
};
