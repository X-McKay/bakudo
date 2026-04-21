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
});

/**
 * Codex CLI — legacy default used by the pre-Wave-1 hardcoded path.
 * Kept as a registered provider so existing serialised profiles that
 * reference `agentBackend: "codex exec ..."` can be resolved via the
 * `codex` provider ID after migration.
 */
providerRegistry.register({
  id: "codex",
  name: "Codex CLI",
  command: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
  requiredPolicies: ["openai-api"],
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
});

/**
 * Wave 2: Chaos Monkey — adversarial evaluator that runs in the same
 * preserved sandbox as the Worker to find edge cases and write failing
 * tests. Uses the Claude Code CLI as its backbone but is invoked with
 * a strictly adversarial system prompt (see `chaosMonkeyRunner.ts`).
 * Requires the `anthropic-api` abox proxy policy.
 */
providerRegistry.register({
  id: "chaos-monkey",
  name: "Adversarial Evaluator",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"],
});
