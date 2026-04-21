/**
 * Wave 4: Cognitive Layer unit tests.
 *
 * Tests the Critic runner, Post-Mortem extraction, Curator trigger,
 * Janitor cleanup, and the Critic/Curator integration in the
 * ObjectiveController failure path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Mutex } from "async-mutex";
import {
  CRITIC_PROMPT,
  runCritic,
  isValidPostMortem,
  extractPostMortem,
} from "../../src/worker/criticRunner.js";
import {
  CURATOR_PROMPT,
  MEMORY_ROOT,
  EPISODIC_DIR,
  SEMANTIC_DIR,
  episodicTranscriptPath,
} from "../../src/daemon/curator.js";
import {
  runJanitor,
  DEFAULT_JANITOR_CONFIG,
} from "../../src/daemon/janitor.js";
import { createObjective, createCampaign } from "../../src/host/orchestration/objectiveState.js";
import { ObjectiveController } from "../../src/host/orchestration/objectiveController.js";
import type { ABoxTaskRunner, TaskExecutionRecord } from "../../src/aboxTaskRunner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRecord = (stdout: string, ok = true): TaskExecutionRecord => ({
  events: [],
  ok,
  rawOutput: stdout,
  workerErrors: [],
  result: {
    schemaVersion: 1 as const,
    taskId: "task-1",
    sessionId: "session-1",
    status: ok ? "succeeded" : "failed",
    summary: ok ? "done" : "failed",
    exitCode: ok ? 0 : 1,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    exitSignal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    assumeDangerousSkipPermissions: false,
    command: "claude --print-responses",
    cwd: "/workspace",
    shell: "/bin/sh",
    timeoutSeconds: 120,
  },
});

const mockMutex = new Mutex();

// ---------------------------------------------------------------------------
// Critic runner
// ---------------------------------------------------------------------------

test("criticRunner: CRITIC_PROMPT is non-empty and mentions LESSON LEARNED", () => {
  assert.ok(CRITIC_PROMPT.length > 0);
  assert.ok(CRITIC_PROMPT.includes("LESSON LEARNED"), "prompt should define LESSON LEARNED contract");
  assert.ok(CRITIC_PROMPT.includes("Post-Mortem"), "prompt should mention Post-Mortem");
});

test("criticRunner: runCritic returns critic provider command", () => {
  const result = runCritic("transcript here", "diff here");
  assert.equal(result.command[0], "claude");
  assert.ok(result.command.includes("--print-responses"));
});

test("criticRunner: runCritic injects transcript and diff into stdin", () => {
  const result = runCritic("worker output", "git diff output");
  assert.ok(result.stdin?.includes("TRANSCRIPT:"), "stdin should contain TRANSCRIPT section");
  assert.ok(result.stdin?.includes("worker output"), "stdin should contain transcript content");
  assert.ok(result.stdin?.includes("DIFF:"), "stdin should contain DIFF section");
  assert.ok(result.stdin?.includes("git diff output"), "stdin should contain diff content");
});

test("criticRunner: runCritic uses placeholder for empty diff", () => {
  const result = runCritic("transcript", "");
  assert.ok(result.stdin?.includes("no diff"), "stdin should mention no diff for empty diff");
});

test("criticRunner: runCritic sets BAKUDO_CRITIC_MODE env var", () => {
  const result = runCritic("transcript", "diff");
  assert.equal(result.env?.BAKUDO_CRITIC_MODE, "1");
});

// ---------------------------------------------------------------------------
// Post-Mortem validation
// ---------------------------------------------------------------------------

test("criticRunner: isValidPostMortem returns true for valid post-mortem", () => {
  assert.equal(isValidPostMortem("LESSON LEARNED: Worker used npm instead of pnpm."), true);
});

test("criticRunner: isValidPostMortem returns false for missing LESSON LEARNED", () => {
  assert.equal(isValidPostMortem("The worker failed because of a syntax error."), false);
});

test("criticRunner: isValidPostMortem returns false for empty string", () => {
  assert.equal(isValidPostMortem(""), false);
});

test("criticRunner: extractPostMortem extracts from valid output", () => {
  const output = "Some preamble\nLESSON LEARNED: Worker used npm.\nRoot cause: wrong package manager.";
  const result = extractPostMortem(output);
  assert.ok(result !== null);
  assert.ok(result.startsWith("LESSON LEARNED:"));
  assert.ok(result.includes("Root cause:"));
});

test("criticRunner: extractPostMortem returns null for output without LESSON LEARNED", () => {
  const result = extractPostMortem("No lesson here.");
  assert.equal(result, null);
});

test("criticRunner: extractPostMortem trims leading/trailing whitespace", () => {
  const result = extractPostMortem("  LESSON LEARNED: test  ");
  assert.ok(result !== null);
  assert.equal(result, "LESSON LEARNED: test");
});

// ---------------------------------------------------------------------------
// Curator constants
// ---------------------------------------------------------------------------

test("curator: CURATOR_PROMPT mentions critical rules", () => {
  assert.ok(CURATOR_PROMPT.includes("CRITICAL RULES"), "prompt should define critical rules");
  assert.ok(CURATOR_PROMPT.includes("MUST NEVER push"), "prompt should prohibit push");
  assert.ok(CURATOR_PROMPT.includes("MUST NEVER"), "prompt should contain MUST NEVER constraints");
});

test("curator: memory paths are correctly defined", () => {
  assert.equal(MEMORY_ROOT, ".bakudo/memory");
  assert.equal(EPISODIC_DIR, ".bakudo/memory/episodic");
  assert.equal(SEMANTIC_DIR, ".bakudo/memory/semantic");
});

test("curator: episodicTranscriptPath builds correct path", () => {
  const p = episodicTranscriptPath("attempt-123", "/repo");
  assert.equal(p, "/repo/.bakudo/memory/episodic/attempt-123.txt");
});

// ---------------------------------------------------------------------------
// Janitor
// ---------------------------------------------------------------------------

test("janitor: DEFAULT_JANITOR_CONFIG has expected values", () => {
  assert.equal(DEFAULT_JANITOR_CONFIG.retentionDays, 7);
  assert.equal(DEFAULT_JANITOR_CONFIG.maxTranscripts, 100);
});

test("janitor: runJanitor returns empty result when episodic dir doesn't exist", async () => {
  const tmpDir = path.join(tmpdir(), `bakudo-test-${Date.now()}`);
  const result = await runJanitor(tmpDir);
  assert.equal(result.deleted, 0);
  assert.equal(result.retained, 0);
  assert.deepEqual(result.deletedPaths, []);
  assert.deepEqual(result.errors, []);
});

test("janitor: runJanitor deletes files older than retentionDays", async () => {
  const tmpDir = path.join(tmpdir(), `bakudo-test-${Date.now()}`);
  const episodicPath = path.join(tmpDir, EPISODIC_DIR);
  await mkdir(episodicPath, { recursive: true });

  // Create a file with an old mtime (simulate old transcript)
  const oldFile = path.join(episodicPath, "old-transcript.txt");
  await writeFile(oldFile, "old transcript");

  // Manually set the mtime to 8 days ago
  const { utimes } = await import("node:fs/promises");
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(oldFile, oldDate, oldDate);

  const result = await runJanitor(tmpDir, { retentionDays: 7 });
  assert.equal(result.deleted, 1);
  assert.equal(result.retained, 0);
  assert.ok(result.deletedPaths[0]?.includes("old-transcript.txt"));
});

test("janitor: runJanitor retains files within retentionDays", async () => {
  const tmpDir = path.join(tmpdir(), `bakudo-test-${Date.now()}`);
  const episodicPath = path.join(tmpDir, EPISODIC_DIR);
  await mkdir(episodicPath, { recursive: true });

  // Create a recent file
  const recentFile = path.join(episodicPath, "recent-transcript.txt");
  await writeFile(recentFile, "recent transcript");

  const result = await runJanitor(tmpDir, { retentionDays: 7 });
  assert.equal(result.deleted, 0);
  assert.equal(result.retained, 1);
});

test("janitor: runJanitor deletes oldest files when maxTranscripts exceeded", async () => {
  const tmpDir = path.join(tmpdir(), `bakudo-test-${Date.now()}`);
  const episodicPath = path.join(tmpDir, EPISODIC_DIR);
  await mkdir(episodicPath, { recursive: true });

  const { utimes } = await import("node:fs/promises");

  // Create 5 files with different mtimes
  for (let i = 0; i < 5; i++) {
    const filePath = path.join(episodicPath, `transcript-${i}.txt`);
    await writeFile(filePath, `transcript ${i}`);
    const fileDate = new Date(Date.now() - (5 - i) * 60 * 1000); // 5, 4, 3, 2, 1 minutes ago
    await utimes(filePath, fileDate, fileDate);
  }

  // With maxTranscripts=3, the 2 oldest should be deleted
  const result = await runJanitor(tmpDir, { retentionDays: 365, maxTranscripts: 3 });
  assert.equal(result.deleted, 2);
  assert.equal(result.retained, 3);
});

// ---------------------------------------------------------------------------
// ObjectiveController: Critic/Curator integration
// ---------------------------------------------------------------------------

test("objectiveController: triggers Critic when campaign fails", async () => {
  const obj = createObjective("obj-1", "Refactor auth");
  const architectOutput = JSON.stringify([
    { campaignId: "write-jwt", description: "Implement JWT utility" },
  ]);

  const calls: string[] = [];
  let callCount = 0;
  const mockRunner = {
    runAttempt: async (spec: { sessionId: string }) => {
      callCount++;
      calls.push(spec.sessionId);
      if (callCount === 1) return makeRecord(architectOutput); // Architect
      if (callCount === 2) return makeRecord("compilation error", false); // Worker fails
      // Critic call
      return makeRecord("LESSON LEARNED: Worker used wrong command.\nRoot cause: test.");
    },
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);
  await controller.advance(); // Decompose

  // Inject a candidate
  const campaign = controller.state.campaigns[0] as typeof controller.state.campaigns[0] & {
    candidateSet: { candidates: unknown[] };
  };
  campaign.candidateSet.candidates = [
    {
      schemaVersion: 1,
      candidateId: "cand-1",
      profile: { providerId: "codex", sandboxLifecycle: "preserved", candidatePolicy: "discard" },
      spec: {
        schemaVersion: 3,
        sessionId: "s1",
        turnId: "t1",
        attemptId: "a1",
        taskId: "tk1",
        intentId: "i1",
        mode: "build",
        taskKind: "assistant_job",
        prompt: "implement",
        instructions: [],
        cwd: "/tmp",
        execution: { engine: "agent_cli" },
        permissions: { rules: [], allowAllTools: false, noAskUser: false },
        budget: { timeoutSeconds: 60, maxOutputBytes: 131072, heartbeatIntervalMs: 5000 },
        acceptanceChecks: [],
        artifactRequests: [],
      },
    },
  ];

  await controller.advance(); // Execute + Critic

  // Verify the campaign failed
  assert.equal(controller.state.campaigns[0]?.status, "failed");
  // Verify the Critic was called (callCount should be > 2)
  assert.ok(callCount >= 3, `Expected at least 3 calls (Architect + Worker + Critic), got ${callCount}`);
});

test("objectiveController: Critic failure is non-fatal", async () => {
  const obj = createObjective("obj-1", "Refactor auth");
  const architectOutput = JSON.stringify([
    { campaignId: "write-jwt", description: "Implement JWT utility" },
  ]);

  let callCount = 0;
  const mockRunner = {
    runAttempt: async () => {
      callCount++;
      if (callCount === 1) return makeRecord(architectOutput); // Architect
      if (callCount === 2) return makeRecord("compilation error", false); // Worker fails
      throw new Error("Critic agent crashed"); // Critic throws
    },
  } as unknown as ABoxTaskRunner;

  const controller = new ObjectiveController(obj, mockRunner, mockMutex);
  await controller.advance(); // Decompose

  const campaign = controller.state.campaigns[0] as typeof controller.state.campaigns[0] & {
    candidateSet: { candidates: unknown[] };
  };
  campaign.candidateSet.candidates = [
    {
      schemaVersion: 1,
      candidateId: "cand-1",
      profile: { providerId: "codex", sandboxLifecycle: "preserved", candidatePolicy: "discard" },
      spec: {
        schemaVersion: 3,
        sessionId: "s1",
        turnId: "t1",
        attemptId: "a1",
        taskId: "tk1",
        intentId: "i1",
        mode: "build",
        taskKind: "assistant_job",
        prompt: "implement",
        instructions: [],
        cwd: "/tmp",
        execution: { engine: "agent_cli" },
        permissions: { rules: [], allowAllTools: false, noAskUser: false },
        budget: { timeoutSeconds: 60, maxOutputBytes: 131072, heartbeatIntervalMs: 5000 },
        acceptanceChecks: [],
        artifactRequests: [],
      },
    },
  ];

  // Should not throw even though Critic throws
  await assert.doesNotReject(() => controller.advance());
  // Campaign should still be marked as failed
  assert.equal(controller.state.campaigns[0]?.status, "failed");
});

// ---------------------------------------------------------------------------
// Provider registry: Wave 4 providers
// ---------------------------------------------------------------------------

test("providerRegistry: critic provider is registered", async () => {
  const { providerRegistry } = await import("../../src/host/providerRegistry.js");
  const critic = providerRegistry.get("critic");
  assert.equal(critic.id, "critic");
  assert.equal(critic.name, "Reflection Agent");
  assert.ok(critic.requiredPolicies.includes("anthropic-api"));
});

test("providerRegistry: curator provider is registered", async () => {
  const { providerRegistry } = await import("../../src/host/providerRegistry.js");
  const curator = providerRegistry.get("curator");
  assert.equal(curator.id, "curator");
  assert.equal(curator.name, "Memory Consolidation Agent");
  assert.ok(curator.requiredPolicies.includes("anthropic-api"));
  assert.ok(curator.requiredPolicies.includes("git-write"));
});
