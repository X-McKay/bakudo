import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import type { ABoxTaskRunner, TaskExecutionRecord } from "../aboxTaskRunner.js";
import type { ArtifactStore } from "../artifactStore.js";
import type { AttemptExecutionResult, AttemptSpec } from "../attemptProtocol.js";
import type { SessionStore } from "../sessionStore.js";
import type {
  ApplyDispatchRecord,
  ApplyResolutionRecord,
  CandidateRecord,
  CandidateState,
  SessionAttemptRecord,
  SessionRecord,
  SourceBaselineRecord,
} from "../sessionTypes.js";
import { discardSandbox } from "./sandboxCleanup.js";
import { buildApplyDispatchPlan } from "./applyDispatch.js";
import {
  APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME,
  serializeApplySnapshot,
} from "./applyRecovery.js";
import {
  writeApplyJsonArtifact,
  writeApplyPatchArtifact,
  type ApplyArtifactContext,
} from "./applyArtifacts.js";
import {
  type ApplyConflictClass,
  type ApplyConflictDecision,
  type ApplyConflictClassification,
} from "./conflictPolicy.js";
import {
  ApplyWorkspaceUnsupportedSurfaceError,
  createApplyWorkspace,
} from "./applyWorkspace.js";
import { describeCandidateManifest } from "./candidateManifest.js";
import {
  artifactNamesForResolutionPath,
  buildApplyResolvePrompt,
  classifyConflictResolutionEligibility,
  parseApplyResolveResult,
  resolveApplyResultPath,
  resolutionSummaryFor,
  type EligibleTextConflict,
} from "./conflictResolution.js";
import { evaluateApplyDrift } from "./sourceBaseline.js";
import { inspectWorktree, type WorktreeInspection } from "./worktreeInspector.js";
import {
  reconcileFile,
  type ReconciledFileResult,
} from "./reconcileFiles.js";
import { writeSessionArtifact } from "./sessionArtifactWriter.js";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 10_000_000;

type PathSnapshot =
  | { kind: "missing" }
  | { kind: "text"; content: string }
  | { kind: "binary"; data: Buffer }
  | { kind: "symlink"; target: string }
  | { kind: "submodule"; oid: string }
  | { kind: "directory" };

export type ApplyConflictRecord = {
  path: string;
  class: ApplyConflictClass;
  decision: ApplyConflictDecision;
  reason: string;
  detail: string;
};

type PendingTextConflict = {
  conflict: ApplyConflictRecord;
  baseContent: string;
  candidateContent: string;
  sourceContent: string;
};

export type CandidateApplyResult = {
  candidateState: CandidateState;
  message: string;
  inspection: WorktreeInspection;
  candidateUpdates: Partial<CandidateRecord>;
  applyResult: {
    applied?: boolean;
    discarded?: boolean;
    error?: string;
    needsConfirmation?: boolean;
    confirmationReason?: string;
  };
};

export type ApplyPreservedCandidateInput = {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  runner: ABoxTaskRunner;
  storageRoot: string;
  session: SessionRecord;
  turnId: string;
  attempt: SessionAttemptRecord;
  attemptSpec: AttemptSpec;
  aboxBin: string;
  explicitConfirmation: boolean;
  sourceBaseline: SourceBaselineRecord;
  inspection?: WorktreeInspection;
  expectedFingerprint?: string;
};

const nowIso = (): string => new Date().toISOString();

const comparePath = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
};

const gitStdout = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
};

const gitBuffer = async (cwd: string, args: string[]): Promise<Buffer> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
};

const hashBuffer = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

const isBinaryBuffer = (buffer: Buffer): boolean => buffer.includes(0);

const resolveWithinRoot = (root: string, relativePath: string): string => {
  const resolvedRoot = resolve(root);
  const absolutePath = resolve(resolvedRoot, relativePath);
  if (absolutePath === resolvedRoot || absolutePath.startsWith(`${resolvedRoot}/`)) {
    return absolutePath;
  }
  throw new Error(`Refusing to access path outside repo root: ${relativePath}`);
};

const snapshotKind = (snapshot: PathSnapshot): string => snapshot.kind;

const snapshotEquals = (left: PathSnapshot, right: PathSnapshot): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "missing":
    case "directory":
      return true;
    case "text":
      return left.content === (right as Extract<PathSnapshot, { kind: "text" }>).content;
    case "binary":
      return (
        hashBuffer(left.data) === hashBuffer((right as Extract<PathSnapshot, { kind: "binary" }>).data)
      );
    case "symlink":
      return left.target === (right as Extract<PathSnapshot, { kind: "symlink" }>).target;
    case "submodule":
      return left.oid === (right as Extract<PathSnapshot, { kind: "submodule" }>).oid;
  }
};

