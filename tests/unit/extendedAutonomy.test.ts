/**
 * Wave 5: Extended Autonomy Tests
 *
 * Tests for:
 * - Explorer runner (reconnaissance agent)
 * - Synthesizer runner (parallel merge agent)
 * - Janitor hygiene (LLM codebase hygiene)
 * - ObjectiveController integration: Explorer before Architect, Synthesizer on multi-winner
 * - ResourceBudget Wave 5 additions
 * - ObjectiveController.isActive() helper
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Explorer runner tests
// ---------------------------------------------------------------------------

describe("explorerRunner", () => {
  it("runExplorer returns a command with the explorer provider", async () => {
    const { runExplorer } = await import("../../src/worker/explorerRunner.js");
    const result = runExplorer("Refactor auth middleware to JWT");
    assert.ok(Array.isArray(result.command), "command should be an array");
    assert.ok(result.command.length > 0, "command should not be empty");
    assert.ok(
      typeof result.stdin === "string" && result.stdin.includes("OBJECTIVE:"),
      "stdin should contain OBJECTIVE:",
    );
    assert.ok(
      result.stdin?.includes("Refactor auth middleware to JWT"),
      "stdin should contain the objective goal",
    );
    assert.strictEqual(result.env?.["BAKUDO_EXPLORER_MODE"], "1");
  });

  it("runExplorer prompt contains all five required questions", async () => {
    const { runExplorer, EXPLORER_PROMPT } = await import("../../src/worker/explorerRunner.js");
    void runExplorer("test");
    // The prompt should contain all five numbered questions
    assert.ok(EXPLORER_PROMPT.includes("1."), "prompt should contain question 1");
    assert.ok(EXPLORER_PROMPT.includes("2."), "prompt should contain question 2");
    assert.ok(EXPLORER_PROMPT.includes("3."), "prompt should contain question 3");
    assert.ok(EXPLORER_PROMPT.includes("4."), "prompt should contain question 4");
    assert.ok(EXPLORER_PROMPT.includes("5."), "prompt should contain question 5");
    assert.ok(
      EXPLORER_PROMPT.includes("Do NOT propose a plan"),
      "prompt should forbid planning",
    );
  });

  it("runExplorerRetry includes failure context in stdin", async () => {
    const { runExplorerRetry } = await import("../../src/worker/explorerRunner.js");
    const result = runExplorerRetry(
      "Add rate limiting",
      "campaign-rate-limit",
      "Worker failed because express-rate-limit API changed",
    );
    assert.ok(result.stdin?.includes("FAILED CAMPAIGN: campaign-rate-limit"));
    assert.ok(result.stdin?.includes("Worker failed because express-rate-limit API changed"));
    assert.strictEqual(result.env?.["BAKUDO_EXPLORER_RETRY"], "1");
  });

  it("isValidIntelligenceReport returns true for a valid report", async () => {
    const { isValidIntelligenceReport } = await import("../../src/worker/explorerRunner.js");
    const validReport = `
# Intelligence Report

## 1. Relevant Files
- src/auth/middleware.ts
- src/auth/jwt.ts

## 2. External Libraries
- jsonwebtoken@9.0.0

## 3. Current Behavior
The middleware uses session cookies.

## 4. Risks
1. Token expiry handling
2. Key rotation
3. CORS issues

## 5. Open Questions
- Should we support refresh tokens?
    `.trim();
    assert.ok(isValidIntelligenceReport(validReport));
  });

  it("isValidIntelligenceReport returns false for short/empty output", async () => {
    const { isValidIntelligenceReport } = await import("../../src/worker/explorerRunner.js");
    assert.ok(!isValidIntelligenceReport(""));
    assert.ok(!isValidIntelligenceReport("short"));
    assert.ok(!isValidIntelligenceReport("no heading here but some text that is long enough"));
  });

  it("criticNeedsExploration detects NEEDS_EXPLORATION signal", async () => {
    const { criticNeedsExploration } = await import("../../src/worker/explorerRunner.js");
    assert.ok(criticNeedsExploration("NEEDS_EXPLORATION: the worker misunderstood the API"));
    assert.ok(!criticNeedsExploration("LESSON LEARNED: use pnpm not npm"));
  });
});

// ---------------------------------------------------------------------------
// Synthesizer runner tests
// ---------------------------------------------------------------------------

describe("synthesizerRunner", () => {
  it("runSynthesizer returns a command with the synthesizer provider", async () => {
    const { runSynthesizer } = await import("../../src/worker/synthesizerRunner.js");
    const result = runSynthesizer(["candidate-a", "candidate-b"]);
    assert.ok(Array.isArray(result.command));
    assert.ok(result.stdin?.includes("WINNING_CANDIDATES:"));
    assert.ok(result.stdin?.includes("candidate-a"));
    assert.ok(result.stdin?.includes("candidate-b"));
    assert.strictEqual(result.env?.["BAKUDO_SYNTHESIZER_MODE"], "1");
  });

  it("SYNTHESIZER_PROMPT contains all required rules", async () => {
    const { SYNTHESIZER_PROMPT } = await import("../../src/worker/synthesizerRunner.js");
    assert.ok(SYNTHESIZER_PROMPT.includes("USE_CANDIDATE:"), "should mention USE_CANDIDATE");
    assert.ok(
      SYNTHESIZER_PROMPT.includes("MANUAL_REVIEW_REQUIRED"),
      "should mention MANUAL_REVIEW_REQUIRED",
    );
    assert.ok(
      SYNTHESIZER_PROMPT.includes("test coverage"),
      "should mention test coverage as tiebreaker",
    );
  });

  it("parseSynthesizerOutput handles USE_CANDIDATE shortcut", async () => {
    const { parseSynthesizerOutput } = await import("../../src/worker/synthesizerRunner.js");
    const output = "USE_CANDIDATE: candidate-a";
    const record = parseSynthesizerOutput(output, ["candidate-a", "candidate-b"]);
    assert.strictEqual(record.useCandidateId, "candidate-a");
    assert.deepStrictEqual(record.mergedFrom, ["candidate-a", "candidate-b"]);
    assert.ok(!record.manualReviewRequired);
  });

  it("parseSynthesizerOutput handles MANUAL_REVIEW_REQUIRED", async () => {
    const { parseSynthesizerOutput } = await import("../../src/worker/synthesizerRunner.js");
    const output = "MANUAL_REVIEW_REQUIRED";
    const record = parseSynthesizerOutput(output, ["candidate-a", "candidate-b"]);
    assert.strictEqual(record.manualReviewRequired, true);
    assert.ok(!record.useCandidateId);
  });

  it("parseSynthesizerOutput handles normal merge output", async () => {
    const { parseSynthesizerOutput } = await import("../../src/worker/synthesizerRunner.js");
    const output = `
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,5 @@
+import { rateLimit } from 'express-rate-limit';
+import { handleError } from './errors';
 export const auth = () => {};
    `.trim();
    const record = parseSynthesizerOutput(output, ["candidate-a", "candidate-b"]);
    assert.ok(!record.useCandidateId);
    assert.ok(!record.manualReviewRequired);
    assert.ok(record.rationale.includes("---"));
  });

  it("isSingleWinnerShortcut detects USE_CANDIDATE", async () => {
    const { isSingleWinnerShortcut } = await import("../../src/worker/synthesizerRunner.js");
    assert.ok(isSingleWinnerShortcut("USE_CANDIDATE: candidate-a"));
    assert.ok(!isSingleWinnerShortcut("MANUAL_REVIEW_REQUIRED"));
    assert.ok(!isSingleWinnerShortcut("--- a/src/auth.ts"));
  });

  it("isManualReviewRequired detects MANUAL_REVIEW_REQUIRED", async () => {
    const { isManualReviewRequired } = await import("../../src/worker/synthesizerRunner.js");
    assert.ok(isManualReviewRequired("MANUAL_REVIEW_REQUIRED"));
    assert.ok(!isManualReviewRequired("USE_CANDIDATE: candidate-a"));
  });

  it("extractUseCandidateId extracts the candidate ID", async () => {
    const { extractUseCandidateId } = await import("../../src/worker/synthesizerRunner.js");
    assert.strictEqual(extractUseCandidateId("USE_CANDIDATE: candidate-a"), "candidate-a");
    assert.strictEqual(extractUseCandidateId("MANUAL_REVIEW_REQUIRED"), null);
    assert.strictEqual(extractUseCandidateId("--- a/src/auth.ts"), null);
  });
});

// ---------------------------------------------------------------------------
// Janitor hygiene tests
// ---------------------------------------------------------------------------

describe("janitorHygiene", () => {
  it("JANITOR_HYGIENE_PROMPT contains required constraints", async () => {
    const { JANITOR_HYGIENE_PROMPT } = await import("../../src/daemon/janitor.js");
    assert.ok(JANITOR_HYGIENE_PROMPT.includes("NO_WORK"), "should mention NO_WORK output");
    assert.ok(
      JANITOR_HYGIENE_PROMPT.includes("FORBIDDEN"),
      "should have a FORBIDDEN section",
    );
    assert.ok(
      JANITOR_HYGIENE_PROMPT.includes("one PR"),
      "should limit to one PR per invocation",
    );
    assert.ok(
      JANITOR_HYGIENE_PROMPT.includes("Merging PRs"),
      "should forbid merging PRs",
    );
  });

  it("maybeRunJanitor skips when there are active objectives", async () => {
    const { maybeRunJanitor } = await import("../../src/daemon/janitor.js");
    let dispatched = false;
    const mockRunner = {
      runAttempt: async () => {
        dispatched = true;
        return { result: { stdout: "NO_WORK", stderr: "", exitCode: 0 } };
      },
    };

    await maybeRunJanitor(
      {
        activeObjectives: () => 1, // Has active objectives
        activeSandboxes: () => 0,
      },
      mockRunner as never,
      "/tmp/test-repo",
    );

    assert.ok(!dispatched, "Janitor should not run when there are active objectives");
  });

  it("maybeRunJanitor skips when rate-limited", async () => {
    const { maybeRunJanitor } = await import("../../src/daemon/janitor.js");
    let dispatched = false;
    const mockRunner = {
      runAttempt: async () => {
        dispatched = true;
        return { result: { stdout: "NO_WORK", stderr: "", exitCode: 0 } };
      },
    };

    // lastRunAt is 30 minutes ago — within the 1-hour rate limit
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    await maybeRunJanitor(
      {
        activeObjectives: () => 0,
        activeSandboxes: () => 0,
        lastRunAt: thirtyMinutesAgo,
      },
      mockRunner as never,
      "/tmp/test-repo",
    );

    assert.ok(!dispatched, "Janitor should not run when rate-limited");
  });

  it("maybeRunJanitor skips when sandbox count is near maximum", async () => {
    const { maybeRunJanitor } = await import("../../src/daemon/janitor.js");
    const { defaultBudget } = await import(
      "../../src/host/orchestration/resourceBudget.js"
    );
    let dispatched = false;
    const mockRunner = {
      runAttempt: async () => {
        dispatched = true;
        return { result: { stdout: "NO_WORK", stderr: "", exitCode: 0 } };
      },
    };

    await maybeRunJanitor(
      {
        activeObjectives: () => 0,
        activeSandboxes: () => defaultBudget.maxConcurrentSandboxes - 1, // At the limit
      },
      mockRunner as never,
      "/tmp/test-repo",
    );

    assert.ok(!dispatched, "Janitor should not run when sandbox count is near maximum");
  });
});

// ---------------------------------------------------------------------------
// ResourceBudget Wave 5 additions
// ---------------------------------------------------------------------------

describe("resourceBudget wave5", () => {
  it("defaultBudget includes Wave 5 roles", async () => {
    const { defaultBudget } = await import(
      "../../src/host/orchestration/resourceBudget.js"
    );
    assert.ok("explorer" in defaultBudget.perRoleLimits, "should have explorer");
    assert.ok("synthesizer" in defaultBudget.perRoleLimits, "should have synthesizer");
    assert.ok("janitor" in defaultBudget.perRoleLimits, "should have janitor");
    assert.strictEqual(defaultBudget.perRoleLimits["explorer"]?.memoryMb, 1536);
    assert.strictEqual(defaultBudget.perRoleLimits["synthesizer"]?.memoryMb, 2048);
  });

  it("defaultBudget has janitor scheduling constraints", async () => {
    const { defaultBudget } = await import(
      "../../src/host/orchestration/resourceBudget.js"
    );
    assert.strictEqual(defaultBudget.janitorMaxConcurrent, 1);
    assert.strictEqual(defaultBudget.janitorRunsOnlyWhenIdle, true);
  });
});

// ---------------------------------------------------------------------------
// ObjectiveState Wave 5 additions
// ---------------------------------------------------------------------------

describe("objectiveState wave5", () => {
  it("Campaign schema accepts synthesisRecord", async () => {
    const { CampaignSchema } = await import(
      "../../src/host/orchestration/objectiveState.js"
    );
    const campaign = CampaignSchema.parse({
      campaignId: "test-campaign",
      description: "Test campaign",
      status: "completed",
      candidateSet: null,
      winnerCandidateId: "synth-attempt-123",
      synthesisRecord: {
        mergedFrom: ["candidate-a", "candidate-b"],
        rationale: "Combined A's performance with B's error handling",
      },
    });
    assert.ok(campaign.synthesisRecord !== undefined);
    assert.deepStrictEqual(campaign.synthesisRecord?.mergedFrom, [
      "candidate-a",
      "candidate-b",
    ]);
  });

  it("Campaign schema accepts needsManualReview", async () => {
    const { CampaignSchema } = await import(
      "../../src/host/orchestration/objectiveState.js"
    );
    const campaign = CampaignSchema.parse({
      campaignId: "test-campaign",
      description: "Test campaign",
      status: "completed",
      candidateSet: null,
      needsManualReview: true,
      synthesisRecord: {
        mergedFrom: ["candidate-a", "candidate-b"],
        rationale: "MANUAL_REVIEW_REQUIRED",
        manualReviewRequired: true,
      },
    });
    assert.strictEqual(campaign.needsManualReview, true);
    assert.strictEqual(campaign.synthesisRecord?.manualReviewRequired, true);
  });

  it("Objective schema accepts explorerReport", async () => {
    const { ObjectiveSchema } = await import(
      "../../src/host/orchestration/objectiveState.js"
    );
    const objective = ObjectiveSchema.parse({
      objectiveId: "obj-123",
      goal: "Refactor auth",
      status: "active",
      campaigns: [],
      explorerReport: "# Intelligence Report\n\n## Relevant Files\n- src/auth.ts",
    });
    assert.ok(objective.explorerReport?.includes("Intelligence Report"));
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry Wave 5 additions
// ---------------------------------------------------------------------------

describe("providerRegistry wave5", () => {
  it("explorer provider is registered with correct policies", async () => {
    const { providerRegistry } = await import("../../src/host/providerRegistry.js");
    const explorer = providerRegistry.get("explorer");
    assert.strictEqual(explorer.id, "explorer");
    assert.ok(explorer.requiredPolicies.includes("read-only-repo"));
    assert.ok(explorer.requiredPolicies.includes("web-read"));
    assert.ok(explorer.requiredPolicies.includes("anthropic-api"));
  });

  it("synthesizer provider is registered with correct policies", async () => {
    const { providerRegistry } = await import("../../src/host/providerRegistry.js");
    const synthesizer = providerRegistry.get("synthesizer");
    assert.strictEqual(synthesizer.id, "synthesizer");
    assert.ok(synthesizer.requiredPolicies.includes("multi-worktree-read"));
    assert.ok(synthesizer.requiredPolicies.includes("git-write"));
  });

  it("janitor provider is registered with correct policies", async () => {
    const { providerRegistry } = await import("../../src/host/providerRegistry.js");
    const janitor = providerRegistry.get("janitor");
    assert.strictEqual(janitor.id, "janitor");
    assert.ok(janitor.requiredPolicies.includes("git-write"));
    assert.ok(janitor.requiredPolicies.includes("anthropic-api"));
  });
});

// ---------------------------------------------------------------------------
// ObjectiveController.isActive() helper
// ---------------------------------------------------------------------------

describe("objectiveController.isActive", () => {
  it("isActive returns true for active objective", async () => {
    const { ObjectiveController } = await import(
      "../../src/host/orchestration/objectiveController.js"
    );
    const { createObjective } = await import(
      "../../src/host/orchestration/objectiveState.js"
    );
    const { Mutex } = await import("async-mutex");
    const mockRunner = {
      runAttempt: async () => ({
        result: { stdout: "[]", stderr: "", exitCode: 0 },
      }),
    };
    const objective = createObjective("obj-test", "Test goal");
    const controller = new ObjectiveController(
      objective,
      mockRunner as never,
      new Mutex(),
    );
    assert.ok(controller.isActive(), "should be active initially");
  });

  it("isActive returns false for completed objective", async () => {
    const { ObjectiveController } = await import(
      "../../src/host/orchestration/objectiveController.js"
    );
    const { createObjective } = await import(
      "../../src/host/orchestration/objectiveState.js"
    );
    const { Mutex } = await import("async-mutex");
    const mockRunner = {
      runAttempt: async () => ({
        result: { stdout: "[]", stderr: "", exitCode: 0 },
      }),
    };
    const objective = createObjective("obj-test", "Test goal");
    objective.status = "completed";
    const controller = new ObjectiveController(
      objective,
      mockRunner as never,
      new Mutex(),
    );
    assert.ok(!controller.isActive(), "should not be active when completed");
  });
});

// ---------------------------------------------------------------------------
// ObjectiveController multi-winner Synthesizer path
// ---------------------------------------------------------------------------

describe("objectiveController synthesizer path", () => {
  it("selects single winner without synthesis when only one candidate succeeds", async () => {
    const { ObjectiveController } = await import(
      "../../src/host/orchestration/objectiveController.js"
    );
    const { createObjective, createCampaign } = await import(
      "../../src/host/orchestration/objectiveState.js"
    );
    const { Mutex } = await import("async-mutex");

    // Mock runner: Explorer returns valid report, Architect returns one campaign,
    // Worker succeeds for candidate-a only.
    let callCount = 0;
    const mockRunner = {
      runAttempt: async (_spec: unknown, _opts: unknown, _extra: unknown, profile: { providerId: string }) => {
        callCount++;
        if (profile.providerId === "explorer") {
          return {
            ok: true,
            events: [],
            workerErrors: [],
            rawOutput: "",
            result: {
              stdout: "# Intelligence Report\n\nLong enough report with heading and content about the codebase structure and relevant files.",
              stderr: "",
              exitCode: 0,
              durationMs: 100,
              timedOut: false,
              workerErrors: [],
            },
          };
        }
        if (profile.providerId === "architect") {
          return {
            ok: true,
            events: [],
            workerErrors: [],
            rawOutput: "",
            result: {
              stdout: '[{"campaignId":"test-campaign","description":"Test campaign"}]',
              stderr: "",
              exitCode: 0,
              durationMs: 100,
              timedOut: false,
              workerErrors: [],
            },
          };
        }
        if (profile.providerId === "chaos-monkey") {
          // Chaos Monkey approves: LGTM
          return {
            ok: true,
            events: [],
            workerErrors: [],
            rawOutput: "",
            result: {
              stdout: "LGTM",
              stderr: "",
              exitCode: 0,
              durationMs: 100,
              timedOut: false,
              workerErrors: [],
            },
          };
        }
        // Worker: succeed with ok:true
        return {
          ok: true,
          events: [],
          workerErrors: [],
          rawOutput: "",
          result: {
            stdout: "done",
            stderr: "",
            exitCode: 0,
            durationMs: 100,
            timedOut: false,
            workerErrors: [],
          },
        };
      },
    };

    const objective = createObjective("obj-single-winner", "Test single winner");
    const controller = new ObjectiveController(
      objective,
      mockRunner as never,
      new Mutex(),
    );

    // First advance: Explorer + Architect decomposition
    await controller.advance();
    assert.ok(
      controller.state.explorerReport !== undefined,
      "should have explorer report after first advance",
    );
    assert.ok(
      controller.state.campaigns.length > 0,
      "should have campaigns after first advance",
    );

    // Populate one candidate
    const campaign = controller.state.campaigns[0]!;
    (campaign.candidateSet as { candidates: unknown[] }).candidates = [
      {
        schemaVersion: 1,
        candidateId: "candidate-a",
        profile: { providerId: "worker", sandboxLifecycle: "ephemeral", candidatePolicy: "discard" },
        spec: {
          schemaVersion: 3,
          sessionId: "s1",
          turnId: "t1",
          attemptId: "candidate-a",
          taskId: "task-a",
          intentId: "intent-a",
          mode: "build",
          taskKind: "assistant_job",
          prompt: "do work",
          instructions: [],
          cwd: "/tmp",
          execution: { engine: "agent_cli" },
          permissions: { rules: [], allowAllTools: false, noAskUser: true },
          budget: { timeoutSeconds: 60, maxOutputBytes: 65536, heartbeatIntervalMs: 5000 },
          acceptanceChecks: [],
          artifactRequests: [],
        },
      },
    ];

    // Second advance: execute campaign
    await controller.advance();
    assert.strictEqual(
      controller.state.campaigns[0]?.status,
      "completed",
      "campaign should be completed",
    );
    assert.ok(
      controller.state.campaigns[0]?.synthesisRecord === undefined,
      "should not have synthesis record for single winner",
    );
  });
});
