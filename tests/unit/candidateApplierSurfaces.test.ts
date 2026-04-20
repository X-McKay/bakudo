import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ABoxTaskRunner, TaskExecutionRecord } from "../../src/aboxTaskRunner.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { applyPreservedCandidate } from "../../src/host/candidateApplier.js";
import { captureSourceBaseline } from "../../src/host/sourceBaseline.js";
import type { WorktreeInspection } from "../../src/host/worktreeInspector.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION } from "../../src/protocol.js";
import { SessionStore } from "../../src/sessionStore.js";
import type { SessionRecord, SessionTurnRecord } from "../../src/sessionTypes.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

const gitOut = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
};

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-candidate-surfaces-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// The mockAbox.sh script accepts `stop --clean` which is what `discardSandbox`
// uses to tear down the worktree after a successful apply. Tests that exercise
// confirmation-required paths never reach discard but still need a valid
// path, so we point every run at the shared mock.
const MOCK_ABOX = join(process.cwd(), "tests/helpers/mockAbox.sh");

type SurfaceFixture = {
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  repoRoot: string;
  worktreePath: string;
  sandboxTaskId: string;
  store: SessionStore;
  artifactStore: ArtifactStore;
  runner: ABoxTaskRunner;
  attemptSpec: AttemptSpec;
  session: SessionRecord;
};

const createRunnerStub = (): ABoxTaskRunner =>
  ({
    runAttempt: async (spec: AttemptSpec): Promise<TaskExecutionRecord> => ({
      events: [],
      result: {
        schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
        taskId: spec.taskId,
        sessionId: spec.sessionId,
        status: "succeeded",
        summary: "surface verification passed",
        startedAt: "2026-04-20T00:00:00.000Z",
        finishedAt: "2026-04-20T00:00:01.000Z",
        exitCode: 0,
        command: spec.prompt,
        cwd: spec.cwd,
        shell: "bash",
        timeoutSeconds: spec.budget.timeoutSeconds,
        durationMs: 1000,
        exitSignal: null,
        stdout: "surface verification passed",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        assumeDangerousSkipPermissions: false,
      },
      workerErrors: [],
      rawOutput: "surface verification passed",
      ok: true,
      metadata: {},
    }),
  }) as ABoxTaskRunner;

