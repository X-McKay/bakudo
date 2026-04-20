import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type {
  AttemptExecutionResult,
  AttemptSpec,
  DispatchPlan,
} from "../../src/attemptProtocol.js";
import type { TaskRequest } from "../../src/protocol.js";
import { createSessionTaskKey } from "../../src/sessionTypes.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { ReviewedAttemptResult } from "../../src/reviewer.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME } from "../../src/host/applyRecovery.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { writeSessionArtifact } from "../../src/host/sessionArtifactWriter.js";
import { resumeSession } from "../../src/host/sessionLifecycle.js";

type Capture = {
  writer: { write: (chunk: string) => boolean };
  chunks: string[];
};

const capture = (): Capture => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

const buildAttemptSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "sess-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: createSessionTaskKey("sess-1", "task-1"),
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "echo hi",
  instructions: [],
  cwd: "/tmp/scratch",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 60, maxOutputBytes: 1024, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

const buildArgs = (
  storageRoot: string,
  repo: string,
  sessionId: string,
  attemptId: string,
): HostCliArgs =>
  ({
    command: "resume",
    config: "config/default.json",
    aboxBin: "abox",
    repo,
    sessionId,
    taskId: attemptId,
    mode: "build",
    yes: true,
    shell: "bash",
    timeoutSeconds: 60,
    maxOutputBytes: 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    storageRoot,
    copilot: {},
  }) as HostCliArgs;

const buildReviewedSuccess = (
  spec: AttemptSpec,
): { reviewed: ReviewedAttemptResult; executionResult: AttemptExecutionResult } => ({
  reviewed: {
    outcome: "success",
    action: "accept",
    reason: "ok",
    retryable: false,
    needsUser: false,
    confidence: "high",
    attemptId: spec.attemptId,
    intentId: spec.intentId,
    status: "succeeded",
  },
  executionResult: {
    schemaVersion: 3,
    attemptId: spec.attemptId,
    taskKind: spec.taskKind,
    status: "succeeded",
    summary: "ok",
    exitCode: 0,
    startedAt: "2026-04-18T00:00:01.000Z",
    finishedAt: "2026-04-18T00:00:02.000Z",
    durationMs: 1000,
    artifacts: [],
  },
});

