import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ArtifactStore } from "../artifactStore.js";
import type { ReviewClassification } from "../resultClassifier.js";
import { createReviewId } from "../sessionNormalize.js";
import type {
  CandidateRecord,
  SessionAttemptRecord,
  SessionRecord,
  SessionReviewOutcome,
  SessionStatus,
  SessionTurnRecord,
  TurnStatus,
} from "../sessionTypes.js";
import type { SessionStore } from "../sessionStore.js";
import { sessionStatusFromReview, turnStatusFromReview } from "./sessionRunSupport.js";
import { writeApplyJsonArtifact, type ApplyArtifactContext } from "./applyArtifacts.js";

const nowIso = (): string => new Date().toISOString();

export const APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME = "apply-writeback-journal.json";
export const APPLY_RECOVERY_ARTIFACT_NAME = "apply-recovery.json";
export const APPLY_RECOVERY_SCHEMA_VERSION = 1 as const;

type SnapshotLike =
  | { kind: "missing" }
  | { kind: "text"; content: string }
  | { kind: "binary"; data: Buffer }
  | { kind: "symlink"; target: string }
  | { kind: "submodule"; oid: string }
  | { kind: "directory" };

export type SerializedApplySnapshot =
  | { kind: "missing" }
  | { kind: "text"; content: string }
  | { kind: "binary"; dataBase64: string }
  | { kind: "symlink"; target: string }
  | { kind: "submodule"; oid: string }
  | { kind: "directory" };

export type ApplyWritebackJournalEntry = {
  path: string;
  before: SerializedApplySnapshot;
  after: SerializedApplySnapshot;
};

export type ApplyWritebackJournal = {
  schemaVersion: typeof APPLY_RECOVERY_SCHEMA_VERSION;
  createdAt: string;
  entries: ApplyWritebackJournalEntry[];
};

type TailAttemptRef = {
  session: SessionRecord;
  turn: SessionTurnRecord;
  attempt: SessionAttemptRecord;
};

const resolveWithinRoot = (root: string, relativePath: string): string => {
  const resolvedRoot = resolve(root);
  const absolutePath = resolve(resolvedRoot, relativePath);
  if (absolutePath === resolvedRoot || absolutePath.startsWith(`${resolvedRoot}/`)) {
    return absolutePath;
  }
  throw new Error(`Refusing to access path outside repo root: ${relativePath}`);
};

const lstatOrNull = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const readFsSnapshot = async (root: string, relativePath: string): Promise<SnapshotLike> => {
  const absolutePath = resolveWithinRoot(root, relativePath);
  const stats = await lstatOrNull(absolutePath);
  if (stats === null) {
    return { kind: "missing" };
  }
  if (stats.isDirectory()) {
    return { kind: "directory" };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "symlink", target: await readlink(absolutePath, "utf8") };
  }
  if (!stats.isFile()) {
    return { kind: "directory" };
  }
  const contents = await readFile(absolutePath);
  if (contents.includes(0)) {
    return { kind: "binary", data: contents };
  }
  return { kind: "text", content: contents.toString("utf8") };
};

const writeSnapshot = async (
  root: string,
  relativePath: string,
  snapshot: SnapshotLike,
): Promise<void> => {
  const absolutePath = resolveWithinRoot(root, relativePath);
  if (snapshot.kind === "missing") {
    await rm(absolutePath, { recursive: true, force: true });
    return;
  }
  if (snapshot.kind === "directory" || snapshot.kind === "submodule") {
    throw new Error(`cannot write unsupported snapshot ${snapshot.kind} at ${relativePath}`);
  }
  await rm(absolutePath, { recursive: true, force: true });
  await mkdir(dirname(absolutePath), { recursive: true });
  if (snapshot.kind === "symlink") {
    await symlink(snapshot.target, absolutePath);
    return;
  }
  if (snapshot.kind === "binary") {
    await writeFile(absolutePath, snapshot.data);
    return;
  }
  await writeFile(absolutePath, snapshot.content, "utf8");
};

const snapshotEquals = (left: SnapshotLike, right: SnapshotLike): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "missing":
    case "directory":
      return true;
    case "text":
      return left.content === (right as Extract<SnapshotLike, { kind: "text" }>).content;
    case "binary":
      return left.data.equals((right as Extract<SnapshotLike, { kind: "binary" }>).data);
    case "symlink":
      return left.target === (right as Extract<SnapshotLike, { kind: "symlink" }>).target;
    case "submodule":
      return left.oid === (right as Extract<SnapshotLike, { kind: "submodule" }>).oid;
  }
};

const snapshotSummary = (snapshot: SnapshotLike): string => {
  switch (snapshot.kind) {
    case "missing":
      return "missing";
    case "directory":
      return "directory";
    case "text":
      return `text:${snapshot.content.length}`;
    case "binary":
      return `binary:${snapshot.data.length}`;
    case "symlink":
      return `symlink:${snapshot.target}`;
    case "submodule":
      return `submodule:${snapshot.oid}`;
  }
};

