/**
 * Wave 3 + 4 + 5: Objective Controller
 *
 * The state machine that advances an Objective by:
 * 1. (Wave 5) Running the Explorer to produce an Intelligence Report.
 * 2. Using the Architect agent to decompose the Objective into Campaigns
 *    (the Architect's prompt references the Explorer's Intelligence Report).
 * 3. Dispatching the Candidates of each Campaign in parallel via
 *    `headlessExecute` (the Wave 2 Worker → Chaos Monkey loop).
 * 4. (Wave 5) Selecting the winner(s):
 *    - 0 winners: run Critic (Wave 4) → Curator (Wave 4).
 *    - 1 winner: short-circuit, no synthesis needed.
 *    - 2+ winners: run Synthesizer to merge the best ideas.
 *
 * The controller is intentionally stateful (it holds a mutable `Objective`)
 * because the Daemon Gateway owns the lifecycle of each Objective. The
 * `advance()` method is idempotent: calling it on a completed Objective is
 * a no-op.
 *
 * Git Mutex: the controller acquires `gitWriteMutex` before any write-capable
 * Campaign dispatch to prevent concurrent git operations from corrupting the
 * working tree (see `00-execution-overview.md` § Daemon-Level Git Mutex).
 */
import type { ABoxTaskRunner } from "../../aboxTaskRunner.js";
import type { DispatchPlan } from "../../attemptProtocol.js";
import { runCritic, extractPostMortem, criticNeedsExploration } from "../../worker/criticRunner.js";
import { runExplorer, runExplorerRetry, isValidIntelligenceReport } from "../../worker/explorerRunner.js";
import { runSynthesizer, parseSynthesizerOutput } from "../../worker/synthesizerRunner.js";
import { triggerCurator } from "../../daemon/curator.js";
import { headlessExecute, type HeadlessExecuteResult } from "./headlessExecute.js";
import { type Campaign, type Objective, createCampaign } from "./objectiveState.js";
import { providerRegistry } from "../providerRegistry.js";
import { defaultBudget } from "./resourceBudget.js";

// ---------------------------------------------------------------------------
// Architect decomposition prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt injected into the Architect agent to decompose an
 * Objective into a JSON array of Campaign descriptions.
 *
 * Wave 5: When an Explorer Intelligence Report is available, it is appended
 * to the prompt so the Architect can ground its plan in real codebase context.
 *
 * The Architect MUST output a JSON array of objects with `campaignId` and
 * `description` fields. Any other output format is treated as a parse error
 * and the Objective is marked as failed.
 */
const buildArchitectPrompt = (goal: string, explorerReport?: string): string => {
  const base = `
You are the Architect. Your job is to decompose a high-level software engineering goal into a list of discrete, independently-executable campaigns.

Goal: ${goal}

Output a JSON array of campaign objects. Each object MUST have:
- "campaignId": a short kebab-case identifier (e.g. "write-jwt-utility")
- "description": a one-sentence description of the campaign goal

Example output:
[
  { "campaignId": "write-jwt-utility", "description": "Implement a JWT sign/verify utility module." },
  { "campaignId": "update-middleware", "description": "Refactor the auth middleware to use the new JWT utility." },
  { "campaignId": "add-integration-tests", "description": "Add integration tests for the updated auth flow." }
]

Output ONLY the JSON array. Do not include any other text.
`.trim();

  if (explorerReport) {
    return `${base}\n\n---\nINTELLIGENCE REPORT (from Explorer):\n${explorerReport}`;
  }
  return base;
};

// ---------------------------------------------------------------------------
// ObjectiveController
// ---------------------------------------------------------------------------

export class ObjectiveController {
  constructor(
    private objective: Objective,
    private runner: ABoxTaskRunner,
    /**
     * Wave 3: Git Write Mutex acquired before write-capable Campaign dispatch.
     * Injected by the Daemon Gateway so the mutex is shared across all
     * controllers running in the same process.
     */
    private gitWriteMutex: { acquire(): Promise<() => void> },
  ) {}