test("F-03: resumeSession reads attemptSpec when request is undefined", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-repo-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-store-"));
  try {
    const store = new SessionStore(storageRoot);
    const spec = buildAttemptSpec();
    await store.createSession({
      sessionId: spec.sessionId,
      goal: spec.prompt,
      repoRoot,
      status: "failed",
      turns: [
        {
          turnId: spec.turnId,
          prompt: spec.prompt,
          mode: spec.mode,
          status: "failed",
          attempts: [],
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z",
        },
      ],
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
    });
    await store.upsertAttempt(spec.sessionId, spec.turnId, {
      attemptId: spec.attemptId,
      status: "failed",
      lastMessage: "retryable failure",
      attemptSpec: spec,
      result: {
        schemaVersion: 1,
        taskId: spec.taskId,
        sessionId: spec.sessionId,
        status: "failed",
        summary: "boot timeout",
        exitCode: 1,
        finishedAt: "2026-04-18T00:00:01.000Z",
      },
    });

    const captured: Array<{ spec: AttemptSpec; plan?: DispatchPlan; turnId: string }> = [];
    const cap = capture();
    const exit = await withCapturedStdout(cap.writer, () =>
      resumeSession(buildArgs(storageRoot, repoRoot, spec.sessionId, spec.attemptId), {
        executeAttemptFn: async (ctx, plan) => {
          captured.push({
            spec: ctx.spec!,
            ...(plan !== undefined ? { plan } : {}),
            turnId: ctx.turnId,
          });
          return buildReviewedSuccess(ctx.spec!);
        },
      }),
    );

    assert.equal(exit, 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.turnId, "turn-1");
    assert.equal(captured[0]?.spec.taskId, createSessionTaskKey(spec.sessionId, "retry-2"));
    assert.equal(captured[0]?.spec.prompt, spec.prompt);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("F-03: resumeSession still works for legacy request-only attempts", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-v1-repo-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-v1-store-"));
  try {
    const store = new SessionStore(storageRoot);
    const sessionId = "sess-legacy";
    const legacyTaskId = createSessionTaskKey(sessionId, "task-1");
    const legacyRequest: TaskRequest = {
      schemaVersion: 1,
      taskId: legacyTaskId,
      sessionId,
      goal: "echo hi",
      mode: "build",
      cwd: "/tmp/scratch",
      timeoutSeconds: 60,
      maxOutputBytes: 1024,
      heartbeatIntervalMs: 5000,
      assumeDangerousSkipPermissions: false,
    };

    const { sessionFile } = store.paths(sessionId);
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sessionId,
          goal: legacyRequest.goal,
          status: "failed",
          assumeDangerousSkipPermissions: false,
          tasks: [
            {
              taskId: "attempt-1",
              status: "failed",
              request: legacyRequest,
              result: {
                schemaVersion: 1,
                taskId: legacyTaskId,
                sessionId,
                status: "failed",
                summary: "boot timeout",
                exitCode: 1,
                finishedAt: "2026-04-18T00:00:01.000Z",
              },
            },
          ],
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const captured: AttemptSpec[] = [];
    const cap = capture();
    const exit = await withCapturedStdout(cap.writer, () =>
      resumeSession(buildArgs(storageRoot, repoRoot, sessionId, "attempt-1"), {
        executeAttemptFn: async (ctx) => {
          captured.push(ctx.spec!);
          return buildReviewedSuccess(ctx.spec!);
        },
      }),
    );

    assert.equal(exit, 0);
    assert.equal(captured.length, 1);
    assert.ok(captured[0]?.instructions.some((line) => line.includes("User prompt: echo hi")));
    assert.equal(captured[0]?.taskId, createSessionTaskKey(sessionId, "retry-2"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("F-03: resumeSession restores interrupted apply_writeback before deciding whether to retry", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-apply-recovery-repo-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-apply-recovery-store-"));
  try {
    const store = new SessionStore(storageRoot);
    const spec = buildAttemptSpec();
    const artifactStore = new ArtifactStore(storageRoot);
    await writeFile(join(repoRoot, "README.md"), "after\n", "utf8");
    await store.createSession({
      sessionId: spec.sessionId,
      goal: spec.prompt,
      repoRoot,
      status: "reviewing",
      turns: [
        {
          turnId: spec.turnId,
          prompt: spec.prompt,
          mode: spec.mode,
          status: "reviewing",
          attempts: [
            {
              attemptId: spec.attemptId,
              status: "needs_review",
              attemptSpec: spec,
              candidateState: "apply_writeback",
              candidate: {
                state: "apply_writeback",
                updatedAt: "2026-04-19T00:00:00.000Z",
              },
              result: {
                schemaVersion: 1,
                taskId: spec.taskId,
                sessionId: spec.sessionId,
                status: "succeeded",
                summary: "worker ok",
                exitCode: 0,
                finishedAt: "2026-04-19T00:00:01.000Z",
              },
              reviewRecord: {
                reviewId: "review-1",
                attemptId: spec.attemptId,
                outcome: "success",
                action: "accept",
                reviewedAt: "2026-04-19T00:00:01.000Z",
              },
            },
          ],
          latestReview: {
            reviewId: "review-1",
            attemptId: spec.attemptId,
            outcome: "success",
            action: "accept",
            reviewedAt: "2026-04-19T00:00:01.000Z",
          },
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
      ],
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:00.000Z",
    });
    await writeSessionArtifact(
      artifactStore,
      storageRoot,
      spec.sessionId,
      spec.turnId,
      spec.attemptId,
      APPLY_WRITEBACK_JOURNAL_ARTIFACT_NAME,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: "2026-04-19T00:00:00.000Z",
          entries: [
            {
              path: "README.md",
              before: { kind: "text", content: "before\n" },
              after: { kind: "text", content: "after\n" },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "report",
      {
        generatedBy: "host.candidateApplier",
        producer: "host.candidateApplier",
        phase: "apply",
        role: "apply-writeback-journal",
      },
    );

    let executeCalled = false;
    const cap = capture();
    const exit = await withCapturedStdout(cap.writer, () =>
      resumeSession(buildArgs(storageRoot, repoRoot, spec.sessionId, spec.attemptId), {
        executeAttemptFn: async () => {
          executeCalled = true;
          throw new Error("resume should not redispatch after apply recovery");
        },
      }),
    );

    assert.equal(exit, 1);
    assert.equal(executeCalled, false);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "before\n");
    const session = await store.loadSession(spec.sessionId);
    assert.equal(session?.turns[0]?.attempts[0]?.candidateState, "apply_failed");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});
