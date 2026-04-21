/**
 * Wave 3: Objective State Model
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
 * All schemas use Zod for runtime validation so state can be safely
 * serialised to disk and restored across Daemon restarts.
 */
import { z } from "zod";

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
