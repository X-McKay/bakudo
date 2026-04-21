/**
 * Wave 3: Objective Controller
 *
 * The state machine that advances an Objective by:
 * 1. Using the Architect agent to decompose the Objective into Campaigns.
 * 2. Dispatching the Candidates of each Campaign in parallel via
 *    `headlessExecute` (the Wave 2 Worker → Chaos Monkey loop).
 * 3. Selecting the winning Candidate (first successful result).
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
import { headlessExecute, type HeadlessExecuteResult } from "./headlessExecute.js";
import { type Campaign, type Objective, createCampaign } from "./objectiveState.js";
import { defaultBudget } from "./resourceBudget.js";

// ---------------------------------------------------------------------------
// Architect decomposition prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt injected into the Architect agent to decompose an
 * Objective into a JSON array of Campaign descriptions.
 *
 * The Architect MUST output a JSON array of objects with `campaignId` and
 * `description` fields. Any other output format is treated as a parse error
 * and the Objective is marked as failed.
 */
const buildArchitectPrompt = (goal: string): string =>
  `
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
   * - If no campaigns exist, decompose the Objective using the Architect.
   * - Otherwise, find the next pending Campaign and execute its Candidates.
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

    // Select the winner: the first successfully completed candidate.
    const winnerIndex = results.findIndex(
      (r) => r.status === "fulfilled" && r.value.success,
    );

    if (winnerIndex >= 0) {
      activeCampaign.status = "completed";
      activeCampaign.winnerCandidateId = candidates[winnerIndex]?.candidateId;
    } else {
      activeCampaign.status = "failed";
    }
  }

  /**
   * Use the Architect agent to decompose the Objective goal into Campaigns.
   * Populates `this.objective.campaigns` with the parsed result.
   *
   * On parse failure, logs a warning and leaves `campaigns` empty so the
   * caller can mark the Objective as failed.
   */
  private async decomposeObjective(): Promise<void> {
    const architectPrompt = buildArchitectPrompt(this.objective.goal);

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
}
