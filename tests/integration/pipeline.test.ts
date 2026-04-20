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
import { readSessionEventLog } from "../../src/host/eventLogWriter.js";
import { discoverWorktree } from "../../src/host/worktreeDiscovery.js";
import { reservedOutputRelativeDirForAttempt } from "../../src/host/worktreeInspector.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { executeAttempt } from "../../src/host/executeAttempt.js";
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
    assumeDangerousSkipPermissions: false,
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
}): ABoxTaskRunner => {
  const { sessionId, sandboxTaskId, worktreePath, attemptId, resolveContent } = args;
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
              confidence: "high",
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

      return {
        events,
        result: {
          schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
          taskId: "attempt-1",
          sessionId,
          status: "succeeded",
          summary: "worktree updated",
          startedAt: "2026-04-19T00:00:00.000Z",
          finishedAt: "2026-04-19T00:00:01.000Z",
          exitCode: 0,
          command: "mock worker",
          cwd: worktreePath,
          shell: "bash",
          timeoutSeconds: 60,
          durationMs: 1000,
          exitSignal: null,
          stdout: "updated worktree",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          assumeDangerousSkipPermissions: false,
        },
        workerErrors: [],
        rawOutput: "updated worktree",
        ok: true,
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
    const artifactNames = artifacts.map((artifact) => artifact.name).sort();
    assert.deepEqual(
      artifactNames,
      [
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
      ],
    );

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