const summarizeSnapshot = (snapshot: PathSnapshot): string => {
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

const identifierFragmentForPath = (path: string): string => {
  const sanitized = path
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 32);
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `${sanitized || "path"}-${digest}`;
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

const readFsSnapshot = async (root: string, relativePath: string): Promise<PathSnapshot> => {
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
  if (isBinaryBuffer(contents)) {
    return { kind: "binary", data: contents };
  }
  return { kind: "text", content: contents.toString("utf8") };
};

const readGitSnapshot = async (
  repoRoot: string,
  rev: string,
  relativePath: string,
): Promise<PathSnapshot> => {
  const tree = (await gitStdout(repoRoot, ["ls-tree", rev, "--", relativePath])).trim();
  if (tree.length === 0) {
    return { kind: "missing" };
  }
  const [left, pathPart] = tree.split("\t");
  if (!left || pathPart === undefined) {
    return { kind: "missing" };
  }
  const [mode, type, oid] = left.split(/\s+/u);
  if (mode === "040000" || type === "tree") {
    return { kind: "directory" };
  }
  if (mode === "160000" || type === "commit") {
    return { kind: "submodule", oid: oid ?? "" };
  }
  if (mode === "120000") {
    const target = (await gitBuffer(repoRoot, ["cat-file", "-p", oid ?? ""])).toString("utf8");
    return { kind: "symlink", target };
  }
  const contents = await gitBuffer(repoRoot, ["cat-file", "-p", oid ?? ""]);
  if (isBinaryBuffer(contents)) {
    return { kind: "binary", data: contents };
  }
  return { kind: "text", content: contents.toString("utf8") };
};

const removePath = async (root: string, relativePath: string): Promise<void> => {
  await rm(resolveWithinRoot(root, relativePath), { recursive: true, force: true });
};

const writeSnapshot = async (
  root: string,
  relativePath: string,
  snapshot: PathSnapshot,
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

const appendNoIndexDiff = async (
  parts: string[],
  leftPath: string,
  rightPath: string,
): Promise<void> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--binary", "--no-index", "--", leftPath, rightPath],
      { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER },
    );
    if (stdout.length > 0) {
      parts.push(stdout);
    }
  } catch (error) {
    const err = error as { code?: number; stdout?: string };
    if ((err.code === 1 || err.code === undefined) && typeof err.stdout === "string") {
      if (err.stdout.length > 0) {
        parts.push(err.stdout);
      }
      return;
    }
    throw error;
  }
};

const diffRootsForPaths = async (
  leftRoot: string,
  rightRoot: string,
  paths: readonly string[],
): Promise<string> => {
  const parts: string[] = [];
  for (const relativePath of [...paths].sort(comparePath)) {
    const leftSnapshot = await readFsSnapshot(leftRoot, relativePath);
    const rightSnapshot = await readFsSnapshot(rightRoot, relativePath);
    if (snapshotEquals(leftSnapshot, rightSnapshot)) {
      continue;
    }
    const leftPath =
      leftSnapshot.kind === "missing" ? "/dev/null" : resolveWithinRoot(leftRoot, relativePath);
    const rightPath =
      rightSnapshot.kind === "missing" ? "/dev/null" : resolveWithinRoot(rightRoot, relativePath);
    await appendNoIndexDiff(parts, leftPath, rightPath);
  }
  return parts.join("");
};

const toExecutionResult = (
  spec: AttemptSpec,
  execution: TaskExecutionRecord,
): AttemptExecutionResult => ({
  schemaVersion: 3,
  attemptId: spec.attemptId,
  taskKind: spec.taskKind,
  status: execution.result.status === "succeeded" ? "succeeded" : "failed",
  summary: execution.result.summary,
  exitCode: execution.result.exitCode,
  startedAt: execution.result.startedAt ?? execution.result.finishedAt,
  finishedAt: execution.result.finishedAt,
  durationMs: execution.result.durationMs ?? 0,
  artifacts: execution.result.artifacts ?? [],
});

const loadAttemptOrThrow = async (
  store: SessionStore,
  sessionId: string,
  turnId: string,
  attemptId: string,
): Promise<SessionAttemptRecord> => {
  const session = await store.loadSession(sessionId);
  if (session === null) {
    throw new Error(`unknown session ${sessionId}`);
  }
  const turn = session.turns.find((entry) => entry.turnId === turnId);
  if (turn === undefined) {
    throw new Error(`unknown turn ${turnId}`);
  }
  const attempt = turn.attempts.find((entry) => entry.attemptId === attemptId);
  if (attempt === undefined) {
    throw new Error(`unknown attempt ${attemptId}`);
  }
  return attempt;
};

const writeApplyLogArtifact = async (
  context: ApplyArtifactContext,
  name: string,
  contents: string,
  role: string,
  metadata?: Record<string, unknown>,
): Promise<string> => {
  await writeSessionArtifact(
    context.artifactStore,
    context.storageRoot,
    context.sessionId,
    context.turnId,
    context.attemptId,
    name,
    contents,
    "log",
    {
      generatedBy: "host.candidateApplier",
      producer: "host.candidateApplier",
      phase: "apply",
      role,
      ...(metadata ?? {}),
    },
  );
  return name;
};

