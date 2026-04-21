import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type {
  ABoxTaskRunner,
  TaskExecutionRecord,
  TaskRunnerHandlers,
} from "../../src/aboxTaskRunner.js";
import type { DispatchPlan, AttemptSpec } from "../../src/attemptProtocol.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import {
  CANDIDATE_FINGERPRINT_ARTIFACT_NAME,
  CANDIDATE_MANIFEST_ARTIFACT_NAME,
} from "../../src/host/candidateManifest.js";
import { buildInspectView } from "../../src/host/commands/inspect.js";
import { readSessionEventLog } from "../../src/host/eventLogWriter.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { discoverWorktree } from "../../src/host/worktreeDiscovery.js";
import { reservedOutputRelativeDirForAttempt } from "../../src/host/worktreeInspector.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
import { printReview, printStatus } from "../../src/host/printers.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { WorkerTaskProgressEvent } from "../../src/workerRuntime.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-pipeline-int-"));

const baseArgs = (storageRoot: string, aboxBin: string): HostCliArgs => ({
  command: "run",
  config: "config/default.json",
  aboxBin,
  mode: "build",
  yes: false,
  shell: "bash",
  timeoutSeconds: 120,
  maxOutputBytes: 256 * 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  storageRoot,
  copilot: {},
});

const buildAttemptSpec = (sessionId: string, repoRoot: string): AttemptSpec => ({
  schemaVersion: 3,
  sessionId,
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "attempt-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "update the repository",
  instructions: ["User prompt: update the repository"],
  cwd: repoRoot,
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 60, maxOutputBytes: 1024 * 1024, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [{ checkId: "check-1", label: "modify repository files" }],
  artifactRequests: [],
});

const seedSession = async (sessionStore: SessionStore, sessionId: string, repoRoot: string) =>
  sessionStore.createSession({
    sessionId,
    goal: "pipeline-goal",
    repoRoot,
    status: "running",
    turns: [
      {
        turnId: "turn-1",
        prompt: "pipeline-goal",
        mode: "build",
        status: "running",
        attempts: [],
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z",
      },
    ],
  });

