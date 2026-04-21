/**
 * Wave 4: Janitor — Episodic Memory Cleanup Agent
 *
 * The Janitor is a background agent that rotates old episodic transcripts
 * out of `.bakudo/memory/episodic/` to prevent disk bloat. It runs on a
 * schedule (or triggered by the Daemon Gateway) and removes transcripts
 * older than the configured retention period.
 *
 * The Janitor is intentionally simple: it does NOT use an LLM. It is a
 * pure filesystem cleanup agent that reads the episodic directory and
 * deletes files older than `retentionDays`.
 *
 * Git Mutex: The Janitor MUST acquire the `gitWriteMutex` before making
 * any git operations (git rm, git commit). This prevents collisions with
 * the Curator agent.
 *
 * Critical Rules (from `00-execution-overview.md`):
 * - The Janitor may delete files in `.bakudo/memory/episodic/` ONLY.
 * - The Janitor may run `git rm` and `git commit` for those files ONLY.
 * - The Janitor MUST NEVER push, merge PRs, or modify code outside `.bakudo/`.
 * - The Janitor MUST NEVER delete semantic or procedural memory files.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitWriteMutex } from "./gateway.js";
import { EPISODIC_DIR } from "./curator.js";

// ---------------------------------------------------------------------------
// Janitor configuration
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

// ---------------------------------------------------------------------------
// Janitor result
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Janitor implementation
// ---------------------------------------------------------------------------

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