export const serializeApplySnapshot = (snapshot: SnapshotLike): SerializedApplySnapshot => {
  switch (snapshot.kind) {
    case "missing":
    case "directory":
      return snapshot;
    case "text":
      return { kind: "text", content: snapshot.content };
    case "binary":
      return { kind: "binary", dataBase64: snapshot.data.toString("base64") };
    case "symlink":
      return { kind: "symlink", target: snapshot.target };
    case "submodule":
      return { kind: "submodule", oid: snapshot.oid };
  }
};

const deserializeApplySnapshot = (snapshot: SerializedApplySnapshot): SnapshotLike => {
  switch (snapshot.kind) {
    case "missing":
    case "directory":
      return snapshot;
    case "text":
      return { kind: "text", content: snapshot.content };
    case "binary":
      return { kind: "binary", data: Buffer.from(snapshot.dataBase64, "base64") };
    case "symlink":
      return { kind: "symlink", target: snapshot.target };
    case "submodule":
      return { kind: "submodule", oid: snapshot.oid };
  }
};

const isSerializedSnapshot = (value: unknown): value is SerializedApplySnapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "missing":
    case "directory":
      return true;
    case "text":
      return typeof record.content === "string";
    case "binary":
      return typeof record.dataBase64 === "string";
    case "symlink":
      return typeof record.target === "string";
    case "submodule":
      return typeof record.oid === "string";
    default:
      return false;
  }
};

const parseWritebackJournal = (raw: string): ApplyWritebackJournal | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== APPLY_RECOVERY_SCHEMA_VERSION) {
    return null;
  }
  if (typeof record.createdAt !== "string" || !Array.isArray(record.entries)) {
    return null;
  }
  const entries: ApplyWritebackJournalEntry[] = [];
  for (const entry of record.entries) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.path !== "string" ||
      !isSerializedSnapshot(candidate.before) ||
      !isSerializedSnapshot(candidate.after)
    ) {
      return null;
    }
    entries.push({
      path: candidate.path,
      before: candidate.before,
      after: candidate.after,
    });
  }
  return {
    schemaVersion: APPLY_RECOVERY_SCHEMA_VERSION,
    createdAt: record.createdAt,
    entries,
  };
};

const latestAttempt = (session: SessionRecord): TailAttemptRef | null => {
  const turn = session.turns.at(-1);
  const attempt = turn?.attempts.at(-1);
  if (turn === undefined || attempt === undefined) {
    return null;
  }
  return { session, turn, attempt };
};

const updatedCandidateForFailure = (args: {
  attempt: SessionAttemptRecord;
  recordedAt: string;
  message: string;
}): CandidateRecord => ({
  ...(args.attempt.candidate ?? { state: "apply_failed", updatedAt: args.recordedAt }),
  state: "apply_failed",
  updatedAt: args.recordedAt,
  failureAt: args.recordedAt,
  applyError: args.message,
});

const persistRecoveredAttempt = async (args: {
  store: SessionStore;
  session: SessionRecord;
  turn: SessionTurnRecord;
  attempt: SessionAttemptRecord;
  message: string;
}): Promise<void> => {
  const recordedAt = nowIso();
  const reviewOutcome: SessionReviewOutcome = "retryable_failure";
  const reviewed: ReviewClassification = {
    outcome: reviewOutcome,
    action: "retry",
    reason: args.message,
    retryable: true,
    needsUser: false,
    confidence: "low",
  };
  const review = {
    reviewId: createReviewId(),
    attemptId: args.attempt.attemptId,
    outcome: reviewOutcome,
    action: "retry" as const,
    reason: args.message,
    reviewedAt: recordedAt,
  };
  const updatedAttempt: SessionAttemptRecord = {
    ...args.attempt,
    status: "failed",
    lastMessage: args.message,
    reviewRecord: review,
    candidateState: "apply_failed",
    candidate: updatedCandidateForFailure({
      attempt: args.attempt,
      recordedAt,
      message: args.message,
    }),
  };
  const nextTurnStatus: TurnStatus = turnStatusFromReview(reviewed, "apply_failed");
  const nextSessionStatus: SessionStatus = sessionStatusFromReview(reviewed, "apply_failed");
  const turns = args.session.turns.map((turn) =>
    turn.turnId === args.turn.turnId
      ? {
          ...turn,
          status: nextTurnStatus,
          attempts: turn.attempts.map((attempt) =>
            attempt.attemptId === args.attempt.attemptId ? updatedAttempt : attempt,
          ),
          latestReview: review,
          updatedAt: recordedAt,
        }
      : turn,
  );
  await args.store.saveSession({
    ...args.session,
    status: nextSessionStatus,
    turns,
    updatedAt: recordedAt,
  });
};

const loadLatestWritebackJournal = async (
  artifactStore: ArtifactStore,
  sessionId: string,
  attemptId: string,
): Promise<ApplyWritebackJournal | null> => {
  const artifacts = await artifactStore.listTaskArtifacts(sessionId, attemptId);
  const artifact = [...artifacts]
    .reverse()
    .find((entry) => entry.name === APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME);
  if (artifact === undefined) {
    return null;
  }
  const raw = await readFile(artifact.path, "utf8");
  return parseWritebackJournal(raw);
};

