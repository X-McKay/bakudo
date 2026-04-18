import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { SessionEventKind } from "../../src/protocol.js";
import type { SessionRecord } from "../../src/sessionTypes.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../src/sessionTypes.js";
import {
  classifyLockReport,
  classifyRecoveryVerdict,
  recoverState,
  type RecoveryReport,
} from "../../src/host/recovery.js";
import { sessionLockFilePath } from "../../src/host/lockFile.js";

const NOW_ISO = "2026-04-18T10:00:00.000Z";

const baseSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  sessionId: "s-1",
  repoRoot: ".",
  title: "t",
  status: "running",
  turns: [],
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
  ...overrides,
});

const createTempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-recovery-"));

// ---------------------------------------------------------------------------
// classifyRecoveryVerdict — required failure case coverage
// ---------------------------------------------------------------------------

test("recovery case 1: host crashes after session creation but before attempt dispatch", () => {
  const session = baseSession({
    turns: [
      {
        turnId: "turn-1",
        prompt: "build me a thing",
        mode: "build",
        status: "queued",
        attempts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
  });
  const verdict = classifyRecoveryVerdict(session, new Set<SessionEventKind>());
  assert.equal(verdict.kind, "queued_no_attempt");
  if (verdict.kind !== "queued_no_attempt") return;
  assert.equal(verdict.turnId, "turn-1");
});

test("recovery case 2: host crashes during worker execution (no terminal event)", () => {
  const session = baseSession({
    turns: [
      {
        turnId: "turn-1",
        prompt: "do a thing",
        mode: "build",
        status: "running",
        attempts: [
          {
            attemptId: "a-1",
            status: "running",
          },
        ],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
  });
  const verdict = classifyRecoveryVerdict(
    session,
    new Set<SessionEventKind>(["worker.attempt_started"]),
  );
  assert.equal(verdict.kind, "running_incomplete");
  if (verdict.kind !== "running_incomplete") return;
  assert.equal(verdict.attemptId, "a-1");
  assert.match(verdict.detail, /inspect required/);
});

test("recovery case 3: host crashes after worker completion but before review persistence", () => {
  const session = baseSession({
    turns: [
      {
        turnId: "turn-1",
        prompt: "do",
        mode: "build",
        status: "reviewing",
        attempts: [
          {
            attemptId: "a-1",
            status: "succeeded",
          },
        ],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        // No `latestReview` — the review pass never completed.
      },
    ],
  });
  const verdict = classifyRecoveryVerdict(
    session,
    new Set<SessionEventKind>(["worker.attempt_completed"]),
  );
  assert.equal(verdict.kind, "finished_no_review");
});

test("recovery: healthy session (review completed) → no action", () => {
  const session = baseSession({
    turns: [
      {
        turnId: "turn-1",
        prompt: "x",
        mode: "build",
        status: "completed",
        attempts: [{ attemptId: "a-1", status: "succeeded" }],
        latestReview: {
          reviewId: "r-1",
          attemptId: "a-1",
          outcome: "success",
          action: "accept",
          reviewedAt: NOW_ISO,
        },
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
  });
  const verdict = classifyRecoveryVerdict(
    session,
    new Set<SessionEventKind>(["worker.attempt_completed", "host.review_completed"]),
  );
  assert.equal(verdict.kind, "healthy");
});

test("recovery: running attempt WITH terminal worker event but missing review → finished_no_review", () => {
  // Covers the case where the worker terminal event landed but the attempt
  // record was not updated (partial persistence) — we still want to run
  // review recovery rather than treat as running_incomplete.
  const session = baseSession({
    turns: [
      {
        turnId: "turn-1",
        prompt: "x",
        mode: "build",
        status: "running",
        attempts: [{ attemptId: "a-1", status: "succeeded" }],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
  });
  const verdict = classifyRecoveryVerdict(
    session,
    new Set<SessionEventKind>(["worker.attempt_completed"]),
  );
  assert.equal(verdict.kind, "finished_no_review");
});

test("recovery: latestReview pointing at an older attempt → still finished_no_review", () => {
  const session = baseSession({
    turns: [
      {
        turnId: "turn-1",
        prompt: "x",
        mode: "build",
        status: "running",
        attempts: [
          { attemptId: "a-1", status: "succeeded" },
          { attemptId: "a-2", status: "succeeded" },
        ],
        latestReview: {
          reviewId: "r-1",
          attemptId: "a-1",
          outcome: "retryable_failure",
          action: "retry",
          reviewedAt: NOW_ISO,
        },
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
  });
  const verdict = classifyRecoveryVerdict(
    session,
    new Set<SessionEventKind>(["worker.attempt_completed"]),
  );
  assert.equal(verdict.kind, "finished_no_review");
});

// ---------------------------------------------------------------------------
// Stale-lock detection (plan 187-196)
// ---------------------------------------------------------------------------

test("recovery: stale lock report — dead PID", () => {
  const report = classifyLockReport(
    {
      kind: "present",
      path: "/tmp/x/.lock",
      lock: { sessionId: "s1", ownerPid: 42, acquiredAt: NOW_ISO },
      mtimeMs: Date.now(),
    },
    { pidAlive: () => false },
  );
  assert.equal(report.kind, "stale");
  if (report.kind !== "stale") return;
  assert.equal(report.ownerPid, 42);
  assert.equal(report.reason.reason, "pid_dead");
});

test("recovery: live lock report — PID is alive", () => {
  const report = classifyLockReport(
    {
      kind: "present",
      path: "/tmp/x/.lock",
      lock: { sessionId: "s1", ownerPid: 42, acquiredAt: NOW_ISO },
      mtimeMs: Date.now(),
    },
    { pidAlive: () => true },
  );
  assert.equal(report.kind, "held_live");
});

test("recovery: missing lock report", () => {
  const report = classifyLockReport({ kind: "missing", path: "/tmp/x/.lock" });
  assert.equal(report.kind, "absent");
});

test("recovery: corrupt lock report carries reason", () => {
  const report = classifyLockReport({
    kind: "corrupt",
    path: "/tmp/x/.lock",
    reason: "lock file schema mismatch",
  });
  assert.equal(report.kind, "corrupt");
});

// ---------------------------------------------------------------------------
// recoverState (integration of classify* with real fs readers)
// ---------------------------------------------------------------------------

test("recoverState: queued_no_attempt → blocksResume = false", async () => {
  const dir = await createTempDir();
  try {
    const session = baseSession({
      turns: [
        {
          turnId: "turn-1",
          prompt: "x",
          mode: "build",
          status: "queued",
          attempts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    });
    const report = await recoverState(session, dir, {
      loadEventKinds: async () => new Set(),
    });
    assert.equal(report.verdict.kind, "queued_no_attempt");
    assert.equal(report.blocksResume, false);
    assert.equal(report.code, "recovery.queued_no_attempt");
    assert.equal(report.lock.kind, "absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recoverState: running_incomplete → blocksResume = true", async () => {
  const dir = await createTempDir();
  try {
    const session = baseSession({
      turns: [
        {
          turnId: "turn-1",
          prompt: "x",
          mode: "build",
          status: "running",
          attempts: [{ attemptId: "a-1", status: "running" }],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    });
    const report = await recoverState(session, dir, {
      loadEventKinds: async () => new Set<SessionEventKind>(["worker.attempt_started"]),
    });
    assert.equal(report.verdict.kind, "running_incomplete");
    assert.equal(report.blocksResume, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recoverState: detects stale lock file alongside healthy session", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(
      sessionLockFilePath(dir),
      JSON.stringify({
        sessionId: "s-1",
        ownerPid: 777777,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    const session = baseSession({
      turns: [
        {
          turnId: "turn-1",
          prompt: "x",
          mode: "build",
          status: "completed",
          attempts: [{ attemptId: "a-1", status: "succeeded" }],
          latestReview: {
            reviewId: "r-1",
            attemptId: "a-1",
            outcome: "success",
            action: "accept",
            reviewedAt: NOW_ISO,
          },
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    });
    const report = await recoverState(session, dir, {
      loadEventKinds: async () =>
        new Set<SessionEventKind>(["worker.attempt_completed", "host.review_completed"]),
      pidAlive: () => false,
    });
    assert.equal(report.verdict.kind, "healthy");
    assert.equal(report.lock.kind, "stale");
    assert.equal(report.code, "recovery.stale_lock_detected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recoverState: user hits Ctrl+C during approval prompt — running_incomplete", async () => {
  // Ctrl+C at approval time leaves the attempt marked `running`/`queued` with
  // no terminal event. The verdict must block resume so the user inspects
  // before any further writes.
  const dir = await createTempDir();
  try {
    const session = baseSession({
      turns: [
        {
          turnId: "turn-1",
          prompt: "x",
          mode: "build",
          status: "awaiting_user",
          attempts: [{ attemptId: "a-1", status: "queued" }],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ],
    });
    const report: RecoveryReport = await recoverState(session, dir, {
      loadEventKinds: async () => new Set<SessionEventKind>(["host.approval_requested"]),
    });
    assert.equal(report.verdict.kind, "running_incomplete");
    assert.equal(report.blocksResume, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
