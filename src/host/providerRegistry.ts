/**
 * Wave 1: Provider Registry
 *
 * Decouples bakudo from hardcoded CLI runner strings. Each `ProviderSpec`
 * declares the command to run and the abox security policies it requires.
 * The `providerRegistry` singleton is the single source of truth for
 * resolving a `providerId` → concrete command.
 *
 * Security note: providers declare *which* policies they need; abox handles
 * the actual TLS-proxy stub injection. Never inject raw credentials via env.
 */
import { z } from "zod";

export const ProviderSpecSchema = z.object({
  /** Unique identifier used in `ExecutionProfile.providerId`. */
  id: z.string(),
  /** Human-readable display name. */
  name: z.string(),
  /**
   * The command array to spawn inside the sandbox. The first element is the
   * executable; subsequent elements are arguments. The bounded prompt is
   * piped via stdin, not appended as an argument.
   */
  command: z.array(z.string()),
  /**
   * abox policy names that must be present in the user's abox config for
   * this provider to function. e.g. `["anthropic-api", "github-api"]`.
   * bakudo performs a pre-flight check before dispatch.
   */
  requiredPolicies: z.array(z.string()),
  /**
   * abox v0.3.0: Default memory allocation in MiB for this provider's sandbox
   * VM. Passed as `--memory` to `abox run`. Omit to use the abox config default.
   */
  memoryMiB: z.number().int().positive().optional(),
  /**
   * abox v0.3.0: Default number of vCPUs for this provider's sandbox VM.
   * Passed as `--cpus` to `abox run`. Omit to use the abox config default.
   */
  cpus: z.number().int().positive().optional(),
});

export type ProviderSpec = z.infer<typeof ProviderSpecSchema>;

class Registry {
  private readonly providers = new Map<string, ProviderSpec>();

  /**
   * Register a provider spec. Overwrites any existing registration with the
   * same `id` — callers are responsible for avoiding conflicts.
   */
  register(spec: ProviderSpec): void {
    ProviderSpecSchema.parse(spec); // validate on registration
    this.providers.set(spec.id, spec);
  }

  /**
   * Look up a provider by ID. Throws a descriptive error if not found so
   * the caller surfaces a clear message rather than a generic undefined-read.
   */
  get(id: string): ProviderSpec {
    const spec = this.providers.get(id);
    if (!spec) {
      const known = [...this.providers.keys()].join(", ") || "(none registered)";
      throw new Error(
        `Provider not found: "${id}". Known providers: ${known}`,
      );
    }
    return spec;
  }

  /**
   * Return `true` if a provider with the given ID is registered.
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Return all registered providers as an array (useful for diagnostics /
   * doctor command).
   */
  list(): ProviderSpec[] {
    return [...this.providers.values()];
  }
}

/**
 * The global provider registry singleton. Import and call `.register()` at
 * module initialisation time to add providers; import and call `.get()` at
 * dispatch time to resolve a provider ID to its command.
 */
export const providerRegistry = new Registry();

// ---------------------------------------------------------------------------
// Default provider registrations
// ---------------------------------------------------------------------------

/**
 * Claude Code CLI — the default interactive agent backend.
 * Requires the `anthropic-api` abox proxy policy.
 */
providerRegistry.register({
  id: "claude-code",
  name: "Claude Code CLI",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"],
  memoryMiB: 2048,
  cpus: 2,
});

/**
 * Codex CLI — legacy default used by the pre-Wave-1 hardcoded path.
 * Kept as a registered provider for compatibility with profiles that
 * reference the `codex` provider ID.
 */
providerRegistry.register({
  id: "codex",
  name: "Codex CLI",
  command: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
  requiredPolicies: ["openai-api"],
  memoryMiB: 2048,
  cpus: 2,
});

/**
 * OpenDevin — open-source alternative agent backend.
 * Requires both the `openai-api` and `github-api` abox proxy policies.
 */
providerRegistry.register({
  id: "opendevin",
  name: "OpenDevin",
  command: ["opendevin", "--headless"],
  requiredPolicies: ["openai-api", "github-api"],
  memoryMiB: 2048,
  cpus: 2,
});

/**
 * Wave 2: Chaos Monkey — adversarial evaluator that runs in the same
 * preserved sandbox as the Worker agent to find edge cases and write failing
 * tests. Uses the Claude Code CLI as its backbone but is invoked with
 * a strictly adversarial system prompt (see `chaosMonkeyRunner.ts`).
 * Requires the `anthropic-api` abox proxy policy.
 */
providerRegistry.register({
  id: "chaos-monkey",
  name: "Adversarial Evaluator",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"],
  memoryMiB: 1024,
  cpus: 1,
});

/**
 * Wave 3: Architect — Decomposition Agent that breaks high-level Objectives
 * into Campaigns. Uses the Claude Code CLI as its backbone with a structured
 * decomposition prompt (see `objectiveController.ts`).
 * Only needs LLM access — no network egress beyond the anthropic-api proxy.
 */
providerRegistry.register({
  id: "architect",
  name: "Decomposition Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"],
  memoryMiB: 1024,
  cpus: 1,
});

/**
 * Wave 4: Critic — Reflection Agent that analyses why a Worker failed and
 * produces a structured Post-Mortem starting with "LESSON LEARNED: ".
 * Read-only: MUST NOT modify files or run git commands.
 * Requires the `anthropic-api` abox proxy policy.
 */
providerRegistry.register({
  id: "critic",
  name: "Reflection Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"],
  memoryMiB: 1024,
  cpus: 1,
});

/**
 * Wave 4: Curator — Memory Consolidation Agent that consolidates Critic
 * Post-Mortems into `.bakudo/memory/semantic/` Markdown rules.
 * Requires both `anthropic-api` (LLM) and `git-write` (to commit memory
 * files) abox proxy policies.
 * MUST NEVER push, merge PRs, or modify code outside `.bakudo/memory/`.
 */
providerRegistry.register({
  id: "curator",
  name: "Memory Consolidation Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api", "git-write"],
  memoryMiB: 1024,
  cpus: 1,
});

/**
 * Wave 5: Explorer — Reconnaissance Agent that performs proactive codebase
 * discovery before the Architect decomposes an Objective. Read-only access
 * to the repo plus broad egress for documentation and API references.
 * Requires `anthropic-api`, `read-only-repo`, and `web-read` policies.
 */
providerRegistry.register({
  id: "explorer",
  name: "Reconnaissance Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api", "read-only-repo", "web-read"],
  memoryMiB: 1536,
  cpus: 2,
});

/**
 * Wave 5: Synthesizer — Parallel Merge Agent that reads multiple winning
 * Candidate diffs and produces a single unified result. Requires read access
 * to multiple worktrees and write access to commit the merged result.
 * Requires `anthropic-api`, `multi-worktree-read`, and `git-write` policies.
 * MUST NEVER push or merge PRs.
 */
providerRegistry.register({
  id: "synthesizer",
  name: "Parallel Merge Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api", "multi-worktree-read", "git-write"],
  memoryMiB: 2048,
  cpus: 2,
});

/**
 * Wave 5: Janitor (LLM hygiene) — Codebase Hygiene Agent that runs during
 * Daemon idle time to find low-risk cleanups and open atomic PRs.
 * Requires `anthropic-api` and `git-write` policies.
 * MUST NEVER push to protected branches, merge PRs, or open more than one
 * PR per invocation.
 */
providerRegistry.register({
  id: "janitor",
  name: "Codebase Hygiene Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api", "git-write"],
  memoryMiB: 512,
  cpus: 1,
});
