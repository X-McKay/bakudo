/**
 * Wave 4 + 5: Janitor — Episodic Memory Cleanup + Codebase Hygiene Agent
 *
 * Wave 4: The Janitor is a background agent that rotates old episodic
 * transcripts out of `.bakudo/memory/episodic/` to prevent disk bloat.
 * It is intentionally simple: it does NOT use an LLM.
 *
 * Wave 5: The Janitor gains an LLM-based codebase hygiene mode
 * (`maybeRunJanitor`). During Daemon idle time, it scans the codebase for
 * low-risk cleanups (dead imports, lint violations, stale Semantic Memory
 * rules) and opens a single atomic PR. It MUST NEVER run while there are
 * active Objectives (resource-budget gate).
 *
 * Git Mutex: The Janitor MUST acquire the `gitWriteMutex` before making
 * any git operations. This prevents collisions with the Curator agent.
 *
 * Critical Rules (from `00-execution-overview.md`):
 * - The Janitor may delete files in `.bakudo/memory/episodic/` ONLY (Wave 4).
 * - The LLM Janitor may stage and open ONE PR per invocation (Wave 5).
 * - The Janitor MUST NEVER push, merge PRs, or modify code outside `.bakudo/`.
 * - The Janitor MUST NEVER delete semantic or procedural memory files.
 * - The Janitor MUST NEVER preempt Worker capacity.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitWriteMutex } from "./gateway.js";
import { EPISODIC_DIR } from "./curator.js";
import { defaultBudget } from "../host/orchestration/resourceBudget.js";
import { providerRegistry } from "../host/providerRegistry.js";
import { headlessExecute } from "../host/orchestration/headlessExecute.js";
import type { ABoxTaskRunner } from "../aboxTaskRunner.js";
import type { DispatchPlan } from "../attemptProtocol.js";

// ---------------------------------------------------------------------------
// Wave 4: Episodic memory cleanup
// ---------------------------------------------------------------------------

export interface JanitorConfig {
  /**
   * Number of days to retain episodic transcripts before deletion.
   * Default: 7 days.
   */
  retentionDays: number;
  /**
   * Maximum number of transcripts to retain regardless of age.
   * Oldest transcripts are deleted first when this limit is exceeded.
   * Default: 100.
   */
  maxTranscripts: number;
}

export const DEFAULT_JANITOR_CONFIG: JanitorConfig = {
  retentionDays: 7,
  maxTranscripts: 100,
};

export interface JanitorResult {
  /** Number of transcripts deleted. */
  deleted: number;
  /** Number of transcripts retained. */
  retained: number;
  /** Paths of deleted transcripts (relative to repoRoot). */
  deletedPaths: string[];
  /** Any errors encountered during cleanup (non-fatal). */
  errors: string[];
}

/**
 * Run the Janitor cleanup pass on the episodic memory directory.
 *
 * This function:
 * 1. Acquires the git write mutex.
 * 2. Reads the episodic directory and identifies stale transcripts.
 * 3. Deletes stale transcripts (oldest first if maxTranscripts is exceeded).
 * 4. Releases the mutex.
 *
 * The Janitor does NOT run git commands — it only deletes files from the
 * filesystem. The episodic directory is gitignored, so no git operations
 * are needed for cleanup.
 *
 * @param repoRoot  The absolute path to the target repository root.
 * @param config    Optional Janitor configuration overrides.
 */
export const runJanitor = async (
  repoRoot: string,
  config: Partial<JanitorConfig> = {},
): Promise<JanitorResult> => {
  const { retentionDays, maxTranscripts } = { ...DEFAULT_JANITOR_CONFIG, ...config };
  const episodicPath = path.join(repoRoot, EPISODIC_DIR);
  const result: JanitorResult = {
    deleted: 0,
    retained: 0,
    deletedPaths: [],
    errors: [],
  };

  if (!existsSync(episodicPath)) {
    // Nothing to clean up — episodic directory doesn't exist yet.
    return result;
  }

  // Acquire the git write mutex to prevent concurrent writes from the Curator.
  const release = await gitWriteMutex.acquire();
  try {
    let entries: string[];
    try {
      entries = await readdir(episodicPath);
    } catch (error) {
      result.errors.push(`Failed to read episodic directory: ${String(error)}`);
      return result;
    }

    // Gather file stats for all entries.
    const fileStats = await Promise.allSettled(
      entries.map(async (entry) => {
        const filePath = path.join(episodicPath, entry);
        const stats = await stat(filePath);
        return { entry, filePath, mtime: stats.mtime };
      }),
    );

    // Filter to successfully-stat'd files, sorted oldest-first.
    const files = fileStats
      .filter(
        (r): r is PromiseFulfilledResult<{ entry: string; filePath: string; mtime: Date }> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value)
      .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const toDelete: typeof files = [];

    // Mark files for deletion: too old OR exceeds maxTranscripts.
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const isStale = now - file.mtime.getTime() > retentionMs;
      const exceedsLimit = files.length - i > maxTranscripts;
      if (isStale || exceedsLimit) {
        toDelete.push(file);
      }
    }

    // Delete marked files.
    for (const file of toDelete) {
      try {
        await unlink(file.filePath);
        result.deleted++;
        result.deletedPaths.push(path.relative(repoRoot, file.filePath));
      } catch (error) {
        result.errors.push(`Failed to delete ${file.entry}: ${String(error)}`);
      }
    }

    result.retained = files.length - result.deleted;
  } finally {
    release();
  }

  return result;
};