const persistCandidateAttemptState = async (args: {
  store: SessionStore;
  sessionId: string;
  turnId: string;
  attemptId: string;
  state: CandidateState;
  message: string;
  candidateUpdates: Partial<CandidateRecord>;
}): Promise<void> => {
  const attempt = await loadAttemptOrThrow(args.store, args.sessionId, args.turnId, args.attemptId);
  await args.store.upsertAttempt(args.sessionId, args.turnId, {
    ...attempt,
    status:
      args.state === "needs_confirmation"
        ? "blocked"
        : args.state === "apply_failed"
          ? "failed"
          : args.state === "applied"
            ? "succeeded"
            : "needs_review",
    lastMessage: args.message,
    candidateState: args.state,
    candidate: {
      ...(attempt.candidate ?? { state: args.state }),
      ...args.candidateUpdates,
      state: args.state,
      updatedAt: nowIso(),
    },
  });
};

const applyDispatchRecordFor = (args: {
  kind: ApplyDispatchRecord["kind"];
  attemptId: string;
  taskId: string;
  command?: string[];
  status: ApplyDispatchRecord["status"];
  artifacts?: string[];
  error?: string;
}): ApplyDispatchRecord => ({
  kind: args.kind,
  attemptId: args.attemptId,
  taskId: args.taskId,
  ...(args.command === undefined ? {} : { command: args.command }),
  status: args.status,
  recordedAt: nowIso(),
  ...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
  ...(args.error === undefined ? {} : { error: args.error }),
});

const conflictRecordFor = (args: {
  path: string;
  classification: ApplyConflictClassification;
  detail: string;
}): ApplyConflictRecord => ({
  path: args.path,
  class: args.classification.class,
  decision: args.classification.decision,
  reason: args.classification.reason,
  detail: args.detail,
});

const unsupportedConflictFor = (args: {
  path: string;
  class: ApplyConflictClass;
  reason: string;
  detail: string;
  decision?: ApplyConflictDecision;
}): ApplyConflictRecord => ({
  path: args.path,
  class: args.class,
  decision: args.decision ?? "needs_confirmation",
  reason: args.reason,
  detail: args.detail,
});

const materializeResolvedSnapshot = (result: ReconciledFileResult): PathSnapshot => {
  const content = result.content;
  if (content === null) {
    return { kind: "missing" };
  }
  return { kind: "text", content };
};

const stagePathResolution = async (args: {
  sourceRoot: string;
  candidateRoot: string;
  workspaceRoot: string;
  baselineHeadSha: string;
  path: string;
  explicitConfirmation: boolean;
}): Promise<{
  resolved?: ReconciledFileResult;
  conflict?: ApplyConflictRecord;
  pendingTextConflict?: PendingTextConflict;
}> => {
  const baseSnapshot = await readGitSnapshot(args.sourceRoot, args.baselineHeadSha, args.path);
  const candidateSnapshot = await readFsSnapshot(args.candidateRoot, args.path);
  const sourceSnapshot = await readFsSnapshot(args.sourceRoot, args.path);

  if (snapshotKind(baseSnapshot) === "directory" || snapshotKind(candidateSnapshot) === "directory") {
    return {
      conflict: unsupportedConflictFor({
        path: args.path,
        class: "structural_conflict",
        decision: "apply_failed",
        reason: `structural conflict at ${args.path}`,
        detail: `directory surfaces are not reconciled safely (${summarizeSnapshot(baseSnapshot)} / ${summarizeSnapshot(candidateSnapshot)})`,
      }),
    };
  }

  if (
    baseSnapshot.kind === "symlink" ||
    candidateSnapshot.kind === "symlink" ||
    sourceSnapshot.kind === "symlink"
  ) {
    if (!args.explicitConfirmation) {
      return {
        conflict: unsupportedConflictFor({
          path: args.path,
          class: "unsupported_surface",
          reason: `symlink apply requires explicit confirmation for ${args.path}`,
          detail: `snapshots=${summarizeSnapshot(baseSnapshot)},${summarizeSnapshot(candidateSnapshot)},${summarizeSnapshot(sourceSnapshot)}`,
        }),
      };
    }
    await writeSnapshot(args.workspaceRoot, args.path, candidateSnapshot);
    return {
      resolved: {
        kind: "resolved",
        path: args.path,
        resolution: "take_candidate",
        content: null,
      },
    };
  }

  if (
    baseSnapshot.kind === "binary" ||
    candidateSnapshot.kind === "binary" ||
    sourceSnapshot.kind === "binary"
  ) {
    if (!args.explicitConfirmation) {
      return {
        conflict: unsupportedConflictFor({
          path: args.path,
          class: "binary_conflict",
          reason: `binary apply requires explicit confirmation for ${args.path}`,
          detail: `snapshots=${summarizeSnapshot(baseSnapshot)},${summarizeSnapshot(candidateSnapshot)},${summarizeSnapshot(sourceSnapshot)}`,
        }),
      };
    }
    await writeSnapshot(args.workspaceRoot, args.path, candidateSnapshot);
    return {
      resolved: {
        kind: "resolved",
        path: args.path,
        resolution: "take_candidate",
        content: null,
      },
    };
  }

  const outcome = await reconcileFile({
    path: args.path,
    baseContent: baseSnapshot.kind === "text" ? baseSnapshot.content : null,
    candidateContent: candidateSnapshot.kind === "text" ? candidateSnapshot.content : null,
    sourceContent: sourceSnapshot.kind === "text" ? sourceSnapshot.content : null,
  });
  if (outcome.kind === "resolved") {
    if (outcome.resolution === "take_candidate" || outcome.resolution === "merge_text") {
      await writeSnapshot(args.workspaceRoot, args.path, materializeResolvedSnapshot(outcome));
    }
    if (outcome.resolution === "converged" && outcome.content === null) {
      await removePath(args.workspaceRoot, args.path);
    }
    return { resolved: outcome };
  }

  if (!args.explicitConfirmation) {
    const conflict = conflictRecordFor({
      path: args.path,
      classification: outcome.classification,
      detail: outcome.conflictKind,
    });
    return {
      conflict,
      ...(baseSnapshot.kind === "text" &&
      candidateSnapshot.kind === "text" &&
      sourceSnapshot.kind === "text"
        ? {
            pendingTextConflict: {
              conflict,
              baseContent: baseSnapshot.content,
              candidateContent: candidateSnapshot.content,
              sourceContent: sourceSnapshot.content,
            },
          }
        : {}),
    };
  }
  await writeSnapshot(args.workspaceRoot, args.path, candidateSnapshot);
  return {
    resolved: {
      kind: "resolved",
      path: args.path,
      resolution: "take_candidate",
      content: candidateSnapshot.kind === "text" ? candidateSnapshot.content : null,
    },
  };
};