  /**
   * Advance the Objective by one step:
   * - If no campaigns exist: run Explorer → decompose with Architect.
   * - Otherwise, find the next pending Campaign and execute its Candidates.
   *   - 0 winners: Critic → Curator (Wave 4).
   *   - 1 winner: short-circuit.
   *   - 2+ winners: Synthesizer (Wave 5).
   *
   * This method is idempotent: calling it on a completed or failed Objective
   * is a no-op.
   */
  async advance(): Promise<void> {
    if (
      this.objective.status === "completed" ||
      this.objective.status === "failed" ||
      this.objective.status === "paused"
    ) {
      return;
    }

    if (this.objective.campaigns.length === 0) {
      // Wave 5: Run Explorer before Architect decomposition.
      await this.runExplorerRecon();
      await this.decomposeObjective();
      if (this.objective.campaigns.length === 0) {
        // Architect failed to produce campaigns — mark objective as failed.
        this.objective.status = "failed";
        return;
      }
      // After decomposition, return so the caller can populate candidates
      // into each campaign's candidateSet before calling advance() again.
      // The campaigns are now in 'pending' status awaiting candidates.
      return;
    }

    const activeCampaign = this.objective.campaigns.find((c) => c.status === "pending");
    if (!activeCampaign) {
      // All campaigns are done — check if all completed successfully.
      const allCompleted = this.objective.campaigns.every((c) => c.status === "completed");
      this.objective.status = allCompleted ? "completed" : "failed";
      return;
    }

    activeCampaign.status = "running";

    // Respect the resource budget: cap the number of parallel candidates.
    const candidates: DispatchPlan[] = (
      activeCampaign.candidateSet?.candidates ?? []
    ).slice(0, defaultBudget.maxCandidatesPerCampaign);

    if (candidates.length === 0) {
      activeCampaign.status = "failed";
      return;
    }

    // Wave 3: Acquire the git write mutex before dispatching write-capable
    // candidates. This prevents concurrent git operations from corrupting
    // the working tree (Daemon-Level Git Mutex invariant).
    const releaseMutex = await this.gitWriteMutex.acquire();
    let results: PromiseSettledResult<HeadlessExecuteResult>[];
    try {
      // Dispatch candidates in parallel, each running the Worker → Chaos
      // Monkey loop from Wave 2.
      const promises = candidates.map((candidate) =>
        headlessExecute(candidate, this.runner),
      );
      results = await Promise.allSettled(promises);
    } finally {
      releaseMutex();
    }

    // Collect all successful candidates (Wave 5: multi-winner support).
    const winners = results
      .map((r, i) => ({ r, i }))
      .filter(
        (item): item is { r: PromiseFulfilledResult<HeadlessExecuteResult>; i: number } =>
          item.r.status === "fulfilled" && item.r.value.success,
      );

    if (winners.length === 0) {
      // All candidates failed.
      activeCampaign.status = "failed";

      // Wave 4: Cognitive reflection loop.
      // 1. Collect the transcript from the first failed candidate.
      const failedResult = results[0];
      const failedTranscript =
        failedResult?.status === "fulfilled"
          ? failedResult.value.transcript
          : "(no transcript available)";
      const failedDiff =
        failedResult?.status === "fulfilled" ? failedResult.value.diff : "";

      // 2. Run the Critic to produce a Post-Mortem.
      const criticCommand = runCritic(failedTranscript, failedDiff);
      const criticSpec = {
        schemaVersion: 3 as const,
        sessionId: `critic-${activeCampaign.campaignId}`,
        turnId: "reflect",
        attemptId: `critic-attempt-${activeCampaign.campaignId}-${Date.now()}`,
        taskId: `critic-task-${activeCampaign.campaignId}`,
        intentId: `critic-intent-${activeCampaign.campaignId}`,
        mode: "build" as const,
        taskKind: "assistant_job" as const,
        prompt: criticCommand.stdin ?? "",
        instructions: [],
        cwd: process.cwd(),
        execution: { engine: "agent_cli" as const },
        permissions: { rules: [], allowAllTools: false, noAskUser: true },
        budget: { timeoutSeconds: 120, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
        acceptanceChecks: [],
        artifactRequests: [],
      };
      const criticPlan: DispatchPlan = {
        schemaVersion: 1,
        candidateId: criticSpec.attemptId,
        profile: {
          providerId: "critic",
          resolvedCommand: providerRegistry.get("critic").command,
          sandboxLifecycle: "ephemeral" as const,
          candidatePolicy: "discard" as const,
        },
        spec: criticSpec,
      };

      try {
        const criticRecord = await this.runner.runAttempt(
          criticSpec,
          { timeoutSeconds: 120 },
          {},
          criticPlan.profile,
        );
        const criticOutput = criticRecord.result.stdout + criticRecord.result.stderr;
        const postMortem = extractPostMortem(criticOutput);

        // Wave 5: Explorer-stuck fallback.
        // If the Critic signals NEEDS_EXPLORATION, re-run the Explorer with
        // the failure context and re-decompose this Campaign.
        if (criticNeedsExploration(criticOutput)) {
          await this.runExplorerRetryForCampaign(
            activeCampaign.campaignId,
            criticOutput,
          );
        }

        // 3. If the Critic produced a valid Post-Mortem, trigger the Curator.
        if (postMortem !== null) {
          // triggerCurator acquires gitWriteMutex internally.
          await triggerCurator(postMortem, process.cwd(), this.runner);
        }
      } catch (error) {
        // Critic/Curator failures are non-fatal — log and continue.
        console.warn(
          `[ObjectiveController] Critic/Curator failed for campaign ${activeCampaign.campaignId}:`,
          error,
        );
      }
    } else if (winners.length === 1) {
      // Single winner: short-circuit, no synthesis needed.
      activeCampaign.status = "completed";
      activeCampaign.winnerCandidateId = candidates[winners[0]!.i]?.candidateId;
    } else {
      // Wave 5: Multiple winners — invoke Synthesizer.
      const winningIds = winners.map(({ i }) => candidates[i]?.candidateId ?? "");
      const synthesizerCommand = runSynthesizer(winningIds);

      const synthSpec = {
        schemaVersion: 3 as const,
        sessionId: `synthesizer-${activeCampaign.campaignId}`,
        turnId: "merge",
        attemptId: `synth-attempt-${activeCampaign.campaignId}-${Date.now()}`,
        taskId: `synth-task-${activeCampaign.campaignId}`,
        intentId: `synth-intent-${activeCampaign.campaignId}`,
        mode: "build" as const,
        taskKind: "assistant_job" as const,
        prompt: synthesizerCommand.stdin ?? "",
        instructions: [],
        cwd: process.cwd(),
        execution: { engine: "agent_cli" as const },
        permissions: { rules: [], allowAllTools: false, noAskUser: true },
        budget: { timeoutSeconds: 180, maxOutputBytes: 524288, heartbeatIntervalMs: 5000 },
        acceptanceChecks: [],
        artifactRequests: [],
      };
      const synthPlan: DispatchPlan = {
        schemaVersion: 1,
        candidateId: synthSpec.attemptId,
        profile: {
          providerId: "synthesizer",
          resolvedCommand: providerRegistry.get("synthesizer").command,
          sandboxLifecycle: "ephemeral" as const,
          candidatePolicy: "discard" as const,
        },
        spec: synthSpec,
      };

      try {
        const synthRecord = await this.runner.runAttempt(
          synthSpec,
          { timeoutSeconds: 180 },
          {},
          synthPlan.profile,
        );
        const synthOutput = synthRecord.result.stdout + synthRecord.result.stderr;
        const synthesisRecord = parseSynthesizerOutput(synthOutput, winningIds);

        activeCampaign.synthesisRecord = synthesisRecord;

        if (synthesisRecord.manualReviewRequired) {
          // Mark completed but flag for human review. MUST NOT auto-merge.
          activeCampaign.status = "completed";
          activeCampaign.needsManualReview = true;
        } else if (synthesisRecord.useCandidateId) {
          // Synthesizer chose a single winner.
          activeCampaign.status = "completed";
          activeCampaign.winnerCandidateId = synthesisRecord.useCandidateId;
        } else {
          // Synthesizer produced a merged diff.
          activeCampaign.status = "completed";
          activeCampaign.winnerCandidateId = synthSpec.attemptId;
        }
      } catch (error) {
        // Synthesizer failure: fall back to first winner.
        console.warn(
          `[ObjectiveController] Synthesizer failed for campaign ${activeCampaign.campaignId}, falling back to first winner:`,
          error,
        );
        activeCampaign.status = "completed";
        activeCampaign.winnerCandidateId = candidates[winners[0]!.i]?.candidateId;
      }
    }
  }

  /**
   * Wave 5: Run the Explorer reconnaissance agent before Architect decomposition.
   * Stores the Intelligence Report in `this.objective.explorerReport`.
   *
   * Explorer failure is non-fatal: if the Explorer fails, the Architect
   * proceeds without the report (degraded mode).
   */
  private async runExplorerRecon(): Promise<void> {
    const explorerCommand = runExplorer(this.objective.goal);
    const explorerSpec = {
      schemaVersion: 3 as const,
      sessionId: `explorer-${this.objective.objectiveId}`,
      turnId: "recon",
      attemptId: `explorer-${this.objective.objectiveId}`,
      taskId: `explorer-task-${this.objective.objectiveId}`,
      intentId: `explorer-intent-${this.objective.objectiveId}`,
      mode: "build" as const,
      taskKind: "assistant_job" as const,
      prompt: explorerCommand.stdin ?? "",
      instructions: [],
      cwd: process.cwd(),
      execution: { engine: "agent_cli" as const },
      permissions: { rules: [], allowAllTools: false, noAskUser: true },
      budget: { timeoutSeconds: 120, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
      acceptanceChecks: [],
      artifactRequests: [],
    };
    const explorerPlan: DispatchPlan = {
      schemaVersion: 1,
      candidateId: explorerSpec.attemptId,
      profile: {
        providerId: "explorer",
        resolvedCommand: providerRegistry.get("explorer").command,
        sandboxLifecycle: "ephemeral" as const,
        candidatePolicy: "discard" as const,
      },
      spec: explorerSpec,
    };

    try {
      const record = await this.runner.runAttempt(
        explorerSpec,
        { timeoutSeconds: 120 },
        {},
        explorerPlan.profile,
      );
      const explorerOutput = record.result.stdout + record.result.stderr;
      if (isValidIntelligenceReport(explorerOutput)) {
        this.objective.explorerReport = explorerOutput;
      } else {
        console.warn(
          `[ObjectiveController] Explorer produced invalid report for objective ${this.objective.objectiveId}`,
        );
      }
    } catch (error) {
      // Explorer failure is non-fatal — Architect proceeds without report.
      console.warn(
        `[ObjectiveController] Explorer failed for objective ${this.objective.objectiveId}:`,
        error,
      );
    }
  }

  /**
   * Wave 5: Re-run the Explorer with failure context when the Critic signals
   * NEEDS_EXPLORATION. Updates `this.objective.explorerReport` with the
   * updated Intelligence Report.
   */
  private async runExplorerRetryForCampaign(
    campaignId: string,
    failureContext: string,
  ): Promise<void> {
    const explorerCommand = runExplorerRetry(
      this.objective.goal,
      campaignId,
      failureContext,
    );
    const explorerSpec = {
      schemaVersion: 3 as const,
      sessionId: `explorer-retry-${campaignId}`,
      turnId: "recon-retry",
      attemptId: `explorer-retry-${campaignId}-${Date.now()}`,
      taskId: `explorer-retry-task-${campaignId}`,
      intentId: `explorer-retry-intent-${campaignId}`,
      mode: "build" as const,
      taskKind: "assistant_job" as const,
      prompt: explorerCommand.stdin ?? "",
      instructions: [],
      cwd: process.cwd(),
      execution: { engine: "agent_cli" as const },
      permissions: { rules: [], allowAllTools: false, noAskUser: true },
      budget: { timeoutSeconds: 120, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
      acceptanceChecks: [],
      artifactRequests: [],
    };
    const explorerPlan: DispatchPlan = {
      schemaVersion: 1,
      candidateId: explorerSpec.attemptId,
      profile: {
        providerId: "explorer",
        resolvedCommand: providerRegistry.get("explorer").command,
        sandboxLifecycle: "ephemeral" as const,
        candidatePolicy: "discard" as const,
      },
      spec: explorerSpec,
    };

    try {
      const record = await this.runner.runAttempt(
        explorerSpec,
        { timeoutSeconds: 120 },
        {},
        explorerPlan.profile,
      );
      const explorerOutput = record.result.stdout + record.result.stderr;
      if (isValidIntelligenceReport(explorerOutput)) {
        this.objective.explorerReport = explorerOutput;
      }
    } catch (error) {
      console.warn(
        `[ObjectiveController] Explorer retry failed for campaign ${campaignId}:`,
        error,
      );
    }
  }

  /**
   * Use the Architect agent to decompose the Objective goal into Campaigns.
   * Populates `this.objective.campaigns` with the parsed result.
   *
   * Wave 5: The Architect's prompt now references the Explorer's Intelligence
   * Report (if available) so it can ground its plan in real codebase context.
   *
   * On parse failure, logs a warning and leaves `campaigns` empty so the
   * caller can mark the Objective as failed.
   */
  private async decomposeObjective(): Promise<void> {
    // Wave 5: Pass Explorer report to Architect prompt.
    const architectPrompt = buildArchitectPrompt(
      this.objective.goal,
      this.objective.explorerReport,
    );

    // Build a minimal AttemptSpec for the Architect agent.
    const architectSpec = {
      schemaVersion: 3 as const,
      sessionId: `daemon-${this.objective.objectiveId}`,
      turnId: "decompose",
      attemptId: `architect-${this.objective.objectiveId}`,
      taskId: `architect-task-${this.objective.objectiveId}`,
      intentId: `architect-intent-${this.objective.objectiveId}`,
      mode: "build" as const,
      taskKind: "assistant_job" as const,
      prompt: architectPrompt,
      instructions: [],
      cwd: process.cwd(),
      execution: { engine: "agent_cli" as const },
      permissions: { rules: [], allowAllTools: false, noAskUser: true },
      budget: { timeoutSeconds: 120, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
      acceptanceChecks: [],
      artifactRequests: [],
    };

    const architectPlan: DispatchPlan = {
      schemaVersion: 1,
      candidateId: architectSpec.attemptId,
      profile: {
        providerId: "architect",
        resolvedCommand: providerRegistry.get("architect").command,
        sandboxLifecycle: "ephemeral",
        candidatePolicy: "discard",
      },
      spec: architectSpec,
    };

    let architectOutput: string;
    try {
      const record = await this.runner.runAttempt(
        architectSpec,
        { timeoutSeconds: 120 },
        {},
        architectPlan.profile,
      );
      architectOutput = record.result.stdout + record.result.stderr;
    } catch (error) {
      console.warn(
        `[ObjectiveController] Architect failed for objective ${this.objective.objectiveId}:`,
        error,
      );
      return;
    }

    // Parse the JSON array from the Architect output.
    let campaignDefs: Array<{ campaignId: string; description: string }>;
    try {
      // Extract the JSON array from the output (the Architect may emit
      // surrounding text despite the prompt instructions).
      const jsonMatch = architectOutput.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error("No JSON array found in Architect output");
      }
      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      campaignDefs = parsed.map((item) => {
        const obj = item as Record<string, unknown>;
        return {
          campaignId: String(obj["campaignId"] ?? ""),
          description: String(obj["description"] ?? ""),
        };
      });
    } catch (error) {
      console.warn(
        `[ObjectiveController] Failed to parse Architect output for objective ${this.objective.objectiveId}:`,
        error,
        "\nRaw output:",
        architectOutput,
      );
      return;
    }

    // Populate the campaigns list. Each campaign starts with an empty
    // candidateSet; the Daemon Gateway is responsible for populating
    // candidates before calling advance() again.
    this.objective.campaigns = campaignDefs
      .filter((def) => def.campaignId.length > 0)
      .map((def) =>
        createCampaign(def.campaignId, def.description, {
          batchId: `batch-${def.campaignId}`,
          intentId: `intent-${def.campaignId}`,
          candidates: [],
          objectiveId: this.objective.objectiveId,
          campaignId: def.campaignId,
        }),
      );
  }

  /** Read-only access to the current Objective state. */
  get state(): Readonly<Objective> {
    return this.objective;
  }

  /** True if the Objective is still active (not completed, failed, or paused). */
  isActive(): boolean {
    return this.objective.status === "active";
  }
}