// ---------------------------------------------------------------------------
// Wave 5: LLM-based codebase hygiene
// ---------------------------------------------------------------------------

/**
 * The system prompt for the LLM Janitor (codebase hygiene mode).
 *
 * The Janitor scans for low-risk cleanups and opens ONE atomic PR.
 * It MUST output "NO_WORK" if nothing is worth doing.
 */
export const JANITOR_HYGIENE_PROMPT = `
You are the Janitor. The Daemon is idle. Scan the codebase for LOW-RISK cleanups only.

Allowed actions:
- Remove unused imports or dead exports.
- Align code with existing Semantic Memory rules in .bakudo/memory/semantic/.
- Fix obvious lint violations.
- Bump patch-level dependency versions that have no breaking changes.

FORBIDDEN:
- Refactoring logic.
- Changing public APIs.
- Touching anything in a file modified in the last 24 hours.
- Opening more than one PR per invocation.
- Pushing to protected branches.
- Merging PRs.

Output a single atomic diff. If nothing is worth doing, output exactly: "NO_WORK".
`.trim();

/**
 * Wave 5: Scheduler interface for the LLM Janitor.
 * Used to gate the Janitor on Daemon idle state.
 */
export interface JanitorScheduler {
  /** Returns the number of currently active Objectives. */
  activeObjectives: () => number;
  /** Returns the number of currently active sandboxes. */
  activeSandboxes: () => number;
  /** Timestamp of the last Janitor run (for rate-limiting). */
  lastRunAt?: Date;
}

/**
 * Wave 5: Run the LLM-based Janitor hygiene pass if the Daemon is idle.
 *
 * Resource-budget gate:
 * - Never runs if there are active Objectives.
 * - Never runs if the sandbox count is within 1 of the maximum.
 * - Rate-limited to once per hour.
 * - Skips if the git write mutex is already held (Curator is writing).
 *
 * The Janitor acquires the git write mutex, dispatches the LLM agent via
 * `headlessExecute`, and releases the mutex.
 *
 * @param sched   Scheduler state for the idle gate.
 * @param runner  The ABoxTaskRunner to use for dispatch.
 * @param repoRoot The absolute path to the target repository root.
 */
export const maybeRunJanitor = async (
  sched: JanitorScheduler,
  runner: ABoxTaskRunner,
  repoRoot: string,
): Promise<void> => {
  // Resource-budget gate: never preempt real work.
  if (!defaultBudget.janitorRunsOnlyWhenIdle) return;
  if (sched.activeObjectives() > 0) return;
  if (sched.activeSandboxes() >= defaultBudget.maxConcurrentSandboxes - 1) return;

  // Rate-limit: at most one Janitor run per hour.
  if (
    sched.lastRunAt &&
    Date.now() - sched.lastRunAt.getTime() < 60 * 60 * 1000
  ) {
    return;
  }

  // Skip if the git write mutex is already held (Curator is writing).
  if (gitWriteMutex.isLocked()) return;

  const provider = providerRegistry.get("janitor");
  const janitorSpec = {
    schemaVersion: 3 as const,
    sessionId: `janitor-${Date.now()}`,
    turnId: "hygiene",
    attemptId: `janitor-attempt-${Date.now()}`,
    taskId: `janitor-task-${Date.now()}`,
    intentId: `janitor-intent-${Date.now()}`,
    mode: "build" as const,
    taskKind: "assistant_job" as const,
    prompt: JANITOR_HYGIENE_PROMPT,
    instructions: [
      "You may open at most ONE PR per invocation.",
      "NEVER push to protected branches.",
      "NEVER merge PRs.",
      `Repository root: ${repoRoot}`,
    ],
    cwd: repoRoot,
    execution: { engine: "agent_cli" as const },
    permissions: { rules: [], allowAllTools: false, noAskUser: true },
    budget: { timeoutSeconds: 300, maxOutputBytes: 524288, heartbeatIntervalMs: 5000 },
    acceptanceChecks: [],
    artifactRequests: [],
  };

  const janitorPlan: DispatchPlan = {
    schemaVersion: 1,
    candidateId: janitorSpec.attemptId,
    profile: {
      providerId: "janitor",
      sandboxLifecycle: "ephemeral" as const,
      candidatePolicy: "discard" as const,
    },
    spec: janitorSpec,
  };

  // Acquire the git write mutex to prevent collisions with the Curator.
  const release = await gitWriteMutex.acquire();
  try {
    await headlessExecute(janitorPlan, runner, { maxAttempts: 1 });
  } finally {
    release();
  }
};
