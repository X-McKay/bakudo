# Wave 1: Provider Registry

**Goal:** Decouple `bakudo` from hardcoded CLI runners (like `assistantJobRunner.ts`) by introducing a `ProviderRegistry`. This allows users to register different backends (Claude Code, Codex, OpenDevin) dynamically, and maps those backends to the specific `abox` security policies they require.

**Non-Goals:** Do not implement the Chaos Monkey or the Daemon yet. The existing `sessionController` interactive loop will just use the new Registry to resolve the `agentBackend` string.

## Rationale
Currently, `assistantJobRunner.ts` blindly splits the `profile.agentBackend` string and runs it. If a user wants to use a new agent that requires specific API keys or egress domains, they have to manually configure `abox`. The Provider Registry formalizes this: a provider declares *how* it runs and *what policies* it needs, and `bakudo` ensures the sandbox is built securely using `abox`'s native proxy.

## Dependencies
- **Requires:** None.
- **Blocks:** Wave 2 (Chaos Monkey).

## Files to Modify

1. `src/host/providerRegistry.ts` (New File)
   - **Reason:** Define the `ProviderSpec` interface and the in-memory registry.
2. `src/attemptProtocol.ts`
   - **Reason:** Update `ExecutionProfile.agentBackend` to reference a registered provider ID instead of a raw command string.
3. `src/worker/assistantJobRunner.ts`
   - **Reason:** Refactor to look up the provider from the registry and build the command dynamically.
4. `src/host/executeAttempt.ts`
   - **Reason:** Add a pre-flight check to ensure the required `abox` policies for the chosen provider actually exist in the user's `abox` config.

## Step-by-Step Implementation

### 1. Define the Provider Spec
Create `src/host/providerRegistry.ts`:

```typescript
import { z } from "zod";

export const ProviderSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.array(z.string()),
  requiredPolicies: z.array(z.string()), // e.g., ["anthropic-api", "github-api"]
});

export type ProviderSpec = z.infer<typeof ProviderSpecSchema>;

class Registry {
  private providers = new Map<string, ProviderSpec>();

  register(spec: ProviderSpec) {
    this.providers.set(spec.id, spec);
  }

  get(id: string): ProviderSpec {
    const spec = this.providers.get(id);
    if (!spec) throw new Error(`Provider not found: ${id}`);
    return spec;
  }
}

export const providerRegistry = new Registry();

// Default registrations
providerRegistry.register({
  id: "claude-code",
  name: "Claude Code CLI",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"],
});
```

### 2. Update Protocol
In `src/attemptProtocol.ts`, update `ExecutionProfile` and its corresponding Zod schema. We also keep `agentBackend` as an optional alias during the deprecation period to avoid breaking existing CLI profiles.

```typescript
export const ExecutionProfileSchema = z.object({
  providerId: z.string(),
  agentBackend: z.string().optional(), // DEPRECATED: use providerId
  sandboxLifecycle: z.enum(["preserved", "ephemeral"]),
  candidatePolicy: z.enum(["auto_apply", "manual_apply", "discard"]),
});

export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
```

### 3. Refactor the Runner
In `src/worker/assistantJobRunner.ts`:

```typescript
import { providerRegistry } from "../host/providerRegistry.js";

export const runAssistantJob = (
  spec: AttemptSpec,
  profile: ExecutionProfile,
): TaskRunnerCommand => {
  const resolvedProviderId = profile.providerId || profile.agentBackend;
  if (!resolvedProviderId) throw new Error("No providerId specified");
  
  const provider = providerRegistry.get(resolvedProviderId);
  
  const boundedPrompt = [spec.prompt, ...spec.instructions].join("\n\n");
  const guestOutputDir = reservedGuestOutputDirForAttempt(spec.attemptId);

  return {
    command: provider.command,
    stdin: boundedPrompt,
    env: {
      BAKUDO_GUEST_OUTPUT_DIR: guestOutputDir,
    },
  };
};
```

### 4. Pre-flight Policy Check
In `src/host/executeAttempt.ts`, before spawning `abox`, verify the policies. (Mock this check initially, as `abox` config parsing is handled by the Rust core, but `bakudo` should eventually read `~/.config/abox/config.toml`).

## Testing
- **Local LLM Test:** Create a mock provider in the registry pointing to a local `llama.cpp` CLI script. Run an interactive session to ensure the registry resolves the command correctly and executes.

## Cleanup
- Remove any hardcoded `agentBackend` string parsing in the codebase.

## Acceptance Criteria
- `bakudo` can execute an attempt using a provider ID (e.g., `claude-code`) instead of a raw command string.
- The system throws a clear error if an unregistered provider ID is requested.
