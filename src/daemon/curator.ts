/**
 * Wave 4: Curator — Memory Consolidation Agent
 *
 * The Curator is a background agent that consolidates Critic Post-Mortems
 * into the Semantic Memory Knowledge Graph at `.bakudo/memory/semantic/`.
 *
 * Memory structure managed by the Curator:
 * ```
 * .bakudo/
 *   memory/
 *     episodic/     # Raw transcripts (gitignored — ephemeral)
 *     semantic/     # Markdown rules (e.g., package-manager.md)
 *     procedural/   # Markdown playbooks (e.g., add-route.md)
 * ```
 *
 * Git Mutex: The Curator MUST acquire the `gitWriteMutex` from the Daemon
 * Gateway before making any git operations. This prevents collisions with
 * the Janitor agent (Wave 4) and other background writers.
 *
 * Critical Rules (from `00-execution-overview.md`):
 * - The Curator may create or edit files in `.bakudo/memory/`.
 * - The Curator may run `git add` and `git commit` for those files ONLY.
 * - The Curator MUST NEVER push, merge PRs, or modify code outside `.bakudo/memory/`.
 * - The Curator MUST NEVER push to protected branches.
 */
import path from "node:path";
import { providerRegistry } from "../host/providerRegistry.js";
import { headlessExecute } from "../host/orchestration/headlessExecute.js";
import { gitWriteMutex } from "./gateway.js";
import type { ABoxTaskRunner } from "../aboxTaskRunner.js";
import type { DispatchPlan } from "../attemptProtocol.js";

// ---------------------------------------------------------------------------
// Curator prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt injected as stdin for the Curator agent.
 *
 * The Curator receives a Post-Mortem from the Critic and decides whether to
 * create a new rule or update an existing one in `.bakudo/memory/semantic/`.
 */
export const CURATOR_PROMPT = `
You are the Curator. You manage the Semantic Memory of this codebase.
Read the Post-Mortem below. Decide if it warrants a new rule in the Knowledge Graph, or an update to an existing rule.
Write the updated Markdown file to .bakudo/memory/semantic/.

CRITICAL RULES:
- You may create or edit files in .bakudo/memory/
- You may run \`git add\` and \`git commit\` for those files ONLY.
- You MUST NEVER push, merge PRs, or modify code outside of .bakudo/memory/.
- You MUST NEVER push to protected branches.
- Use kebab-case filenames (e.g., package-manager.md, auth-patterns.md).
- Each file should contain a single generalized rule with examples.

Format for semantic memory files:
# Rule: <short title>
## Context
<when does this rule apply>
## Rule
<the actionable rule>
## Evidence
<what triggered this rule>
`.trim();

// ---------------------------------------------------------------------------
// Memory directory helpers
// ---------------------------------------------------------------------------

/**
 * The relative path to the Curator's memory directory within the target repo.
 */
export const MEMORY_ROOT = ".bakudo/memory";
export const EPISODIC_DIR = `${MEMORY_ROOT}/episodic`;
export const SEMANTIC_DIR = `${MEMORY_ROOT}/semantic`;
export const PROCEDURAL_DIR = `${MEMORY_ROOT}/procedural`;

/**
 * Build the `.gitignore` entry for the episodic memory directory.
 * Episodic transcripts are ephemeral and should not be committed.
 */
export const EPISODIC_GITIGNORE_ENTRY = `${EPISODIC_DIR}/`;

// ---------------------------------------------------------------------------
// Curator trigger
// ---------------------------------------------------------------------------

/**
 * Trigger the Curator to consolidate a Post-Mortem into Semantic Memory.
 *
 * This function:
 * 1. Acquires the Daemon-level git write mutex.
 * 2. Dispatches a Curator agent via `headlessExecute` with the Post-Mortem
 *    injected into the prompt.
 * 3. Releases the mutex after the Curator completes.
 *
 * The Curator runs in an `ephemeral` sandbox (it only writes to `.bakudo/`
 * and commits those changes — it does not need a preserved sandbox).
 *
 * @param postMortem  The Post-Mortem text from the Critic agent.
 * @param repoRoot    The absolute path to the target repository root.
 * @param runner      The ABoxTaskRunner to use for dispatch.
 */
export const triggerCurator = async (
  postMortem: string,
  repoRoot: string,
  runner: ABoxTaskRunner,
): Promise<void> => {
  const curatorPrompt = [CURATOR_PROMPT, "", "POST-MORTEM:", postMortem].join("\n");

  const curatorSpec = {
    schemaVersion: 3 as const,
    sessionId: `curator-${Date.now()}`,
    turnId: "consolidate",
    attemptId: `curator-attempt-${Date.now()}`,
    taskId: `curator-task-${Date.now()}`,
    intentId: `curator-intent-${Date.now()}`,
    mode: "build" as const,
    taskKind: "assistant_job" as const,
    prompt: curatorPrompt,
    instructions: [
      `Memory root: ${path.join(repoRoot, MEMORY_ROOT)}`,
      `Semantic memory dir: ${path.join(repoRoot, SEMANTIC_DIR)}`,
      "Only commit files under .bakudo/memory/. Never push or merge PRs.",
    ],
    cwd: repoRoot,
    execution: { engine: "agent_cli" as const },
    permissions: { rules: [], allowAllTools: false, noAskUser: true },
    budget: { timeoutSeconds: 180, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
    acceptanceChecks: [],
    artifactRequests: [],
  };

  const curatorPlan: DispatchPlan = {
    schemaVersion: 1,
    candidateId: curatorSpec.attemptId,
    profile: {
      providerId: "curator",
      sandboxLifecycle: "ephemeral",
      candidatePolicy: "discard",
    },
    spec: curatorSpec,
  };

  // Acquire the git write mutex before dispatching the Curator.
  // This prevents the Curator and Janitor from racing on git operations.
  const release = await gitWriteMutex.acquire();
  try {
    await headlessExecute(curatorPlan, runner, { maxAttempts: 1 });
  } finally {
    release();
  }
};

// ---------------------------------------------------------------------------
// Episodic transcript helpers
// ---------------------------------------------------------------------------

/**
 * Build the path for storing an episodic transcript.
 * Episodic transcripts are gitignored and ephemeral.
 */
export const episodicTranscriptPath = (candidateId: string, repoRoot: string): string =>
  path.join(repoRoot, EPISODIC_DIR, `${candidateId}.txt`);
