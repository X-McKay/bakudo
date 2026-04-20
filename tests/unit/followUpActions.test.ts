import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ABoxTaskRunner, TaskExecutionRecord } from "../../src/aboxTaskRunner.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { applyFollowUpAction } from "../../src/host/followUpActions.js";
import { captureSourceBaseline } from "../../src/host/sourceBaseline.js";
import { emitTurnTransition, listTurnTransitions } from "../../src/host/transitionStore.js";
import { discoverWorktree } from "../../src/host/worktreeDiscovery.js";
import { reservedOutputRelativeDirForAttempt } from "../../src/host/worktreeInspector.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { SessionAttemptRecord, SessionTurnRecord } from "../../src/sessionTypes.js";
import { createCandidateApplyFixture } from "../helpers/candidateApplyFixtures.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-followup-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

type SeedInput = {
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  repoRoot?: string;
  turnStatus?: SessionTurnRecord["status"];
  attemptStatus?: SessionAttemptRecord["status"];
  attemptOverrides?: Partial<SessionAttemptRecord>;
  /**
   * When true, also emit a `next_turn` transition so the retry path finds
   * an existing chain to extend. The tests that want to assert chain
   * continuity use this; the tests that exercise the tolerant fallback
   * (no prior transition) leave it off.
   */
  seedTransition?: boolean;
};

/**
 * Create a minimal session with one turn and one attempt so the follow-up
 * paths have something to extend. Returns the store so callers can re-read.
 */
