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
}): ABoxTaskRunner => {
  const { sessionId, sandboxTaskId, worktreePath, attemptId } = args;
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
      _spec: AttemptSpec,
      _overrides: Record<string, unknown>,
      handlers: TaskRunnerHandlers = {},
    ): Promise<TaskExecutionRecord> => {
      await writeFile(join(worktreePath, "README.md"), "hello\nfrom sandbox\n", "utf8");
      const outputDir = join(worktreePath, reservedOutputRelativeDirForAttempt(attemptId));
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, "summary.md"), "# summary\n", "utf8");

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

test("executeAttempt auto-merges preserved worktree artifacts and cleans up sandbox", async () => {
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
        mergeStrategy: "auto",
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

    const mergedReadme = await readFile(join(repoRoot, "README.md"), "utf8");
    assert.equal(mergedReadme, "hello\nfrom sandbox\n");

    const artifacts = await artifactStore.listTaskArtifacts(sessionId, spec.taskId);
    const artifactNames = artifacts.map((artifact) => artifact.name).sort();
    assert.deepEqual(artifactNames, [
      "changed-files.json",
      "dispatch.json",
      "merge-result.json",
      "patch.diff",
      "result.json",
      "summary.md",
      "worker-output.log",
    ]);

    const mergeArtifact = artifacts.find((artifact) => artifact.name === "merge-result.json");
    assert.ok(mergeArtifact);
    const mergePayload = JSON.parse(await readFile(mergeArtifact.path, "utf8")) as {
      merged?: boolean;
      discarded?: boolean;
    };
    assert.equal(mergePayload.merged, true);
    assert.equal(mergePayload.discarded, true);

    const session = await sessionStore.loadSession(sessionId);
    assert.ok(session);
    const attempt = session.turns[0]?.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.sandboxLifecycleState, "preserved_merged");
    assert.equal(attempt.sandbox?.state, "preserved_merged");
    assert.equal(attempt.sandbox?.sandboxTaskId, sandboxTaskId);
    assert.equal(attempt.sandbox?.worktreePath, worktreePath);
    assert.deepEqual(attempt.sandbox?.changedFiles, ["README.md"]);
    assert.deepEqual(attempt.sandbox?.outputArtifacts, ["summary.md"]);

    const events = await readSessionEventLog(storageRoot, sessionId);
    const reviewCompleted = [...events]
      .reverse()
      .find((event) => event.kind === "host.review_completed");
    assert.equal(reviewCompleted?.payload.sandboxLifecycleState, "preserved_merged");

    const mockLogPath = join(repoRoot, ".git", "bakudo-mock.log");
    const mockLog = await readFile(mockLogPath, "utf8");
    assert.match(mockLog, /merge task=sandbox-task-1/u);
    assert.match(mockLog, /stop task=sandbox-task-1/u);

    const discovered = await discoverWorktree(repoRoot, sandboxTaskId);
    assert.equal(discovered, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