const resolveTextConflict = async (args: {
  context: ApplyArtifactContext;
  runner: ABoxTaskRunner;
  originalSpec: AttemptSpec;
  workspaceRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  conflict: EligibleTextConflict;
}): Promise<{
  dispatch: ApplyDispatchRecord;
  summary: ApplyResolutionRecord;
  autoApplied: boolean;
  resolvedContent?: string | null;
}> => {
  const dispatchAttemptId = `${args.attemptId}-apply-resolve-${identifierFragmentForPath(args.conflict.path)}`;
  const dispatchTaskId = dispatchAttemptId;
  const artifactNames = artifactNamesForResolutionPath(args.conflict.path);
  const prompt = buildApplyResolvePrompt({
    originalSpec: args.originalSpec,
    conflict: args.conflict,
  });
  const plan = buildApplyDispatchPlan({
    kind: "apply_resolve",
    sessionId: args.sessionId,
    turnId: args.turnId,
    attemptId: dispatchAttemptId,
    taskId: dispatchTaskId,
    intentId: `${args.originalSpec.intentId}-apply-resolve-${identifierFragmentForPath(args.conflict.path)}`,
    workspaceRoot: args.workspaceRoot,
    prompt: prompt.prompt,
    instructions: prompt.instructions,
     permissionRules: args.originalSpec.permissions.rules,
    providerId: "codex", // Wave 1: use registered provider ID
    timeoutSeconds: args.originalSpec.budget.timeoutSeconds,
    maxOutputBytes: args.originalSpec.budget.maxOutputBytes,
    heartbeatIntervalMs: args.originalSpec.budget.heartbeatIntervalMs,
  });
  const artifacts: string[] = [];
  artifacts.push(
    await writeApplyJsonArtifact(
      args.context,
      artifactNames.input,
      {
        path: args.conflict.path,
        goal: args.originalSpec.prompt,
        instructions: args.originalSpec.instructions,
        conflict: args.conflict.conflict,
        baseContent: args.conflict.baseContent,
        candidateContent: args.conflict.candidateContent,
        sourceContent: args.conflict.sourceContent,
      },
      "apply-resolve-input",
      { path: args.conflict.path },
    ),
  );
  artifacts.push(
    await writeApplyJsonArtifact(
      args.context,
      artifactNames.dispatch,
      plan.spec,
      "apply-resolve-dispatch",
      { path: args.conflict.path },
    ),
  );

  await rm(resolveApplyResultPath(args.workspaceRoot, dispatchAttemptId), { force: true });
  const execution = await args.runner.runAttempt(
    plan.spec,
    {
      timeoutSeconds: plan.spec.budget.timeoutSeconds,
      maxOutputBytes: plan.spec.budget.maxOutputBytes,
      heartbeatIntervalMs: plan.spec.budget.heartbeatIntervalMs,
      shell: "bash",
    },
    {},
    plan.profile,
  );
  artifacts.push(
    await writeApplyLogArtifact(
      args.context,
      artifactNames.output,
      `${execution.rawOutput}\n`,
      "apply-resolve-output",
      { path: args.conflict.path },
    ),
  );

  if (
    execution.result.status !== "succeeded" ||
    (execution.result.exitCode !== undefined &&
      execution.result.exitCode !== null &&
      execution.result.exitCode !== 0)
  ) {
    const error = execution.result.summary || `apply_resolve failed for ${args.conflict.path}`;
    return {
      dispatch: applyDispatchRecordFor({
        kind: "apply_resolve",
        attemptId: dispatchAttemptId,
        taskId: dispatchTaskId,
        status: "failed",
        error,
        artifacts,
      }),
      summary: resolutionSummaryFor({
        path: args.conflict.path,
        confidence: "low",
        rationale: error,
        status: "needs_confirmation",
        recordedAt: nowIso(),
        artifacts,
        reason: error,
      }),
      autoApplied: false,
    };
  }

  let rawResult = "";
  try {
    rawResult = await readFile(resolveApplyResultPath(args.workspaceRoot, dispatchAttemptId), "utf8");
  } catch (error) {
    const message = `apply_resolve did not write result.json for ${args.conflict.path}`;
    return {
      dispatch: applyDispatchRecordFor({
        kind: "apply_resolve",
        attemptId: dispatchAttemptId,
        taskId: dispatchTaskId,
        status: "failed",
        error: message,
        artifacts,
      }),
      summary: resolutionSummaryFor({
        path: args.conflict.path,
        confidence: "low",
        rationale: message,
        status: "needs_confirmation",
        recordedAt: nowIso(),
        artifacts,
        reason: error instanceof Error ? error.message : message,
      }),
      autoApplied: false,
    };
  }

  const parsedResult = parseApplyResolveResult(rawResult, args.conflict.path);
  if (!parsedResult.ok) {
    return {
      dispatch: applyDispatchRecordFor({
        kind: "apply_resolve",
        attemptId: dispatchAttemptId,
        taskId: dispatchTaskId,
        status: "failed",
        error: parsedResult.error,
        artifacts,
      }),
      summary: resolutionSummaryFor({
        path: args.conflict.path,
        confidence: "low",
        rationale: parsedResult.error,
        status: "needs_confirmation",
        recordedAt: nowIso(),
        artifacts,
        reason: parsedResult.error,
      }),
      autoApplied: false,
    };
  }

  artifacts.push(
    await writeApplyJsonArtifact(
      args.context,
      artifactNames.result,
      parsedResult.value,
      "apply-resolve-result",
      {
        path: args.conflict.path,
        confidence: parsedResult.value.confidence,
      },
    ),
  );
  const dispatch = applyDispatchRecordFor({
    kind: "apply_resolve",
    attemptId: dispatchAttemptId,
    taskId: dispatchTaskId,
    status: "succeeded",
    artifacts,
  });

  if (parsedResult.value.confidence !== "high") {
    const reason = `automatic resolution for ${args.conflict.path} returned ${parsedResult.value.confidence} confidence`;
    return {
      dispatch,
      summary: resolutionSummaryFor({
        path: args.conflict.path,
        confidence: parsedResult.value.confidence,
        rationale: parsedResult.value.rationale,
        status: "needs_confirmation",
        recordedAt: nowIso(),
        artifacts,
        reason,
      }),
      autoApplied: false,
    };
  }

  return {
    dispatch,
    summary: resolutionSummaryFor({
      path: args.conflict.path,
      confidence: parsedResult.value.confidence,
      rationale: parsedResult.value.rationale,
      status: "auto_applied",
      recordedAt: nowIso(),
      artifacts,
    }),
    autoApplied: true,
    resolvedContent: parsedResult.value.resolvedContent,
  };
};

