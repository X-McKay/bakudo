/**
 * Wave 3 + 5: Resource Budget
 *
 * Defines the concurrency and resource limits for the Daemon Gateway.
 * These limits are enforced by the ObjectiveController when dispatching
 * parallel CandidateSets.
 *
 * Security note: memory and CPU limits are advisory at this layer; abox
 * enforces hard limits at the microVM level. These values are used to
 * throttle the number of concurrent sandboxes the Daemon spawns.
 *
 * Wave 5 additions:
 * - Explorer, Synthesizer, and Janitor (LLM hygiene) per-role limits.
 * - `janitorMaxConcurrent`: cap on simultaneous Janitor runs (always 1).
 * - `janitorRunsOnlyWhenIdle`: Janitor must never preempt Worker capacity.
 */

export interface PerRoleLimit {
  /** Maximum memory in megabytes for this role's sandbox. */
  memoryMb: number;
  /** Maximum CPU cores allocated to this role's sandbox. */
  cpuCores: number;
}

export interface ResourceBudget {
  /** Maximum number of abox sandboxes that may be active simultaneously. */
  maxConcurrentSandboxes: number;
  /** Maximum number of candidates dispatched per Campaign. */
  maxCandidatesPerCampaign: number;
  /** Per-role resource limits keyed by provider ID. */
  perRoleLimits: Record<string, PerRoleLimit>;
  /**
   * Wave 5: Maximum number of Janitor (LLM hygiene) runs that may be active
   * simultaneously. Always 1 — the Janitor is a single-instance agent.
   */
  janitorMaxConcurrent: number;
  /**
   * Wave 5: When true, the Janitor (LLM hygiene) only runs when there are
   * no active Objectives. This prevents the Janitor from preempting Workers.
   */
  janitorRunsOnlyWhenIdle: boolean;
}

/**
 * Default resource budget for the Daemon Gateway.
 * Conservative defaults suitable for a single-machine deployment.
 */
export const defaultBudget: ResourceBudget = {
  maxConcurrentSandboxes: 5,
  maxCandidatesPerCampaign: 3,
  perRoleLimits: {
    // Wave 1–3 roles
    worker: { memoryMb: 2048, cpuCores: 2 },
    "chaos-monkey": { memoryMb: 1024, cpuCores: 1 },
    architect: { memoryMb: 1024, cpuCores: 1 },
    // Wave 4 roles
    critic: { memoryMb: 1024, cpuCores: 1 },
    curator: { memoryMb: 1024, cpuCores: 1 },
    // Wave 5 roles
    explorer: { memoryMb: 1536, cpuCores: 1 },
    synthesizer: { memoryMb: 2048, cpuCores: 2 },
    janitor: { memoryMb: 1024, cpuCores: 1 },
  },
  // Wave 5: Janitor scheduling constraints
  janitorMaxConcurrent: 1,
  janitorRunsOnlyWhenIdle: true,
};
