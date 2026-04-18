import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_RECORD_SCHEMA_VERSION,
  type ArtifactRecord,
} from "../../src/host/artifactStore.js";
import {
  buildRetentionPlan,
  DEFAULT_RETENTION_POLICY,
  decideForRecord,
  isOrphanFileBasename,
  parseDurationMs,
} from "../../src/host/retentionPolicy.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../src/sessionTypes.js";
import type { SessionRecord, SessionStatus } from "../../src/sessionTypes.js";

const buildSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  sessionId: "session-1",
  repoRoot: "/tmp/repo",
  title: "demo",
  status: "completed" as SessionStatus,
  turns: [
    {
      turnId: "turn-1",
      prompt: "do thing",
      mode: "build",
      status: "completed",
      attempts: [
        { attemptId: "attempt-1", status: "failed" },
        { attemptId: "attempt-2", status: "succeeded" },
      ],
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T00:01:00.000Z",
    },
  ],
  createdAt: "2026-04-15T00:00:00.000Z",
  updatedAt: "2026-04-15T00:01:00.000Z",
  ...overrides,
});

const buildRecord = (overrides: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactId: "artifact-x",
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  kind: "log",
  name: "worker-output.log",
  path: "artifacts/attempt-1-worker-output.log",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

// ---------------------------------------------------------------------------
// parseDurationMs
// ---------------------------------------------------------------------------

test("parseDurationMs accepts the documented forms", () => {
  assert.equal(parseDurationMs("30d"), 30 * 86_400_000);
  assert.equal(parseDurationMs("7d"), 7 * 86_400_000);
  assert.equal(parseDurationMs("6h"), 6 * 3_600_000);
  assert.equal(parseDurationMs("45m"), 45 * 60_000);
  assert.equal(parseDurationMs("30s"), 30_000);
});

test("parseDurationMs is case-insensitive and tolerates whitespace + leading +", () => {
  assert.equal(parseDurationMs(" 7D "), 7 * 86_400_000);
  assert.equal(parseDurationMs("+1h"), 3_600_000);
});

test("parseDurationMs rejects malformed input", () => {
  assert.equal(parseDurationMs(""), null);
  assert.equal(parseDurationMs("abc"), null);
  assert.equal(parseDurationMs("0d"), null);
  assert.equal(parseDurationMs("-1d"), null);
  assert.equal(parseDurationMs("1y"), null);
  assert.equal(parseDurationMs("1.5d"), null);
});

// ---------------------------------------------------------------------------
// decideForRecord — Hard rule territory
// ---------------------------------------------------------------------------

test("decideForRecord keeps result+summary+report kinds (protected_kind)", () => {
  const session = buildSession({ status: "completed" });
  for (const kind of DEFAULT_RETENTION_POLICY.protectedKinds) {
    const record = buildRecord({ kind, attemptId: "attempt-1" });
    const decision = decideForRecord(session, record, DEFAULT_RETENTION_POLICY, Date.now());
    assert.equal(decision.eligible, false, `kind ${kind} should be protected`);
  }
});

test("decideForRecord keeps latest-attempt artifacts for active sessions", () => {
  const session = buildSession({ status: "running" });
  const record = buildRecord({ attemptId: "attempt-2", kind: "log" });
  const decision = decideForRecord(session, record, DEFAULT_RETENTION_POLICY, Date.now());
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "session_active_keep_latest");
});

test("decideForRecord keeps latest-successful attempt for completed sessions", () => {
  const session = buildSession({ status: "completed" });
  const record = buildRecord({ attemptId: "attempt-2", kind: "log" });
  const decision = decideForRecord(session, record, DEFAULT_RETENTION_POLICY, Date.now());
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "session_completed_keep_success");
});