const seedSession = async (input: SeedInput): Promise<SessionStore> => {
  const store = new SessionStore(input.storageRoot);
  const now = new Date().toISOString();
  const turn: SessionTurnRecord = {
    turnId: input.turnId,
    prompt: "test prompt",
    mode: "build",
    status: input.turnStatus ?? "reviewing",
    attempts: [
      {
        attemptId: input.attemptId,
        status: input.attemptStatus ?? "failed",
        ...input.attemptOverrides,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await store.createSession({
    sessionId: input.sessionId,
    goal: "test goal",
    repoRoot: input.repoRoot ?? "/tmp/fake-repo",
    status: "running",
    turns: [turn],
  });
  if (input.seedTransition === true) {
    await emitTurnTransition({
      storageRoot: input.storageRoot,
      sessionId: input.sessionId,
      turnId: input.turnId,
      fromStatus: "queued",
      toStatus: "queued",
      reason: "next_turn",
    });
  }
  return store;
};

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

const createPreservedSandboxFixture = async (root: string) => {
  const repoRoot = join(root, "repo");
  const worktreePath = join(root, "worktree-sandbox-task-1");
  const sandboxTaskId = "sandbox-task-1";
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
  await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
  await writeFile(join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  await git(repoRoot, ["worktree", "add", "-b", `agent/${sandboxTaskId}`, worktreePath, "HEAD"]);
  const sourceBaseline = await captureSourceBaseline(repoRoot);
  return { repoRoot, worktreePath, sandboxTaskId, sourceBaseline };
};

const createAttemptSpec = (sessionId: string, turnId: string, attemptId: string, repoRoot: string): AttemptSpec => ({
  schemaVersion: 3,
  sessionId,
  turnId,
  attemptId,
  taskId: attemptId,
  intentId: `${attemptId}-intent`,
  mode: "build",
  taskKind: "assistant_job",
  prompt: "apply the preserved candidate",
  instructions: ["Apply the preserved candidate into the source repository."],
  cwd: repoRoot,
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 60, maxOutputBytes: 1024 * 1024, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
});

const createApplyRunner = (options: {
  failVerify?: boolean;
  resolvePath?: string;
  resolveConfidence?: "high" | "medium" | "low";
  resolveRationale?: string;
  resolveContent?: string | null;
} = {}): ABoxTaskRunner =>
  ({
    runAttempt: async (spec: AttemptSpec): Promise<TaskExecutionRecord> => {
      const verificationFailure = options.failVerify === true && spec.taskKind === "apply_verify";
      if (spec.taskKind === "apply_resolve") {
        const outputDir = join(spec.cwd, reservedOutputRelativeDirForAttempt(spec.attemptId));
        await mkdir(outputDir, { recursive: true });
        await writeFile(
          join(outputDir, "result.json"),
          `${JSON.stringify(
            {
              path: options.resolvePath ?? "README.md",
              resolvedContent: options.resolveContent ?? "hello\nfrom source and candidate\n",
              rationale:
                options.resolveRationale ?? "reconciled the source context with the candidate change",
              confidence: options.resolveConfidence ?? "high",
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
      return {
        events: [],
        result: {
          schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
          taskId: spec.taskId,
          sessionId: spec.sessionId,
          status: verificationFailure ? "failed" : "succeeded",
          summary: verificationFailure ? "verification failed" : "verification passed",
          startedAt: "2026-04-19T00:00:00.000Z",
          finishedAt: "2026-04-19T00:00:01.000Z",
          exitCode: verificationFailure ? 1 : 0,
          command: spec.prompt,
          cwd: spec.cwd,
          shell: "bash",
          timeoutSeconds: spec.budget.timeoutSeconds,
          durationMs: 1000,
          exitSignal: null,
          stdout: verificationFailure ? "verification failed" : "verification passed",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          assumeDangerousSkipPermissions: false,
        },
        workerErrors: [],
        rawOutput: verificationFailure ? "verification failed" : "verification passed",
        ok: !verificationFailure,
        metadata: {},
      };
    },
  }) as ABoxTaskRunner;

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

test("retry: emits host_retry transition extending prior chain and records new attempt", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-retry";
    const turnId = "turn-1";
    const sourceAttemptId = "attempt-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: sourceAttemptId,
      seedTransition: true,
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId,
      storageRoot,
      action: { kind: "retry" },
    });

    assert.ok(result.transition, "expected transition on retry path");
    assert.equal(result.transition?.reason, "host_retry");
    assert.equal(result.transition?.depth, 1);
    assert.equal(result.transition?.toStatus, "queued");
    assert.ok(result.newAttemptId, "expected newAttemptId on retry path");
    assert.match(result.message, /Retry queued/u);

    const session = await store.loadSession(sessionId);
    assert.ok(session);
    const turn = session.turns.find((t) => t.turnId === turnId);
    assert.ok(turn);
    const newAttempt = turn.attempts.find((a) => a.attemptId === result.newAttemptId);
    assert.ok(newAttempt);
    assert.equal(newAttempt.parentAttemptId, sourceAttemptId);
    assert.equal(newAttempt.retryReason, "host retry requested");
    assert.equal(newAttempt.status, "queued");
  });
});

test("retry: without a prior transition starts a fresh chain at depth 0", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-retry-no-prior";
    const turnId = "turn-1";
    await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "retry" },
    });

    assert.ok(result.transition);
    assert.equal(result.transition?.depth, 0);
    assert.match(result.transition?.chainId ?? "", /^chain-/u);
  });
});

// ---------------------------------------------------------------------------
// retry_refine
// ---------------------------------------------------------------------------

test("retry_refine: emits host_retry_refine transition and carries refinement in retryReason", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-refine";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
      seedTransition: true,
    });
    const refinement = "retry this time with --verbose";

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "retry_refine", refinement },
    });

    assert.equal(result.transition?.reason, "host_retry_refine");
    assert.ok(result.newAttemptId);
    assert.match(result.message, /verbose/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    const newAttempt = turn?.attempts.find((a) => a.attemptId === result.newAttemptId);
    assert.equal(newAttempt?.retryReason, refinement);
    assert.equal(newAttempt?.parentAttemptId, "attempt-1");
  });
});

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

test("ask_user: returns a question-bearing message and emits NO transition", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-ask";
    const turnId = "turn-1";
    await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const question = "Which branch should I target?";
    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "ask_user", question },
    });

    assert.equal(result.transition, undefined);
    assert.equal(result.newAttemptId, undefined);
    assert.match(result.message, new RegExp(question, "u"));
    assert.match(result.message, /Paused:/u);

    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 0, "ask_user must not emit a transition");
  });
});

// ---------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------

test("accept: updates turn status to completed and emits NO transition", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "accept" },
    });

    assert.equal(result.transition, undefined);
    assert.equal(result.newAttemptId, undefined);
    assert.match(result.message, /accepted/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    assert.equal(turn?.status, "completed");

    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 0, "accept must not emit a transition");
  });
});

test("accept: idempotent — calling twice is safe and the second call is a no-op", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-idempotent";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
    });

    const first = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "accept" },
    });
    const second = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "accept" },
    });

    assert.match(first.message, /accepted/u);
    assert.match(second.message, /already accepted/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    assert.equal(turn?.status, "completed");
    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 0, "accept must never emit a transition — even on retry");
  });
});

test("accept: candidate-ready follow-up applies the preserved candidate through the host apply flow", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-preserved";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom preserved candidate\n", "utf8");
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      aboxBin: join(process.cwd(), "tests/helpers/mockAbox.sh"),
      runner: createApplyRunner(),
      action: { kind: "accept" },
    });

    assert.match(result.message, /accepted/u);
    const repoReadme = await readFile(join(repoRoot, "README.md"), "utf8");
    assert.equal(repoReadme, "hello\nfrom preserved candidate\n");

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((entry) => entry.turnId === turnId);
    const attempt = turn?.attempts.find((entry) => entry.attemptId === attemptId);
    assert.equal(session?.status, "completed");
    assert.equal(turn?.status, "completed");
    assert.equal(attempt?.status, "succeeded");
    assert.equal(attempt?.candidateState, "applied");
    assert.equal(attempt?.candidate?.state, "applied");
    assert.equal(attempt?.candidate?.driftDecision, "allowed");
    assert.equal(attempt?.reviewRecord?.outcome, "success");
    assert.equal(attempt?.reviewRecord?.action, "accept");
    assert.equal(turn?.latestReview?.action, "accept");

    const discovered = await discoverWorktree(repoRoot, sandboxTaskId);
    assert.equal(discovered, null);
  });
});

test("accept: committed-only preserved candidates apply through the same host flow", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-committed";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const fixture = await createCandidateApplyFixture(storageRoot, {
      candidateState: "committed",
      sourceState: "clean",
    });
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, fixture.repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot: fixture.repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId: fixture.sandboxTaskId,
          worktreePath: fixture.worktreePath,
          branchName: `refs/heads/agent/${fixture.sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changeKind: "committed",
          changedFiles: ["README.md", "src/candidate-only.txt"],
          committedFiles: ["README.md", "src/candidate-only.txt"],
          dirtyFiles: [],
          outputArtifacts: [],
          sourceBaseline: fixture.sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      aboxBin: join(process.cwd(), "tests/helpers/mockAbox.sh"),
      runner: createApplyRunner(),
      action: { kind: "accept" },
    });

    assert.match(result.message, /accepted/u);
    assert.match(await readFile(join(fixture.repoRoot, "README.md"), "utf8"), /Alpha candidate/u);
    assert.equal(
      await readFile(join(fixture.repoRoot, "src", "candidate-only.txt"), "utf8"),
      "committed candidate file\n",
    );

    const attempt = (await store.loadSession(sessionId))?.turns[0]?.attempts[0];
    assert.equal(attempt?.candidateState, "applied");
    assert.equal(attempt?.candidate?.changeKind, "committed");
  });
});

test("accept: mixed preserved candidates reconcile non-overlapping local edits", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-mixed";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const fixture = await createCandidateApplyFixture(storageRoot, {
      candidateState: "mixed",
      sourceState: "non_overlap",
    });
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, fixture.repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot: fixture.repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId: fixture.sandboxTaskId,
          worktreePath: fixture.worktreePath,
          branchName: `refs/heads/agent/${fixture.sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changeKind: "mixed",
          changedFiles: ["README.md", "src/candidate-only.txt", "src/module.txt"],
          committedFiles: ["README.md", "src/candidate-only.txt"],
          dirtyFiles: ["src/module.txt"],
          outputArtifacts: [],
          sourceBaseline: fixture.sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      aboxBin: join(process.cwd(), "tests/helpers/mockAbox.sh"),
      runner: createApplyRunner(),
      action: { kind: "accept" },
    });

    assert.match(result.message, /accepted/u);
    assert.equal(
      await readFile(join(fixture.repoRoot, "README.md"), "utf8"),
      [
        "# Candidate Apply Fixture",
        "",
        "Alpha candidate",
        "Beta source",
        "Gamma candidate",
        "",
      ].join("\n"),
    );
    assert.equal(await readFile(join(fixture.repoRoot, "src", "local-note.txt"), "utf8"), "source local note\n");
    assert.equal(
      await readFile(join(fixture.repoRoot, "src", "candidate-only.txt"), "utf8"),
      "committed candidate file\n",
    );
    assert.equal(
      await readFile(join(fixture.repoRoot, "src", "module.txt"), "utf8"),
      "base module\nmixed dirty tail\n",
    );

    const attempt = (await store.loadSession(sessionId))?.turns[0]?.attempts[0];
    assert.equal(attempt?.candidateState, "applied");
    assert.equal(attempt?.candidate?.changeKind, "mixed");
  });
});

test("accept: overlapping text conflicts auto-resolve through apply_resolve when confidence is high", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-auto-resolve";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom preserved candidate\n", "utf8");
    await writeFile(join(repoRoot, "README.md"), "hello\nfrom source repo\n", "utf8");
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      aboxBin: join(process.cwd(), "tests/helpers/mockAbox.sh"),
      runner: createApplyRunner({
        resolvePath: "README.md",
        resolveContent: "hello\nfrom source and candidate\n",
        resolveRationale: "kept the source note and preserved the candidate update",
        resolveConfidence: "high",
      }),
      action: { kind: "accept" },
    });

    assert.match(result.message, /accepted/u);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\nfrom source and candidate\n");

    const session = await store.loadSession(sessionId);
    const attempt = session?.turns[0]?.attempts.find((entry) => entry.attemptId === attemptId);
    assert.equal(attempt?.candidateState, "applied");
    assert.deepEqual(
      attempt?.candidate?.applyDispatches?.map((entry) => entry.kind),
      ["apply_resolve", "apply_verify"],
    );
    assert.equal(attempt?.candidate?.resolutions?.[0]?.status, "auto_applied");
    assert.equal(attempt?.candidate?.resolutions?.[0]?.confidence, "high");
    assert.match(attempt?.candidate?.resolutions?.[0]?.rationale ?? "", /source note/u);
  });
});

test("accept: low-confidence automatic resolution preserves the candidate for confirmation", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-low-confidence";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom preserved candidate\n", "utf8");
    await writeFile(join(repoRoot, "README.md"), "hello\nfrom source repo\n", "utf8");
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      runner: createApplyRunner({
        resolvePath: "README.md",
        resolveContent: "hello\nfrom source and candidate\n",
        resolveRationale: "this still needs user confirmation",
        resolveConfidence: "medium",
      }),
      action: { kind: "accept" },
    });

    assert.match(result.message, /needs confirmation/u);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\nfrom source repo\n");

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((entry) => entry.turnId === turnId);
    const attempt = turn?.attempts.find((entry) => entry.attemptId === attemptId);
    assert.equal(session?.status, "awaiting_user");
    assert.equal(turn?.status, "awaiting_user");
    assert.equal(attempt?.status, "blocked");
    assert.equal(attempt?.candidateState, "needs_confirmation");
    assert.equal(attempt?.candidate?.resolutions?.[0]?.status, "needs_confirmation");
    assert.equal(attempt?.candidate?.resolutions?.[0]?.confidence, "medium");
    assert.deepEqual(attempt?.candidate?.applyDispatches?.map((entry) => entry.kind), ["apply_resolve"]);
    assert.equal(attempt?.reviewRecord?.outcome, "blocked_needs_user");
    assert.equal(attempt?.reviewRecord?.action, "ask_user");
    assert.equal(turn?.latestReview?.action, "ask_user");
  });
});

test("accept: failed verification after automatic resolution falls back to needs_confirmation", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-resolve-verify-fail";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom preserved candidate\n", "utf8");
    await writeFile(join(repoRoot, "README.md"), "hello\nfrom source repo\n", "utf8");
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      runner: createApplyRunner({
        resolvePath: "README.md",
        resolveContent: "hello\nfrom source and candidate\n",
        resolveRationale: "resolved both sides before verification",
        resolveConfidence: "high",
        failVerify: true,
      }),
      action: { kind: "accept" },
    });

    assert.match(result.message, /needs confirmation/u);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\nfrom source repo\n");

    const session = await store.loadSession(sessionId);
    const attempt = session?.turns[0]?.attempts.find((entry) => entry.attemptId === attemptId);
    assert.equal(attempt?.candidateState, "needs_confirmation");
    assert.equal(attempt?.candidate?.resolutions?.[0]?.status, "auto_applied");
    assert.equal(attempt?.candidate?.applyDispatches?.map((entry) => entry.kind).join(","), "apply_resolve,apply_verify");
  });
});

test("accept: verification failure preserves the candidate and leaves the source repo unchanged", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-verify-fail";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom preserved candidate\n", "utf8");
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      runner: createApplyRunner({ failVerify: true }),
      action: { kind: "accept" },
    });

    assert.match(result.message, /could not apply the preserved candidate/u);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\n");

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((entry) => entry.turnId === turnId);
    const attempt = turn?.attempts.find((entry) => entry.attemptId === attemptId);
    assert.equal(session?.status, "failed");
    assert.equal(turn?.status, "failed");
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.candidateState, "apply_failed");
    assert.equal(attempt?.candidate?.state, "apply_failed");
    assert.equal(attempt?.candidate?.driftDecision, "allowed");

    const discovered = await discoverWorktree(repoRoot, sandboxTaskId);
    assert.ok(discovered);
  });
});

test("accept: candidate fingerprint mismatch blocks apply before source mutation", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-fingerprint-mismatch";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom preserved candidate\n", "utf8");
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          fingerprint: "deadbeef",
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      runner: createApplyRunner(),
      action: { kind: "accept" },
    });

    assert.match(result.message, /could not apply the preserved candidate/u);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\n");

    const attempt = (await store.loadSession(sessionId))?.turns[0]?.attempts[0];
    assert.equal(attempt?.candidateState, "apply_failed");
    assert.match(attempt?.candidate?.applyError ?? "", /changed after review/u);
  });
});

test("accept: drift gate blocks branch-switched source repos before apply starts", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-accept-drift-branch-switch";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom preserved candidate\n", "utf8");
    await git(repoRoot, ["checkout", "-b", "other-branch"]);
    const attemptSpec = createAttemptSpec(sessionId, turnId, attemptId, repoRoot);

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
        attemptSpec,
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      runner: createApplyRunner(),
      action: { kind: "accept" },
    });

    assert.match(result.message, /could not apply the preserved candidate/u);
    assert.equal(await readFile(join(repoRoot, "README.md"), "utf8"), "hello\n");

    const attempt = (await store.loadSession(sessionId))?.turns[0]?.attempts[0];
    assert.equal(attempt?.candidateState, "apply_failed");
    assert.equal(attempt?.candidate?.driftDecision, "blocked_branch_switched");
  });
});

// ---------------------------------------------------------------------------
// halt
// ---------------------------------------------------------------------------

test("halt: emits user_halt transition and updates turn status to cancelled", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-halt";
    const turnId = "turn-1";
    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
      turnStatus: "running",
      seedTransition: true,
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "halt" },
    });

    assert.ok(result.transition, "expected transition on halt path");
    assert.equal(result.transition?.reason, "user_halt");
    assert.equal(result.transition?.toStatus, "cancelled");
    assert.equal(result.transition?.depth, 1, "halt extends the prior chain");
    assert.match(result.message, /halted/u);

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((t) => t.turnId === turnId);
    assert.equal(turn?.status, "cancelled");

    const log = await listTurnTransitions(storageRoot, sessionId);
    // 1 seeded next_turn + 1 user_halt.
    assert.equal(log.length, 2);
  });
});

test("halt: idempotent — second call is a no-op and does not emit a second transition", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-halt-idempotent";
    const turnId = "turn-1";
    await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId: "attempt-1",
      turnStatus: "running",
    });

    const first = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "halt" },
    });
    const second = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: "attempt-1",
      storageRoot,
      action: { kind: "halt" },
    });

    assert.ok(first.transition);
    assert.match(first.message, /halted/u);
    assert.equal(second.transition, undefined);
    assert.match(second.message, /already halted/u);

    const log = await listTurnTransitions(storageRoot, sessionId);
    assert.equal(log.length, 1, "only the first halt emits a transition");
  });
});

test("halt: candidate-ready follow-up discards the preserved candidate", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-halt-preserved";
    const turnId = "turn-1";
    const attemptId = "attempt-1";
    const { repoRoot, worktreePath, sandboxTaskId, sourceBaseline } =
      await createPreservedSandboxFixture(storageRoot);
    const aboxBin = join(process.cwd(), "tests/helpers/mockAbox.sh");
    await writeFile(join(worktreePath, "README.md"), "hello\nfrom discarded candidate\n", "utf8");

    const store = await seedSession({
      storageRoot,
      sessionId,
      turnId,
      attemptId,
      repoRoot,
      turnStatus: "awaiting_user",
      attemptStatus: "blocked",
      attemptOverrides: {
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: ["README.md"],
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: "2026-04-19T00:00:00.000Z",
        },
      },
    });

    const result = await applyFollowUpAction({
      sessionId,
      turnId,
      sourceAttemptId: attemptId,
      storageRoot,
      aboxBin,
      action: { kind: "halt" },
    });

    assert.match(result.message, /preserved candidate discarded/u);
    const repoReadme = await readFile(join(repoRoot, "README.md"), "utf8");
    assert.equal(repoReadme, "hello\n");

    const session = await store.loadSession(sessionId);
    const turn = session?.turns.find((entry) => entry.turnId === turnId);
    const attempt = turn?.attempts.find((entry) => entry.attemptId === attemptId);
    assert.equal(session?.status, "cancelled");
    assert.equal(turn?.status, "cancelled");
    assert.equal(attempt?.status, "cancelled");
    assert.equal(attempt?.candidateState, "discarded");
    assert.equal(attempt?.candidate?.state, "discarded");
    assert.equal(attempt?.reviewRecord?.action, "halt");
    assert.equal(turn?.latestReview?.action, "halt");

    const discovered = await discoverWorktree(repoRoot, sandboxTaskId);
    assert.equal(discovered, null);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test("applyFollowUpAction throws for unknown session", async () => {
  await withTempRoot(async (storageRoot) => {
    await assert.rejects(
      applyFollowUpAction({
        sessionId: "missing",
        turnId: "turn-1",
        sourceAttemptId: "attempt-1",
        storageRoot,
        action: { kind: "accept" },
      }),
      /unknown session/u,
    );
  });
});

test("applyFollowUpAction throws for unknown turn within an existing session", async () => {
  await withTempRoot(async (storageRoot) => {
    const sessionId = "session-missing-turn";
    await seedSession({
      storageRoot,
      sessionId,
      turnId: "turn-1",
      attemptId: "attempt-1",
    });
    await assert.rejects(
      applyFollowUpAction({
        sessionId,
        turnId: "turn-999",
        sourceAttemptId: "attempt-1",
        storageRoot,
        action: { kind: "retry" },
      }),
      /unknown turn/u,
    );
  });
});