const createRunner = (args: {
  sessionId: string;
  sandboxTaskId: string;
  worktreePath: string;
  attemptId: string;
  resolveContent?: string;
  /**
   * Resolution confidence emitted by the mock `apply_resolve` dispatch.
   * Defaults to `"high"`, which matches the auto-apply happy path. Set to
   * `"medium"` or `"low"` to force the non-interactive pipeline into
   * `needs_confirmation` because the host refuses to auto-apply without
   * explicit confirmation.
   */
  resolveConfidence?: "high" | "medium" | "low";
  /**
   * When true, the runner returns a failed result for `apply_verify`
   * (non-zero exit + `failed` status). The host treats this as a verify
   * failure, so without a prior auto-applied resolution the candidate
   * transitions to `apply_failed`.
   */
  failVerify?: boolean;
}): ABoxTaskRunner => {
  const {
    sessionId,
    sandboxTaskId,
    worktreePath,
    attemptId,
    resolveContent,
    resolveConfidence,
    failVerify,
  } = args;
  const baseEvent: WorkerTaskProgressEvent = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    kind: "task.progress",
    taskId: "attempt-1",
    sessionId,
    status: "running",
    timestamp: "2026-04-19T00:00:00.500Z",
  };
  const events: WorkerTaskProgressEvent[] = [
    { ...baseEvent, kind: "task.started" },
    { ...baseEvent, kind: "task.progress", message: "editing worktree" },
    { ...baseEvent, kind: "task.completed", status: "succeeded" },
  ];

  return {
    runAttempt: async (
      spec: AttemptSpec,
      _overrides: Record<string, unknown>,
      handlers: TaskRunnerHandlers = {},
    ): Promise<TaskExecutionRecord> => {
      if (spec.taskKind === "apply_resolve") {
        const outputDir = join(spec.cwd, reservedOutputRelativeDirForAttempt(spec.attemptId));
        await mkdir(outputDir, { recursive: true });
        await writeFile(
          join(outputDir, "result.json"),
          `${JSON.stringify(
            {
              path: "README.md",
              resolvedContent: resolveContent ?? "hello\nfrom source and sandbox\n",
              rationale: "reconciled the current source note with the candidate update",
              confidence: resolveConfidence ?? "high",
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } else if (spec.taskKind !== "apply_verify") {
        await writeFile(join(worktreePath, "README.md"), "hello\nfrom sandbox\n", "utf8");
        const outputDir = join(worktreePath, reservedOutputRelativeDirForAttempt(attemptId));
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, "summary.md"), "# summary\n", "utf8");
      }

      for (const event of events) {
        handlers.onEvent?.(event);
      }

      const verificationFailure = failVerify === true && spec.taskKind === "apply_verify";

      return {
        events,
        result: {
          schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
          taskId: "attempt-1",
          sessionId,
          status: verificationFailure ? "failed" : "succeeded",
          summary: verificationFailure ? "apply verification failed" : "worktree updated",
          startedAt: "2026-04-19T00:00:00.000Z",
          finishedAt: "2026-04-19T00:00:01.000Z",
          exitCode: verificationFailure ? 1 : 0,
          command: "mock worker",
          cwd: worktreePath,
          shell: "bash",
          timeoutSeconds: 60,
          durationMs: 1000,
          exitSignal: null,
          stdout: verificationFailure ? "verification failed" : "updated worktree",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          assumeDangerousSkipPermissions: false,
        },
        workerErrors: [],
        rawOutput: verificationFailure ? "verification failed" : "updated worktree",
        ok: !verificationFailure,
        metadata: {
          cmd: ["mock-abox", "--repo", worktreePath, "run", "--task", sandboxTaskId],
          taskId: sandboxTaskId,
        },
      };
    },
  } as ABoxTaskRunner;
};

test("executeAttempt auto-applies a reviewed candidate into the source repo", async () => {
  const rootDir = await createTempRoot();
  try {
    const repoRoot = join(rootDir, "repo");
    const storageRoot = join(rootDir, "sessions");
    const worktreePath = join(rootDir, "worktree-sandbox-task-1");
    const sessionId = "session-pipeline";
    const sandboxTaskId = "sandbox-task-1";
    const aboxBin = join(process.cwd(), "tests/helpers/mockAbox.sh");

    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, ["init"]);
    await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
    await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
    await writeFile(join(repoRoot, "README.md"), "hello\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "initial"]);
    await git(repoRoot, ["worktree", "add", "-b", `agent/${sandboxTaskId}`, worktreePath, "HEAD"]);

    const sessionStore = new SessionStore(storageRoot);
    const artifactStore = new ArtifactStore(storageRoot);
    await seedSession(sessionStore, sessionId, repoRoot);

    const spec = buildAttemptSpec(sessionId, repoRoot);
    const plan: DispatchPlan = {
      schemaVersion: 1,
      candidateId: "candidate-1",
      batchId: "batch-1",
      profile: {
        agentBackend: "mock",
        sandboxLifecycle: "preserved",
        candidatePolicy: "auto_apply",
      },
      spec,
    };

    const { reviewed, executionResult } = await executeAttempt(
      {
        sessionStore,
        artifactStore,
        runner: createRunner({
          sessionId,
          sandboxTaskId,
          worktreePath,
          attemptId: spec.attemptId,
        }),
        sessionId,
        turnId: "turn-1",
        spec,
        args: baseArgs(storageRoot, aboxBin),
      },
      plan,
    );

    assert.equal(reviewed.outcome, "success");
    assert.equal(reviewed.action, "accept");
    assert.equal(executionResult.status, "succeeded");

    const repoReadme = await readFile(join(repoRoot, "README.md"), "utf8");
    assert.equal(repoReadme, "hello\nfrom sandbox\n");

    const artifacts = await artifactStore.listTaskArtifacts(sessionId, spec.taskId);
    const artifactNames = new Set(artifacts.map((artifact) => artifact.name));
    for (const required of [
      "apply-drift-report.json",
      "apply-fingerprint-check.json",
      "apply-result.json",
      "apply-source-status.json",
      "apply-staged.patch",
      "apply-verify-dispatch.json",
      "apply-verify-output.log",
      "apply-verify-result.json",
      "apply-writeback-journal.json",
      "apply-writeback-plan.json",
      CANDIDATE_FINGERPRINT_ARTIFACT_NAME,
      CANDIDATE_MANIFEST_ARTIFACT_NAME,
      "changed-files.json",
      "dispatch.json",
      "patch.diff",
      "result.json",
      "summary.md",
      "worker-output.log",
    ]) {
      assert.ok(artifactNames.has(required), `missing required apply artifact ${required}`);
    }

    const session = await sessionStore.loadSession(sessionId);
    assert.ok(session);
    const attempt = session.turns[0]?.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.candidateState, "applied");
    assert.equal(attempt.candidate?.state, "applied");
    assert.equal(attempt.candidate?.sandboxTaskId, sandboxTaskId);
    assert.equal(attempt.candidate?.worktreePath, worktreePath);
    assert.equal(attempt.candidate?.changeKind, "dirty");
    assert.deepEqual(attempt.candidate?.changedFiles, ["README.md"]);
    assert.deepEqual(attempt.candidate?.dirtyFiles, ["README.md"]);
    assert.deepEqual(attempt.candidate?.committedFiles, []);
    assert.deepEqual(attempt.candidate?.outputArtifacts, ["summary.md"]);
    assert.equal(attempt.candidate?.driftDecision, "allowed");
    assert.equal(attempt.candidate?.manifestArtifact, CANDIDATE_MANIFEST_ARTIFACT_NAME);
    assert.ok(typeof attempt.candidate?.fingerprint === "string");

    const events = await readSessionEventLog(storageRoot, sessionId);
    const reviewCompleted = [...events]
      .reverse()
      .find((event) => event.kind === "host.review_completed");
    assert.equal(reviewCompleted?.payload.candidateState, "applied");

    const mockLogPath = join(repoRoot, ".git", "bakudo-mock.log");
    const mockLog = await readFile(mockLogPath, "utf8");
    assert.match(mockLog, /\bstop task=sandbox-task-1\b/u);
    assert.doesNotMatch(mockLog, /\bmerge task=sandbox-task-1\b/u);

    const discovered = await discoverWorktree(repoRoot, sandboxTaskId);
    assert.equal(discovered, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("executeAttempt auto-resolves overlapping source edits through apply_resolve before write-back", async () => {
  const rootDir = await createTempRoot();
  try {
    const repoRoot = join(rootDir, "repo");
    const storageRoot = join(rootDir, "sessions");
    const worktreePath = join(rootDir, "worktree-sandbox-task-1");
    const sessionId = "session-pipeline-auto-resolve";
    const sandboxTaskId = "sandbox-task-1";
    const aboxBin = join(process.cwd(), "tests/helpers/mockAbox.sh");

    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, ["init"]);
    await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
    await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
    await writeFile(join(repoRoot, "README.md"), "hello\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "initial"]);
    await git(repoRoot, ["worktree", "add", "-b", `agent/${sandboxTaskId}`, worktreePath, "HEAD"]);

    const sessionStore = new SessionStore(storageRoot);
    const artifactStore = new ArtifactStore(storageRoot);
    await seedSession(sessionStore, sessionId, repoRoot);
    await writeFile(join(repoRoot, "README.md"), "hello\nfrom source repo\n", "utf8");

    const spec = buildAttemptSpec(sessionId, repoRoot);
    const plan: DispatchPlan = {
      schemaVersion: 1,
      candidateId: "candidate-1",
      batchId: "batch-1",
      profile: {
        agentBackend: "mock",
        sandboxLifecycle: "preserved",
        candidatePolicy: "auto_apply",
      },
      spec,
    };

    const { reviewed } = await executeAttempt(
      {
        sessionStore,
        artifactStore,
        runner: createRunner({
          sessionId,
          sandboxTaskId,
          worktreePath,
          attemptId: spec.attemptId,
          resolveContent: "hello\nfrom source and sandbox\n",
        }),
        sessionId,
        turnId: "turn-1",
        spec,
        args: baseArgs(storageRoot, aboxBin),
      },
      plan,
    );

    assert.equal(reviewed.outcome, "success");
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\nfrom source and sandbox\n");

    const session = await sessionStore.loadSession(sessionId);
    const attempt = session?.turns[0]?.attempts[0];
    assert.deepEqual(
      attempt?.candidate?.applyDispatches?.map((entry) => entry.kind),
      ["apply_resolve", "apply_verify"],
    );
    assert.equal(attempt?.candidate?.resolutions?.[0]?.status, "auto_applied");
    assert.equal(attempt?.candidate?.resolutions?.[0]?.confidence, "high");

    const artifacts = await artifactStore.listTaskArtifacts(sessionId, spec.taskId);
    const artifactNames = artifacts.map((artifact) => artifact.name);
    assert.ok(artifactNames.some((name) => name === "apply-resolve-summary.json"));
    assert.ok(artifactNames.some((name) => /apply-resolve-.*-result\.json/u.test(name)));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("executeAttempt non-interactive run preserves the candidate in needs_confirmation when auto-resolve is not confident", async () => {
  const rootDir = await createTempRoot();
  try {
    const repoRoot = join(rootDir, "repo");
    const storageRoot = join(rootDir, "sessions");
    const worktreePath = join(rootDir, "worktree-sandbox-task-1");
    const sessionId = "session-pipeline-needs-confirmation";
    const sandboxTaskId = "sandbox-task-1";
    const aboxBin = join(process.cwd(), "tests/helpers/mockAbox.sh");

    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, ["init"]);
    await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
    await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
    await writeFile(join(repoRoot, "README.md"), "hello\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "initial"]);
    await git(repoRoot, ["worktree", "add", "-b", `agent/${sandboxTaskId}`, worktreePath, "HEAD"]);

    const sessionStore = new SessionStore(storageRoot);
    const artifactStore = new ArtifactStore(storageRoot);
    await seedSession(sessionStore, sessionId, repoRoot);
    // Force overlap so the host must call apply_resolve. With resolveConfidence
    // set below "high" and no explicit confirmation, the host stalls in
    // needs_confirmation instead of writing through to the source repo.
    await writeFile(join(repoRoot, "README.md"), "hello\nfrom source repo\n", "utf8");

    const spec = buildAttemptSpec(sessionId, repoRoot);
    const plan: DispatchPlan = {
      schemaVersion: 1,
      candidateId: "candidate-1",
      batchId: "batch-1",
      profile: {
        agentBackend: "mock",
        sandboxLifecycle: "preserved",
        candidatePolicy: "auto_apply",
      },
      spec,
    };

    const { reviewed } = await executeAttempt(
      {
        sessionStore,
        artifactStore,
        runner: createRunner({
          sessionId,
          sandboxTaskId,
          worktreePath,
          attemptId: spec.attemptId,
          resolveContent: "hello\nfrom source and sandbox\n",
          resolveConfidence: "medium",
        }),
        sessionId,
        turnId: "turn-1",
        spec,
        args: baseArgs(storageRoot, aboxBin),
      },
      plan,
    );

    assert.equal(reviewed.outcome, "blocked_needs_user");
    assert.equal(reviewed.action, "ask_user");

    // Source repo must NOT be mutated while we stall for confirmation.
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\nfrom source repo\n");

    const session = await sessionStore.loadSession(sessionId);
    assert.ok(session);
    const attempt = session.turns[0]?.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.candidateState, "needs_confirmation");
    assert.equal(attempt.candidate?.state, "needs_confirmation");
    assert.equal(attempt.status, "blocked");
    assert.equal(session.turns[0]?.status, "awaiting_user");
    assert.equal(attempt.candidate?.resolutions?.[0]?.status, "needs_confirmation");
    assert.equal(attempt.candidate?.resolutions?.[0]?.confidence, "medium");
    assert.deepEqual(
      attempt.candidate?.applyDispatches?.map((entry) => entry.kind),
      ["apply_resolve"],
    );
    assert.equal(attempt.reviewRecord?.outcome, "blocked_needs_user");
    assert.equal(attempt.reviewRecord?.action, "ask_user");

    const artifacts = await artifactStore.listTaskArtifacts(sessionId, spec.taskId);
    const artifactNames = artifacts.map((entry) => entry.name);
    assert.ok(
      artifactNames.some((name) => name === "apply-conflicts.json"),
      "expected apply-conflicts.json artifact for needs_confirmation",
    );
    assert.ok(
      artifactNames.some((name) => name === "apply-resolve-summary.json"),
      "expected apply-resolve-summary.json artifact for needs_confirmation",
    );
    assert.ok(
      artifactNames.some((name) => /apply-resolve-.*-result\.json/u.test(name)),
      "expected per-conflict apply-resolve result artifact",
    );
    // Confirm no apply-verify result was written — low-confidence short-circuits
    // before verification.
    assert.equal(
      artifactNames.some((name) => name === "apply-verify-result.json"),
      false,
      "apply-verify-result.json must not exist when auto-resolve is not confident",
    );

    // --- Reload truthfulness check -----------------------------------------
    // Simulate a restart by throwing away the in-memory stores and rebuilding
    // them against the same storageRoot. Every read surface (session record,
    // artifact listing, inspect --json, status, review) must still reflect
    // `needs_confirmation`.
    const reloadSessionStore = new SessionStore(storageRoot);
    const reloadArtifactStore = new ArtifactStore(storageRoot);
    const reloadedSession = await reloadSessionStore.loadSession(sessionId);
    assert.ok(reloadedSession);
    const reloadedAttempt = reloadedSession.turns[0]?.attempts[0];
    assert.equal(reloadedAttempt?.candidateState, "needs_confirmation");
    assert.equal(reloadedAttempt?.candidate?.state, "needs_confirmation");
    assert.equal(reloadedAttempt?.reviewRecord?.outcome, "blocked_needs_user");
    assert.equal(reloadedAttempt?.reviewRecord?.action, "ask_user");

    const reloadedArtifacts = await reloadArtifactStore.listTaskArtifacts(sessionId, spec.taskId);
    const reloadedNames = reloadedArtifacts.map((entry) => entry.name);
    assert.ok(reloadedNames.some((name) => name === "apply-conflicts.json"));
    assert.ok(reloadedNames.some((name) => name === "apply-resolve-summary.json"));

    // inspect --json via buildInspectView on the `review` tab.
    const inspectView = await buildInspectView({
      rootDir: storageRoot,
      session: reloadedSession,
      requestedTab: "review",
      invalidTabMode: "error",
    });
    const inspectJoined = inspectView.lines.join("\n");
    assert.match(inspectJoined, /Outcome\s+blocked_needs_user/u);
    assert.match(inspectJoined, /Action\s+ask_user/u);
    assert.match(inspectJoined, /Candidate\s+needs_confirmation/u);

    // status library surface — JSON mode emits the full session record,
    // which carries the persisted candidate state.
    const statusChunks: string[] = [];
    const statusWriter = {
      write: (chunk: string | Uint8Array) => {
        statusChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    };
    const statusExitCode = await withCapturedStdout(statusWriter, () =>
      printStatus({
        ...baseArgs(storageRoot, aboxBin),
        command: "status",
        sessionId,
        copilot: { outputFormat: "json" },
      }),
    );
    assert.equal(statusExitCode, 0);
    const statusBody = statusChunks.join("").trim();
    const statusPayload = JSON.parse(statusBody);
    assert.equal(statusPayload.sessionId, sessionId);
    const statusAttempt = statusPayload.turns?.[0]?.attempts?.[0];
    assert.equal(statusAttempt?.candidateState, "needs_confirmation");
    assert.equal(statusAttempt?.candidate?.state, "needs_confirmation");

    // review library surface — JSON mode emits the reviewed outcome.
    const reviewChunks: string[] = [];
    const reviewWriter = {
      write: (chunk: string | Uint8Array) => {
        reviewChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    };
    await withCapturedStdout(reviewWriter, () =>
      printReview({
        ...baseArgs(storageRoot, aboxBin),
        command: "review",
        sessionId,
        copilot: { outputFormat: "json" },
      }),
    );
    const reviewPayload = JSON.parse(reviewChunks.join("").trim());
    assert.equal(reviewPayload.outcome, "blocked_needs_user");
    assert.equal(reviewPayload.action, "ask_user");
    assert.equal(reviewPayload.candidateState, "needs_confirmation");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("executeAttempt non-interactive run marks the attempt apply_failed when verify fails", async () => {
  const rootDir = await createTempRoot();
  try {
    const repoRoot = join(rootDir, "repo");
    const storageRoot = join(rootDir, "sessions");
    const worktreePath = join(rootDir, "worktree-sandbox-task-1");
    const sessionId = "session-pipeline-apply-failed";
    const sandboxTaskId = "sandbox-task-1";
    const aboxBin = join(process.cwd(), "tests/helpers/mockAbox.sh");

    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, ["init"]);
    await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
    await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
    await writeFile(join(repoRoot, "README.md"), "hello\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "initial"]);
    await git(repoRoot, ["worktree", "add", "-b", `agent/${sandboxTaskId}`, worktreePath, "HEAD"]);

    const sessionStore = new SessionStore(storageRoot);
    const artifactStore = new ArtifactStore(storageRoot);
    await seedSession(sessionStore, sessionId, repoRoot);

    const spec = buildAttemptSpec(sessionId, repoRoot);
    const plan: DispatchPlan = {
      schemaVersion: 1,
      candidateId: "candidate-1",
      batchId: "batch-1",
      profile: {
        agentBackend: "mock",
        sandboxLifecycle: "preserved",
        candidatePolicy: "auto_apply",
      },
      spec,
    };

    const { reviewed } = await executeAttempt(
      {
        sessionStore,
        artifactStore,
        runner: createRunner({
          sessionId,
          sandboxTaskId,
          worktreePath,
          attemptId: spec.attemptId,
          failVerify: true,
        }),
        sessionId,
        turnId: "turn-1",
        spec,
        args: baseArgs(storageRoot, aboxBin),
      },
      plan,
    );

    // Verify failure with no prior auto-applied resolution surfaces as a
    // retryable failure (the host wraps the apply error and hands control
    // back to the reviewer which classifies it as retryable_failure).
    assert.equal(reviewed.outcome, "retryable_failure");
    assert.equal(reviewed.action, "retry");

    // Source repo must remain at the committed baseline — apply_failed must
    // not mutate the source tree.
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\n");

    const session = await sessionStore.loadSession(sessionId);
    assert.ok(session);
    const attempt = session.turns[0]?.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.candidateState, "apply_failed");
    assert.equal(attempt.candidate?.state, "apply_failed");
    assert.equal(attempt.status, "failed");
    assert.equal(session.turns[0]?.status, "failed");
    const applyError = attempt.candidate?.applyError;
    assert.ok(
      typeof applyError === "string" && applyError.length > 0,
      "expected applyError to be recorded on the persisted candidate",
    );

    const artifacts = await artifactStore.listTaskArtifacts(sessionId, spec.taskId);
    const artifactNames = artifacts.map((entry) => entry.name);
    assert.ok(
      artifactNames.some((name) => name === "apply-verify-result.json"),
      "expected apply-verify-result.json artifact for apply_failed",
    );
    assert.ok(
      artifactNames.some((name) => name === "apply-verify-output.log"),
      "expected apply-verify-output.log artifact for apply_failed",
    );
    assert.ok(
      artifactNames.some((name) => name === "apply-verify-dispatch.json"),
      "expected apply-verify-dispatch.json artifact for apply_failed",
    );

    // --- Reload truthfulness check -----------------------------------------
    const reloadSessionStore = new SessionStore(storageRoot);
    const reloadArtifactStore = new ArtifactStore(storageRoot);
    const reloadedSession = await reloadSessionStore.loadSession(sessionId);
    assert.ok(reloadedSession);
    const reloadedAttempt = reloadedSession.turns[0]?.attempts[0];
    assert.equal(reloadedAttempt?.candidateState, "apply_failed");
    assert.equal(reloadedAttempt?.candidate?.state, "apply_failed");
    assert.equal(reloadedAttempt?.reviewRecord?.outcome, "retryable_failure");
    assert.equal(reloadedAttempt?.reviewRecord?.action, "retry");

    const reloadedArtifacts = await reloadArtifactStore.listTaskArtifacts(sessionId, spec.taskId);
    const reloadedNames = reloadedArtifacts.map((entry) => entry.name);
    assert.ok(reloadedNames.some((name) => name === "apply-verify-result.json"));

    // inspect --json via buildInspectView on the `review` tab.
    const inspectView = await buildInspectView({
      rootDir: storageRoot,
      session: reloadedSession,
      requestedTab: "review",
      invalidTabMode: "error",
    });
    const inspectJoined = inspectView.lines.join("\n");
    assert.match(inspectJoined, /Outcome\s+retryable_failure/u);
    assert.match(inspectJoined, /Action\s+retry/u);
    assert.match(inspectJoined, /Candidate\s+apply_failed/u);

    // status library surface — JSON mode.
    const statusChunks: string[] = [];
    const statusWriter = {
      write: (chunk: string | Uint8Array) => {
        statusChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    };
    const statusExitCode = await withCapturedStdout(statusWriter, () =>
      printStatus({
        ...baseArgs(storageRoot, aboxBin),
        command: "status",
        sessionId,
        copilot: { outputFormat: "json" },
      }),
    );
    assert.equal(statusExitCode, 0);
    const statusPayload = JSON.parse(statusChunks.join("").trim());
    const statusAttempt = statusPayload.turns?.[0]?.attempts?.[0];
    assert.equal(statusAttempt?.candidateState, "apply_failed");
    assert.equal(statusAttempt?.candidate?.state, "apply_failed");

    // review library surface — JSON mode.
    const reviewChunks: string[] = [];
    const reviewWriter = {
      write: (chunk: string | Uint8Array) => {
        reviewChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    };
    await withCapturedStdout(reviewWriter, () =>
      printReview({
        ...baseArgs(storageRoot, aboxBin),
        command: "review",
        sessionId,
        copilot: { outputFormat: "json" },
      }),
    );
    const reviewPayload = JSON.parse(reviewChunks.join("").trim());
    assert.equal(reviewPayload.outcome, "retryable_failure");
    assert.equal(reviewPayload.action, "retry");
    assert.equal(reviewPayload.candidateState, "apply_failed");
    const reviewApplyError = reviewPayload.applyError;
    assert.ok(
      typeof reviewApplyError === "string" && reviewApplyError.length > 0,
      "expected applyError to be surfaced through the review JSON output",
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