test("decideForRecord flags superseded retry log as eligible", () => {
  const session = buildSession({ status: "completed" });
  const supersededLog = buildRecord({
    attemptId: "attempt-1",
    kind: "log",
    name: "worker-output.log",
  });
  const decision = decideForRecord(session, supersededLog, DEFAULT_RETENTION_POLICY, Date.now());
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, "superseded_retry_log");
});

test("decideForRecord flags failed-intermediate aged past threshold", () => {
  const session: SessionRecord = {
    ...buildSession({ status: "failed" }),
    turns: [
      {
        turnId: "turn-1",
        prompt: "p",
        mode: "build",
        status: "failed",
        attempts: [{ attemptId: "attempt-1", status: "failed" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const aged = buildRecord({
    attemptId: "attempt-1",
    kind: "dispatch",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const now = Date.parse("2026-04-15T00:00:00.000Z"); // ~104 days later
  const decision = decideForRecord(session, aged, DEFAULT_RETENTION_POLICY, now);
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, "failed_intermediate_aged");
});

test("decideForRecord keeps fresh failed-intermediate (within threshold)", () => {
  const session: SessionRecord = {
    ...buildSession({ status: "failed" }),
    turns: [
      {
        turnId: "turn-1",
        prompt: "p",
        mode: "build",
        status: "failed",
        attempts: [{ attemptId: "attempt-1", status: "failed" }],
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:00.000Z",
      },
    ],
  };
  const fresh = buildRecord({
    attemptId: "attempt-1",
    kind: "dispatch",
    createdAt: "2026-04-14T00:00:00.000Z",
  });
  const now = Date.parse("2026-04-15T00:00:00.000Z");
  const decision = decideForRecord(session, fresh, DEFAULT_RETENTION_POLICY, now);
  assert.equal(decision.eligible, false);
});

// ---------------------------------------------------------------------------
// buildRetentionPlan
// ---------------------------------------------------------------------------

test("buildRetentionPlan produces one decision per record + carries policy snapshot", () => {
  const session = buildSession({ status: "completed" });
  const records = [
    buildRecord({ artifactId: "a", attemptId: "attempt-1", kind: "log" }),
    buildRecord({ artifactId: "b", attemptId: "attempt-2", kind: "result" }),
  ];
  const plan = buildRetentionPlan({ session, records, now: Date.now() });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.policy.intermediateKinds.length, 4);
  assert.equal(plan.items[0]?.decision.eligible, true); // superseded log
  assert.equal(plan.items[1]?.decision.eligible, false); // protected result kept
});

test("buildRetentionPlan honours policy override for intermediateMaxAgeMs", () => {
  const session: SessionRecord = {
    ...buildSession({ status: "failed" }),
    turns: [
      {
        turnId: "turn-1",
        prompt: "p",
        mode: "build",
        status: "failed",
        attempts: [{ attemptId: "attempt-1", status: "failed" }],
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:00.000Z",
      },
    ],
  };
  const records = [
    buildRecord({
      attemptId: "attempt-1",
      kind: "dispatch",
      createdAt: "2026-04-14T00:00:00.000Z",
    }),
  ];
  const now = Date.parse("2026-04-15T00:00:00.000Z");
  // Aggressive 1h threshold ⇒ the 24h-old artifact is now eligible.
  const aggressive = buildRetentionPlan({
    session,
    records,
    policy: { intermediateMaxAgeMs: 3_600_000 },
    now,
  });
  assert.equal(aggressive.items[0]?.decision.eligible, true);
});

// ---------------------------------------------------------------------------
// isOrphanFileBasename
// ---------------------------------------------------------------------------

test("isOrphanFileBasename returns false when a record matches by basename", () => {
  const records = [buildRecord({ path: "artifacts/attempt-1-result.json" })];
  assert.equal(isOrphanFileBasename("attempt-1-result.json", records), false);
});

test("isOrphanFileBasename returns true when no record matches", () => {
  const records = [buildRecord({ path: "artifacts/attempt-1-result.json" })];
  assert.equal(isOrphanFileBasename("stray.tmp", records), true);
});
