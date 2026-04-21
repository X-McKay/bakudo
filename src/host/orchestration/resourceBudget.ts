/**
 * Wave 3: Resource Budget
 *
 * Defines the concurrency and resource limits for the Daemon Gateway.
 * These limits are enforced by the ObjectiveController when dispatching
 * parallel CandidateSets.
 *
 * Security note: memory and CPU limits are advisory at this layer; abox
 * enforces hard limits at the microVM level. These values are used to
 * throttle the number of concurrent sandboxes the Daemon spawns.
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
}

/**
 * Default resource budget for the Daemon Gateway.
 * Conservative defaults suitable for a single-machine deployment.
 */
export const defaultBudget: ResourceBudget = {
  maxConcurrentSandboxes: 5,
  maxCandidatesPerCampaign: 3,
  perRoleLimits: {
    worker: { memoryMb: 2048, cpuCores: 2 },
    "chaos-monkey": { memoryMb: 1024, cpuCores: 1 },
    architect: { memoryMb: 1024, cpuCores: 1 },
    curator: { memoryMb: 512, cpuCores: 1 },
    janitor: { memoryMb: 512, cpuCores: 1 },
  },
};