const verifyApplyWorkspace = async (args: {
  context: ApplyArtifactContext;
  runner: ABoxTaskRunner;
  originalSpec: AttemptSpec;
  workspaceRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
}): Promise<{
  ok: boolean;
  record: ApplyDispatchRecord;
  error?: string;
}> => {
  const dispatchAttemptId = `${args.attemptId}-apply-verify`;
  const dispatchTaskId = dispatchAttemptId;
  const checks = args.originalSpec.acceptanceChecks.map((check) => ({
    ...check,
    ...(check.command === undefined && args.originalSpec.execution.command !== undefined
      ? { command: args.originalSpec.execution.command }
      : {}),
  }));
  const firstCommand = checks.find((check) => check.command !== undefined)?.command;
  const plan = buildApplyDispatchPlan({
    kind: "apply_verify",
    sessionId: args.sessionId,
    turnId: args.turnId,
    attemptId: dispatchAttemptId,
    taskId: dispatchTaskId,
    intentId: `${args.originalSpec.intentId}-apply-verify`,
    workspaceRoot: args.workspaceRoot,
    prompt: `Verify the staged apply result for ${args.originalSpec.prompt}`,
    instructions: [
      "Run the staged apply verification commands in the staged workspace.",
      "Do not modify repository files unless the verification command itself does so.",
    ],
    ...(firstCommand === undefined ? {} : { command: firstCommand }),
    acceptanceChecks: checks,
    permissionRules: args.originalSpec.permissions.rules,
    providerId: "codex", // Wave 1: use registered provider ID
    timeoutSeconds: args.originalSpec.budget.timeoutSeconds,
    maxOutputBytes: args.originalSpec.budget.maxOutputBytes,
    heartbeatIntervalMs: args.originalSpec.budget.heartbeatIntervalMs,
  });

  const artifacts: string[] = [];
  artifacts.push(
    await writeApplyJsonArtifact(
      args.context,
      "apply-verify-dispatch.json",
      plan.spec,
      "apply-verify-dispatch",
    ),
  );

  const execution = await args.runner.runAttempt(
    plan.spec,
    {
      timeoutSeconds: plan.spec.budget.timeoutSeconds,
      maxOutputBytes: plan.spec.budget.maxOutputBytes,
      heartbeatIntervalMs: plan.spec.budget.heartbeatIntervalMs,
      shell: "bash",
    },
    {},
    plan.profile,
  );
  const executionResult = toExecutionResult(plan.spec, execution);
  artifacts.push(
    await writeApplyJsonArtifact(
      args.context,
      "apply-verify-result.json",
      executionResult,
      "apply-verify-result",
      {
        status: executionResult.status,
        exitCode: executionResult.exitCode ?? null,
      },
    ),
  );
  artifacts.push(
    await writeApplyLogArtifact(
      args.context,
      "apply-verify-output.log",
      `${execution.rawOutput}\n`,
      "apply-verify-output",
    ),
  );

  if (
    execution.result.status !== "succeeded" ||
    (execution.result.exitCode !== undefined &&
      execution.result.exitCode !== null &&
      execution.result.exitCode !== 0)
  ) {
    const error = execution.result.summary || "apply verification failed";
    return {
      ok: false,
      error,
      record: applyDispatchRecordFor({
        kind: "apply_verify",
        attemptId: dispatchAttemptId,
        taskId: dispatchTaskId,
        ...(firstCommand === undefined ? {} : { command: firstCommand }),
        status: "failed",
        error,
        artifacts,
      }),
    };
  }

  return {
    ok: true,
    record: applyDispatchRecordFor({
      kind: "apply_verify",
      attemptId: dispatchAttemptId,
      taskId: dispatchTaskId,
      ...(firstCommand === undefined ? {} : { command: firstCommand }),
      status: "succeeded",
      artifacts,
    }),
  };
};