const writeRecoveryArtifact = async (args: {
  artifactStore: ArtifactStore;
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  payload: Record<string, unknown>;
}): Promise<void> => {
  const context: ApplyArtifactContext = {
    artifactStore: args.artifactStore,
    storageRoot: args.storageRoot,
    sessionId: args.sessionId,
    turnId: args.turnId,
    attemptId: args.attemptId,
  };
  await writeApplyJsonArtifact(
    context,
    APPLY_RECOVERY_ARTIFACT_NAME,
    {
      schemaVersion: APPLY_RECOVERY_SCHEMA_VERSION,
      ...args.payload,
    },
    "apply-recovery",
  );
};

export const recoverInterruptedApplyIfNeeded = async (args: {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  storageRoot: string;
  sessionId: string;
}): Promise<boolean> => {
  const session = await args.sessionStore.loadSession(args.sessionId);
  if (session === null) {
    return false;
  }
  const tail = latestAttempt(session);
  if (tail === null) {
    return false;
  }
  const { turn, attempt } = tail;
  const candidateState = attempt.candidateState ?? attempt.candidate?.state;
  if (
    candidateState !== "apply_staging" &&
    candidateState !== "apply_verifying" &&
    candidateState !== "apply_writeback"
  ) {
    return false;
  }

  if (candidateState !== "apply_writeback") {
    const message = `candidate apply was interrupted during ${candidateState}; preserved candidate kept for retry`;
    await writeRecoveryArtifact({
      artifactStore: args.artifactStore,
      storageRoot: args.storageRoot,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      payload: {
        recoveredAt: nowIso(),
        previousState: candidateState,
        restoredPaths: [],
        message,
      },
    });
    await persistRecoveredAttempt({
      store: args.sessionStore,
      session,
      turn,
      attempt,
      message,
    });
    return true;
  }

  const journal = await loadLatestWritebackJournal(
    args.artifactStore,
    session.sessionId,
    attempt.attemptId,
  );
  if (journal === null) {
    const message =
      "candidate apply was interrupted during apply_writeback and no recovery journal was found; inspect the source checkout before retrying";
    await writeRecoveryArtifact({
      artifactStore: args.artifactStore,
      storageRoot: args.storageRoot,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      payload: {
        recoveredAt: nowIso(),
        previousState: candidateState,
        restoredPaths: [],
        message,
      },
    });
    await persistRecoveredAttempt({
      store: args.sessionStore,
      session,
      turn,
      attempt,
      message,
    });
    return true;
  }

  const unsafePaths: Array<{ path: string; current: string; before: string; after: string }> = [];
  for (const entry of journal.entries) {
    const current = await readFsSnapshot(session.repoRoot, entry.path);
    const before = deserializeApplySnapshot(entry.before);
    const after = deserializeApplySnapshot(entry.after);
    if (
      snapshotEquals(current, before) ||
      snapshotEquals(current, after) ||
      current.kind === "missing"
    ) {
      continue;
    }
    unsafePaths.push({
      path: entry.path,
      current: snapshotSummary(current),
      before: snapshotSummary(before),
      after: snapshotSummary(after),
    });
  }

  if (unsafePaths.length > 0) {
    const message = `candidate apply was interrupted during apply_writeback and source paths changed after the crash: ${unsafePaths
      .map((entry) => entry.path)
      .join(", ")}`;
    await writeRecoveryArtifact({
      artifactStore: args.artifactStore,
      storageRoot: args.storageRoot,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      attemptId: attempt.attemptId,
      payload: {
        recoveredAt: nowIso(),
        previousState: candidateState,
        restoredPaths: [],
        unsafePaths,
        message,
      },
    });
    await persistRecoveredAttempt({
      store: args.sessionStore,
      session,
      turn,
      attempt,
      message,
    });
    return true;
  }

  const restoredPaths: string[] = [];
  for (const entry of journal.entries) {
    await writeSnapshot(session.repoRoot, entry.path, deserializeApplySnapshot(entry.before));
    restoredPaths.push(entry.path);
  }

  const message =
    restoredPaths.length === 0
      ? "candidate apply was interrupted during apply_writeback; nothing needed restoration and the preserved candidate was kept for retry"
      : `candidate apply was interrupted during apply_writeback; restored ${restoredPaths.length} source path${restoredPaths.length === 1 ? "" : "s"} from the recovery journal and kept the preserved candidate for retry`;
  await writeRecoveryArtifact({
    artifactStore: args.artifactStore,
    storageRoot: args.storageRoot,
    sessionId: session.sessionId,
    turnId: turn.turnId,
    attemptId: attempt.attemptId,
    payload: {
      recoveredAt: nowIso(),
      previousState: candidateState,
      restoredPaths,
      message,
    },
  });
  await persistRecoveredAttempt({
    store: args.sessionStore,
    session,
    turn,
    attempt,
    message,
  });
  return true;
};