const createSurfaceFixture = async (
  storageRoot: string,
  options: {
    seedSource: (repoRoot: string) => Promise<void>;
    seedWorktree: (worktreePath: string, repoRoot: string) => Promise<void>;
    changedFiles: string[];
  },
): Promise<SurfaceFixture> => {
  const sessionId = "session-surface";
  const turnId = "turn-1";
  const attemptId = "attempt-1";
  const sandboxTaskId = "sandbox-task-1";
  const repoRoot = join(storageRoot, "repo");
  const worktreePath = join(storageRoot, "worktree-sandbox-task-1");

  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
  await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
  await writeFile(join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  await options.seedSource(repoRoot);
  await git(repoRoot, ["worktree", "add", "-b", `agent/${sandboxTaskId}`, worktreePath, "HEAD"]);
  await options.seedWorktree(worktreePath, repoRoot);

  const sourceBaseline = await captureSourceBaseline(repoRoot);
  const attemptSpec: AttemptSpec = {
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
  };

  const store = new SessionStore(storageRoot);
  const now = "2026-04-20T00:00:00.000Z";
  const turn: SessionTurnRecord = {
    turnId,
    prompt: "apply test",
    mode: "build",
    status: "awaiting_user",
    attempts: [
      {
        attemptId,
        status: "blocked",
        candidateState: "candidate_ready",
        candidate: {
          state: "candidate_ready",
          sandboxTaskId,
          worktreePath,
          branchName: `refs/heads/agent/${sandboxTaskId}`,
          reservedOutputDir: ".bakudo/out/attempt-1",
          changedFiles: options.changedFiles,
          outputArtifacts: [],
          sourceBaseline,
          driftDecision: "not_checked",
          updatedAt: now,
        },
        attemptSpec,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const session = await store.createSession({
    sessionId,
    goal: "test goal",
    repoRoot,
    status: "running",
    turns: [turn],
  });

  return {
    storageRoot,
    sessionId,
    turnId,
    attemptId,
    repoRoot,
    worktreePath,
    sandboxTaskId,
    store,
    artifactStore: new ArtifactStore(storageRoot),
    runner: createRunnerStub(),
    attemptSpec,
    session,
  };
};

type ApplyConflictArtifactEntry = {
  path: string;
  class: string;
  decision: string;
  reason: string;
  detail: string;
};

const loadApplyConflictsArtifact = async (
  fixture: SurfaceFixture,
): Promise<ApplyConflictArtifactEntry[]> => {
  const artifacts = await fixture.artifactStore.listTaskArtifacts(
    fixture.sessionId,
    fixture.attemptId,
  );
  const conflictArtifact = artifacts.find((entry) => entry.name === "apply-conflicts.json");
  assert.ok(conflictArtifact, "expected apply-conflicts.json to be registered");
  const raw = await readFile(conflictArtifact.path, "utf8");
  return JSON.parse(raw) as ApplyConflictArtifactEntry[];
};

// ---------------------------------------------------------------------------
// Symlink surface
// ---------------------------------------------------------------------------

test("applyPreservedCandidate: symlink surface requires explicit confirmation", async () => {
  await withTempRoot(async (storageRoot) => {
    const fixture = await createSurfaceFixture(storageRoot, {
      seedSource: async (repoRoot) => {
        await writeFile(join(repoRoot, "target.txt"), "target contents\n", "utf8");
        await git(repoRoot, ["add", "target.txt"]);
        await git(repoRoot, ["commit", "-m", "add symlink target"]);
      },
      seedWorktree: async (worktreePath) => {
        await symlink("target.txt", join(worktreePath, "link"));
      },
      changedFiles: ["link"],
    });

    const result = await applyPreservedCandidate({
      sessionStore: fixture.store,
      artifactStore: fixture.artifactStore,
      runner: fixture.runner,
      storageRoot: fixture.storageRoot,
      session: fixture.session,
      turnId: fixture.turnId,
      attempt: fixture.session.turns[0]!.attempts[0]!,
      attemptSpec: fixture.attemptSpec,
      aboxBin: MOCK_ABOX,
      explicitConfirmation: false,
      sourceBaseline: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!,
    });

    assert.equal(result.candidateState, "needs_confirmation");
    assert.equal(result.applyResult.needsConfirmation, true);
    // Source repo must remain untouched when confirmation is needed.
    await assert.rejects(() => readlink(join(fixture.repoRoot, "link")));

    const conflicts = await loadApplyConflictsArtifact(fixture);
    assert.equal(conflicts.length, 1);
    const conflict = conflicts[0]!;
    assert.equal(conflict.path, "link");
    assert.equal(conflict.class, "unsupported_surface");
    assert.equal(conflict.decision, "needs_confirmation");
    assert.match(conflict.reason, /symlink/u);
  });
});

test("applyPreservedCandidate: symlink surface applies when explicit confirmation is granted", async () => {
  await withTempRoot(async (storageRoot) => {
    const fixture = await createSurfaceFixture(storageRoot, {
      seedSource: async (repoRoot) => {
        await writeFile(join(repoRoot, "target.txt"), "target contents\n", "utf8");
        await git(repoRoot, ["add", "target.txt"]);
        await git(repoRoot, ["commit", "-m", "add symlink target"]);
      },
      seedWorktree: async (worktreePath) => {
        await symlink("target.txt", join(worktreePath, "link"));
      },
      changedFiles: ["link"],
    });

    const result = await applyPreservedCandidate({
      sessionStore: fixture.store,
      artifactStore: fixture.artifactStore,
      runner: fixture.runner,
      storageRoot: fixture.storageRoot,
      session: fixture.session,
      turnId: fixture.turnId,
      attempt: fixture.session.turns[0]!.attempts[0]!,
      attemptSpec: fixture.attemptSpec,
      aboxBin: MOCK_ABOX,
      explicitConfirmation: true,
      sourceBaseline: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!,
    });

    assert.equal(result.candidateState, "applied");
    assert.equal(result.applyResult.applied, true);
    assert.equal(await readlink(join(fixture.repoRoot, "link")), "target.txt");

    const artifacts = await fixture.artifactStore.listTaskArtifacts(
      fixture.sessionId,
      fixture.attemptId,
    );
    assert.equal(
      artifacts.find((entry) => entry.name === "apply-conflicts.json"),
      undefined,
      "apply-conflicts.json should not exist when symlink apply succeeds",
    );
  });
});

// ---------------------------------------------------------------------------
// Binary surface
// ---------------------------------------------------------------------------

const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

test("applyPreservedCandidate: binary surface requires explicit confirmation", async () => {
  await withTempRoot(async (storageRoot) => {
    const fixture = await createSurfaceFixture(storageRoot, {
      seedSource: async () => {
        /* no-op: binary surface arrives through the worktree */
      },
      seedWorktree: async (worktreePath) => {
        await writeFile(join(worktreePath, "icon.png"), pngMagic);
      },
      changedFiles: ["icon.png"],
    });

    const result = await applyPreservedCandidate({
      sessionStore: fixture.store,
      artifactStore: fixture.artifactStore,
      runner: fixture.runner,
      storageRoot: fixture.storageRoot,
      session: fixture.session,
      turnId: fixture.turnId,
      attempt: fixture.session.turns[0]!.attempts[0]!,
      attemptSpec: fixture.attemptSpec,
      aboxBin: MOCK_ABOX,
      explicitConfirmation: false,
      sourceBaseline: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!,
    });

    assert.equal(result.candidateState, "needs_confirmation");
    assert.equal(result.applyResult.needsConfirmation, true);
    await assert.rejects(() => readFile(join(fixture.repoRoot, "icon.png")));

    const conflicts = await loadApplyConflictsArtifact(fixture);
    assert.equal(conflicts.length, 1);
    const conflict = conflicts[0]!;
    assert.equal(conflict.path, "icon.png");
    assert.equal(conflict.class, "binary_conflict");
    assert.equal(conflict.decision, "needs_confirmation");
    assert.match(conflict.reason, /binary/u);
  });
});

test("applyPreservedCandidate: binary surface applies when explicit confirmation is granted", async () => {
  await withTempRoot(async (storageRoot) => {
    const fixture = await createSurfaceFixture(storageRoot, {
      seedSource: async () => {
        /* no-op: binary surface arrives through the worktree */
      },
      seedWorktree: async (worktreePath) => {
        await writeFile(join(worktreePath, "icon.png"), pngMagic);
      },
      changedFiles: ["icon.png"],
    });

    const result = await applyPreservedCandidate({
      sessionStore: fixture.store,
      artifactStore: fixture.artifactStore,
      runner: fixture.runner,
      storageRoot: fixture.storageRoot,
      session: fixture.session,
      turnId: fixture.turnId,
      attempt: fixture.session.turns[0]!.attempts[0]!,
      attemptSpec: fixture.attemptSpec,
      aboxBin: MOCK_ABOX,
      explicitConfirmation: true,
      sourceBaseline: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!,
    });

    assert.equal(result.candidateState, "applied");
    assert.equal(result.applyResult.applied, true);
    const written = await readFile(join(fixture.repoRoot, "icon.png"));
    assert.deepEqual(written, pngMagic);
  });
});

// ---------------------------------------------------------------------------
// Submodule surface — structural conflict, never applied even with confirmation
// ---------------------------------------------------------------------------

const SUBMODULE_PATH = "vendor/mod";

const seedSubmoduleFixture = async (storageRoot: string): Promise<SurfaceFixture> => {
  const submoduleOid = "0000000000000000000000000000000000000001";
  return createSurfaceFixture(storageRoot, {
    seedSource: async (repoRoot) => {
      // Install a gitlink at vendor/mod pointing at a synthetic commit oid.
      // `git update-index --add --cacheinfo 160000,<oid>,<path>` is the
      // canonical way to fabricate a submodule entry without a real remote.
      await git(repoRoot, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${submoduleOid},${SUBMODULE_PATH}`,
      ]);
      await writeFile(
        join(repoRoot, ".gitmodules"),
        `[submodule "vendor/mod"]\n\tpath = vendor/mod\n\turl = ./vendor-mod\n`,
        "utf8",
      );
      await git(repoRoot, ["add", ".gitmodules"]);
      await git(repoRoot, ["commit", "-m", "add vendor/mod gitlink"]);
    },
    seedWorktree: async () => {
      /* the gitlink is present in both trees at the worktree's base SHA */
    },
    changedFiles: [SUBMODULE_PATH],
  });
};

const submoduleInspectionFor = (fixture: SurfaceFixture): WorktreeInspection => ({
  sandboxTaskId: fixture.sandboxTaskId,
  branchName: `refs/heads/agent/${fixture.sandboxTaskId}`,
  worktreePath: fixture.worktreePath,
  reservedOutputDir: ".bakudo/out/attempt-1",
  baselineHeadSha: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!.headSha,
  currentHeadSha: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!.headSha,
  dirty: false,
  changedFiles: [SUBMODULE_PATH],
  repoChangedFiles: [SUBMODULE_PATH],
  dirtyFiles: [],
  committedFiles: [SUBMODULE_PATH],
  changeKind: "committed",
  outputArtifacts: [],
  patchDiff: "",
  diffBytes: 0,
});

test("applyPreservedCandidate: submodule surface fails without confirmation", async () => {
  await withTempRoot(async (storageRoot) => {
    const fixture = await seedSubmoduleFixture(storageRoot);
    const result = await applyPreservedCandidate({
      sessionStore: fixture.store,
      artifactStore: fixture.artifactStore,
      runner: fixture.runner,
      storageRoot: fixture.storageRoot,
      session: fixture.session,
      turnId: fixture.turnId,
      attempt: fixture.session.turns[0]!.attempts[0]!,
      attemptSpec: fixture.attemptSpec,
      aboxBin: MOCK_ABOX,
      explicitConfirmation: false,
      sourceBaseline: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!,
      inspection: submoduleInspectionFor(fixture),
    });

    assert.equal(result.candidateState, "apply_failed");
    assert.ok(result.applyResult.error);
    // createApplyWorkspace rejects the 160000 gitlink via
    // ApplyWorkspaceUnsupportedSurfaceError before stagePathResolution runs.
    // Pin the exact workspace-level error string so any re-introduction of a
    // stagePathResolution submodule branch (which produces a different string)
    // is caught immediately.
    assert.match(result.applyResult.error ?? "", /Apply workspace does not support:.*submodule_path/u);
    assert.equal(result.candidateUpdates.driftDecision, "allowed");
    await assertSubmoduleHardFailureArtifacts(fixture);
  });
});

test("applyPreservedCandidate: submodule surface fails even when explicit confirmation is granted", async () => {
  await withTempRoot(async (storageRoot) => {
    const fixture = await seedSubmoduleFixture(storageRoot);
    const result = await applyPreservedCandidate({
      sessionStore: fixture.store,
      artifactStore: fixture.artifactStore,
      runner: fixture.runner,
      storageRoot: fixture.storageRoot,
      session: fixture.session,
      turnId: fixture.turnId,
      attempt: fixture.session.turns[0]!.attempts[0]!,
      attemptSpec: fixture.attemptSpec,
      aboxBin: MOCK_ABOX,
      explicitConfirmation: true,
      sourceBaseline: fixture.session.turns[0]!.attempts[0]!.candidate!.sourceBaseline!,
      inspection: submoduleInspectionFor(fixture),
    });

    // Submodule paths short-circuit to apply_failed regardless of
    // explicitConfirmation — the createApplyWorkspace gate fails before
    // the reconcile path is entered.
    assert.equal(result.candidateState, "apply_failed");
    assert.ok(result.applyResult.error);
    // Same workspace-level rejection as the no-confirmation case: pin the
    // ApplyWorkspaceUnsupportedSurfaceError string so stagePathResolution
    // cannot silently take over this path.
    assert.match(result.applyResult.error ?? "", /Apply workspace does not support:.*submodule_path/u);

    // Sanity: the source repo's gitlink tree is untouched.
    const lsTree = await gitOut(fixture.repoRoot, ["ls-tree", "HEAD", "vendor/mod"]);
    assert.match(lsTree, /^160000 commit /u);
    await assertSubmoduleHardFailureArtifacts(fixture);
  });
});

// On the submodule hard-failure path, `createApplyWorkspace` throws before
// stagePathResolution or apply-conflicts.json are reached. The applier
// nonetheless persists the fingerprint and drift reports; pin that set so a
// refactor that changes the artifact surface has to update this assertion.
const assertSubmoduleHardFailureArtifacts = async (fixture: SurfaceFixture): Promise<void> => {
  const artifacts = await fixture.artifactStore.listTaskArtifacts(
    fixture.sessionId,
    fixture.attemptId,
  );
  const names = new Set(artifacts.map((entry) => entry.name));
  assert.ok(names.has("apply-fingerprint-check.json"), "expected apply-fingerprint-check.json");
  assert.ok(names.has("apply-drift-report.json"), "expected apply-drift-report.json");
  assert.equal(
    names.has("apply-conflicts.json"),
    false,
    "apply-conflicts.json must not be emitted when createApplyWorkspace rejects the source",
  );
  assert.equal(
    names.has("apply-source-status.json"),
    false,
    "apply-source-status.json is only written after createApplyWorkspace succeeds",
  );
};