export const applyPreservedCandidate = async (
  input: ApplyPreservedCandidateInput,
): Promise<CandidateApplyResult> => {
  const { sessionStore, artifactStore, runner, storageRoot, session, turnId, attempt, attemptSpec } =
    input;
  const candidate = attempt.candidate;
  const sandboxTaskId = candidate?.sandboxTaskId;
  if (sandboxTaskId === undefined) {
    return {
      candidateState: "apply_failed",
      message: "candidate apply failed: preserved candidate is missing sandboxTaskId",
      inspection:
        input.inspection ??
        (await inspectWorktree({
          snapshot: {
            path: candidate?.worktreePath ?? session.repoRoot,
            branch: candidate?.branchName ?? "",
            head: "",
          },
          taskId: "missing",
          attemptId: attempt.attemptId,
          baselineHeadSha: input.sourceBaseline.headSha,
        })),
      candidateUpdates: {
        failureAt: nowIso(),
        applyError: "preserved candidate is missing sandboxTaskId",
      },
      applyResult: { error: "preserved candidate is missing sandboxTaskId" },
    };
  }

  const inspection =
    input.inspection ??
    (await inspectWorktree({
      snapshot: {
        path: candidate?.worktreePath ?? session.repoRoot,
        branch: candidate?.branchName ?? "",
        head: candidate?.candidateId ?? "",
      },
      taskId: sandboxTaskId,
      attemptId: attempt.attemptId,
      baselineHeadSha: input.sourceBaseline.headSha,
    }));
  const applyContext: ApplyArtifactContext = {
    artifactStore,
    storageRoot,
    sessionId: session.sessionId,
    turnId,
    attemptId: attempt.attemptId,
  };
  const { fingerprint } = describeCandidateManifest(inspection);
  const expectedFingerprint = input.expectedFingerprint ?? attempt.candidate?.fingerprint;
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    const message = "candidate apply failed: preserved candidate changed after review";
    await writeApplyJsonArtifact(
      applyContext,
      "apply-fingerprint-check.json",
      { expectedFingerprint, fingerprint, matched: false },
      "candidate-fingerprint-check",
    );
    return {
      candidateState: "apply_failed",
      message,
      inspection,
      candidateUpdates: {
        fingerprint,
        failureAt: nowIso(),
        applyError: message,
      },
      applyResult: { error: message },
    };
  }

  await writeApplyJsonArtifact(
    applyContext,
    "apply-fingerprint-check.json",
    { expectedFingerprint: expectedFingerprint ?? fingerprint, fingerprint, matched: true },
    "candidate-fingerprint-check",
  );

  const drift = await evaluateApplyDrift(input.sourceBaseline, session.repoRoot);
  await writeApplyJsonArtifact(
    applyContext,
    "apply-drift-report.json",
    drift,
    "apply-drift-report",
    { decision: drift.decision },
  );
  if (drift.decision !== "allowed") {
    const message = `candidate apply failed: drift gate returned ${drift.decision}`;
    return {
      candidateState: "apply_failed",
      message,
      inspection,
      candidateUpdates: {
        driftDecision: drift.decision,
        failureAt: nowIso(),
        applyError: message,
      },
      applyResult: { error: message },
    };
  }

  await persistCandidateAttemptState({
    store: sessionStore,
    sessionId: session.sessionId,
    turnId,
    attemptId: attempt.attemptId,
    state: "apply_staging",
    message: "staging preserved candidate into apply workspace",
    candidateUpdates: {
      fingerprint,
      driftDecision: drift.decision,
      stagedAt: nowIso(),
    },
  });

  let workspaceHandle: Awaited<ReturnType<typeof createApplyWorkspace>> | null = null;
  try {
    workspaceHandle = await createApplyWorkspace(session.repoRoot);
  } catch (error) {
    const message =
      error instanceof ApplyWorkspaceUnsupportedSurfaceError
        ? `candidate apply failed: ${error.message}`
        : `candidate apply failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      candidateState: "apply_failed",
      message,
      inspection,
      candidateUpdates: {
        driftDecision: drift.decision,
        failureAt: nowIso(),
        applyError: message,
      },
      applyResult: { error: message },
    };
  }

  try {
    const sourceStatus = workspaceHandle.sourceStatus;
    await writeApplyJsonArtifact(
      applyContext,
      "apply-source-status.json",
      sourceStatus,
      "apply-source-status",
    );

    const resolvedPaths: string[] = [];
    const conflicts: ApplyConflictRecord[] = [];
    const pendingTextConflicts: EligibleTextConflict[] = [];
    const applyDispatches: ApplyDispatchRecord[] = [];
    const resolutions: ApplyResolutionRecord[] = [];
    for (const path of [...inspection.repoChangedFiles].sort(comparePath)) {
      const resolution = await stagePathResolution({
        sourceRoot: session.repoRoot,
        candidateRoot: inspection.worktreePath,
        workspaceRoot: workspaceHandle.workspaceRoot,
        baselineHeadSha: input.sourceBaseline.headSha,
        path,
        explicitConfirmation: input.explicitConfirmation,
      });
      if (resolution.resolved !== undefined) {
        resolvedPaths.push(path);
      }
      if (resolution.conflict !== undefined) {
        conflicts.push(resolution.conflict);
      }
      if (resolution.pendingTextConflict !== undefined) {
        pendingTextConflicts.push({
          path,
          conflict: resolution.pendingTextConflict.conflict,
          baseContent: resolution.pendingTextConflict.baseContent,
          candidateContent: resolution.pendingTextConflict.candidateContent,
          sourceContent: resolution.pendingTextConflict.sourceContent,
        });
      }
    }

    const hardFailure = conflicts.find((entry) => entry.decision === "apply_failed");
    if (hardFailure !== undefined) {
      const message = `candidate apply failed: ${hardFailure.reason}`;
      return {
        candidateState: "apply_failed",
        message,
        inspection,
        candidateUpdates: {
          fingerprint,
          driftDecision: drift.decision,
          failureAt: nowIso(),
          applyError: message,
          confirmationReason: hardFailure.reason,
        },
        applyResult: { error: message },
      };
    }

    if (!input.explicitConfirmation) {
      for (const pendingConflict of pendingTextConflicts) {
        const eligibility = classifyConflictResolutionEligibility(pendingConflict);
        if (!eligibility.eligible) {
          resolutions.push(
            resolutionSummaryFor({
              path: pendingConflict.path,
              confidence: "low",
              rationale: eligibility.reason,
              status: "needs_confirmation",
              recordedAt: nowIso(),
              reason: eligibility.reason,
            }),
          );
          continue;
        }

        const resolved = await resolveTextConflict({
          context: applyContext,
          runner,
          originalSpec: attemptSpec,
          workspaceRoot: workspaceHandle.workspaceRoot,
          sessionId: session.sessionId,
          turnId,
          attemptId: attempt.attemptId,
          conflict: pendingConflict,
        });
        applyDispatches.push(resolved.dispatch);
        resolutions.push(resolved.summary);

        if (!resolved.autoApplied) {
          continue;
        }

        await writeSnapshot(
          workspaceHandle.workspaceRoot,
          pendingConflict.path,
          resolved.resolvedContent === null
            ? { kind: "missing" }
            : { kind: "text", content: resolved.resolvedContent ?? "" },
        );
        const index = conflicts.findIndex((entry) => entry.path === pendingConflict.path);
        if (index !== -1) {
          conflicts.splice(index, 1);
        }
        resolvedPaths.push(pendingConflict.path);
      }
    }

    const stagedPatch = await diffRootsForPaths(
      session.repoRoot,
      workspaceHandle.workspaceRoot,
      inspection.repoChangedFiles,
    );
    if (stagedPatch.length > 0) {
      await writeApplyPatchArtifact(
        applyContext,
        "apply-staged.patch",
        stagedPatch,
        "apply-staged-patch",
      );
    }
    if (conflicts.length > 0) {
      await writeApplyJsonArtifact(
        applyContext,
        "apply-conflicts.json",
        conflicts,
        "apply-conflicts",
        { conflictCount: conflicts.length },
      );
    }
    if (resolutions.length > 0) {
      await writeApplyJsonArtifact(
        applyContext,
        "apply-resolve-summary.json",
        resolutions,
        "apply-resolve-summary",
        { resolutionCount: resolutions.length },
      );
    }

    if (conflicts.length > 0 && !input.explicitConfirmation) {
      const confirmationReason =
        conflicts.length === 1
          ? conflicts[0]!.reason
          : `${conflicts.length} apply conflicts require confirmation`;
      await persistCandidateAttemptState({
        store: sessionStore,
        sessionId: session.sessionId,
        turnId,
        attemptId: attempt.attemptId,
        state: "needs_confirmation",
        message: confirmationReason,
        candidateUpdates: {
          fingerprint,
          driftDecision: drift.decision,
          confirmationReason,
          resolutions,
          applyDispatches,
        },
      });
      return {
        candidateState: "needs_confirmation",
        message: confirmationReason,
        inspection,
        candidateUpdates: {
          fingerprint,
          driftDecision: drift.decision,
          confirmationReason,
          resolutions,
          applyDispatches,
        },
        applyResult: { needsConfirmation: true, confirmationReason },
      };
    }

    await persistCandidateAttemptState({
      store: sessionStore,
      sessionId: session.sessionId,
      turnId,
      attemptId: attempt.attemptId,
      state: "apply_verifying",
      message: "running apply verification in staged workspace",
      candidateUpdates: {
        fingerprint,
        driftDecision: drift.decision,
        resolutions,
        applyDispatches,
        verifiedAt: nowIso(),
      },
    });

    const verification = await verifyApplyWorkspace({
      context: applyContext,
      runner,
      originalSpec: attemptSpec,
      workspaceRoot: workspaceHandle.workspaceRoot,
      sessionId: session.sessionId,
      turnId,
      attemptId: attempt.attemptId,
    });
    if (!verification.ok) {
      const applyVerificationFailedAfterResolution =
        resolutions.some((entry) => entry.status === "auto_applied");
      const message = applyVerificationFailedAfterResolution
        ? `automatic resolution could not be verified: ${verification.error ?? "apply verification failed"}`
        : `candidate apply failed: ${verification.error ?? "apply verification failed"}`;
      const nextDispatches = [...applyDispatches, verification.record];
      if (applyVerificationFailedAfterResolution) {
        return {
          candidateState: "needs_confirmation",
          message,
          inspection,
          candidateUpdates: {
            fingerprint,
            driftDecision: drift.decision,
            confirmationReason: message,
            resolutions,
            applyDispatches: nextDispatches,
          },
          applyResult: { needsConfirmation: true, confirmationReason: message },
        };
      }
      return {
        candidateState: "apply_failed",
        message,
        inspection,
        candidateUpdates: {
          fingerprint,
          driftDecision: drift.decision,
          failureAt: nowIso(),
          applyError: message,
          resolutions,
          applyDispatches: nextDispatches,
        },
        applyResult: { error: message },
      };
    }

    await persistCandidateAttemptState({
      store: sessionStore,
      sessionId: session.sessionId,
      turnId,
      attemptId: attempt.attemptId,
      state: "apply_writeback",
      message: "writing verified apply result back to the source repo",
      candidateUpdates: {
        fingerprint,
        driftDecision: drift.decision,
        resolutions,
        writebackAt: nowIso(),
        applyDispatches: [...applyDispatches, verification.record],
      },
    });

    const writebackPlan = inspection.repoChangedFiles
      .map((path) => ({ path }))
      .sort((left, right) => comparePath(left.path, right.path));
    await writeApplyJsonArtifact(
      applyContext,
      "apply-writeback-plan.json",
      writebackPlan,
      "apply-writeback-plan",
      { pathCount: writebackPlan.length },
    );
    await writeApplyJsonArtifact(
      applyContext,
      APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME,
      {
        schemaVersion: 1,
        createdAt: nowIso(),
        entries: await Promise.all(
          writebackPlan.map(async ({ path }) => ({
            path,
            before: serializeApplySnapshot(await readFsSnapshot(session.repoRoot, path)),
            after: serializeApplySnapshot(await readFsSnapshot(workspaceHandle.workspaceRoot, path)),
          })),
        ),
      },
      "apply-writeback-journal",
      { pathCount: writebackPlan.length },
    );
    for (const { path } of writebackPlan) {
      const finalSnapshot = await readFsSnapshot(workspaceHandle.workspaceRoot, path);
      await writeSnapshot(session.repoRoot, path, finalSnapshot);
    }

    await discardSandbox(input.aboxBin, session.repoRoot, sandboxTaskId);
    const appliedAt = nowIso();
    const message = input.explicitConfirmation
      ? "candidate apply succeeded after explicit confirmation"
      : "candidate apply succeeded";
    await writeApplyJsonArtifact(
      applyContext,
      "apply-result.json",
      {
        applied: true,
        confirmed: input.explicitConfirmation,
        resolvedPaths,
        conflictCount: conflicts.length,
        resolutions,
      },
      "apply-result",
      { applied: true, confirmed: input.explicitConfirmation },
    );
    return {
      candidateState: "applied",
      message,
      inspection,
      candidateUpdates: {
        fingerprint,
        driftDecision: drift.decision,
        appliedAt,
        verifiedAt: appliedAt,
        writebackAt: appliedAt,
        resolutions,
        applyDispatches: [...applyDispatches, verification.record],
      },
      applyResult: { applied: true },
    };
  } finally {
    await workspaceHandle?.cleanup();
  }
};
