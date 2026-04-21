/**
 * Wave 3 + 5: Objective State Model
 *
 * Defines the durable state hierarchy for the Daemon Gateway:
 *
 *   Objective → Campaign[] → CandidateSet (→ DispatchPlan[])
 *
 * An Objective is a high-level goal (e.g. "Refactor auth middleware to JWT").
 * The Architect agent decomposes it into Campaigns (e.g. "Write JWT utility",
 * "Update middleware", "Add integration tests"). Each Campaign holds a
 * CandidateSet — multiple parallel DispatchPlans competing to complete the
 * Campaign goal. The ObjectiveController selects the winner.
 *
 * Wave 5 additions:
 * - `Objective.explorerReport`: the Explorer's Intelligence Report, produced
 *   before the Architect decomposes the Objective.
 * - `Campaign.synthesisRecord`: the Synthesizer's merge record, produced when
 *   multiple Candidates succeed in parallel.
 * - `Campaign.needsManualReview`: flag set when the Synthesizer outputs
 *   "MANUAL_REVIEW_REQUIRED".
 *
 * All schemas use Zod for runtime validation so state can be safely
 * serialised to disk and restored across Daemon restarts.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// SynthesisRecord (Wave 5)
// ---------------------------------------------------------------------------

export const SynthesisRecordSchema = z.object({
  /** IDs of the Candidates that were merged. */
  mergedFrom: z.array(z.string()),
  /** The Synthesizer's rationale for the merge. */
  rationale: z.string(),
  /** The ID of the winning Candidate if the Synthesizer chose a single winner. */
  useCandidateId: z.string().optional(),
  /** True if the Synthesizer requested manual review. */
  manualReviewRequired: z.boolean().optional(),
});

export type SynthesisRecord = z.infer<typeof SynthesisRecordSchema>;

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export const CampaignSchema = z.object({
  /** Unique identifier for this campaign within its parent Objective. */
  campaignId: z.string(),
  /** Human-readable description of the campaign goal. */
  description: z.string(),
  /** Lifecycle status of the campaign. */
  status: z.enum(["pending", "running", "completed", "failed"]),
  /**
   * The set of parallel candidate plans to execute.
   * Uses `z.any()` to avoid a circular import with `attemptProtocol.ts`;
   * callers should cast to `CandidateSet` from that module.
   */
  candidateSet: z.any(),
  /**
   * The `candidateId` of the winning DispatchPlan after the campaign
   * completes. Undefined until a winner is selected.
   */
  winnerCandidateId: z.string().optional(),
  /**
   * Wave 5: The Synthesizer's merge record, produced when multiple Candidates
   * succeed in parallel. Undefined for single-winner campaigns.
   */
  synthesisRecord: SynthesisRecordSchema.optional(),
  /**
   * Wave 5: Set to true when the Synthesizer outputs "MANUAL_REVIEW_REQUIRED".
   * The campaign is marked completed but queued for human review.
   * The system MUST NOT auto-merge in this case.
   */
  needsManualReview: z.boolean().optional(),
});

export type Campaign = z.infer<typeof CampaignSchema>;

// ---------------------------------------------------------------------------
// Objective
// ---------------------------------------------------------------------------

export const ObjectiveSchema = z.object({
  /** Unique identifier for this objective. */
  objectiveId: z.string(),
  /** The high-level goal string provided by the user. */
  goal: z.string(),
  /** Lifecycle status of the objective. */
  status: z.enum(["active", "paused", "completed", "failed"]),
  /** Ordered list of campaigns derived from this objective. */
  campaigns: z.array(CampaignSchema),
  /** ISO timestamp of when this objective was created. */
  createdAt: z.string().optional(),
  /** ISO timestamp of when this objective last changed status. */
  updatedAt: z.string().optional(),
  /**
   * Wave 5: The Explorer's Intelligence Report, produced before the Architect
   * decomposes the Objective. Undefined until the Explorer has run.
   */
  explorerReport: z.string().optional(),
});

export type Objective = z.infer<typeof ObjectiveSchema>;

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a new Objective with sensible defaults.
 */
export const createObjective = (
  objectiveId: string,
  goal: string,
): Objective => ({
  objectiveId,
  goal,
  status: "active",
  campaigns: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/**
 * Create a new Campaign with `"pending"` status.
 */
export const createCampaign = (
  campaignId: string,
  description: string,
  candidateSet: unknown,
): Campaign => ({
  campaignId,
  description,
  status: "pending",
  candidateSet,
});
