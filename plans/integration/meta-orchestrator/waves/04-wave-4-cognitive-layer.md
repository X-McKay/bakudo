# Wave 4: Cognitive Layer (Reflection & Memory)

**Goal:** Implement the self-improving loop. Introduce the Critic and Curator sub-agents, and build the three-tiered memory system (Episodic, Semantic, Procedural) so that `bakudo` learns from failures across sessions.

**Non-Goals:** Do not implement vector-database search. The memory system relies entirely on `git`-tracked Markdown files managed by the Curator agent.

## Rationale
Without memory, an agent will make the same mistake a thousand times. The Cognitive Layer solves this by physically separating execution from reflection. When a Worker fails repeatedly, the Critic analyzes the failure. The Curator then updates the system's durable Knowledge Graph, ensuring the *next* Worker doesn't make the same mistake.

## Dependencies
- **Requires:** Wave 3 (Daemon Gateway) — the Curator runs in the background within the Daemon.
- **Blocks:** None. This completes the Cognitive Meta-Orchestrator.

## Files to Modify

1. `src/host/providerRegistry.ts`
   - **Reason:** Register the Critic and Curator agents.
2. `src/host/orchestration/objectiveController.ts`
   - **Reason:** Hook the Critic into the failure path of a CandidateSet.
3. `src/daemon/curator.ts` (New File)
   - **Reason:** The background loop that consolidates Critic Post-Mortems into `.bakudo/memory/semantic/`.
4. `src/worker/criticRunner.ts` (New File)
   - **Reason:** The runner that injects the failed transcript and diff into the Critic's prompt.

## Step-by-Step Implementation

### 1. Define the Memory Structure
The Curator will manage this folder structure in the target repository:
```
.bakudo/
  memory/
    episodic/     # Raw transcripts (ignored by git)
    semantic/     # Markdown rules (e.g., package-manager.md)
    procedural/   # Markdown playbooks (e.g., add-route.md)
```

### 2. Register the Cognitive Agents
In `src/host/providerRegistry.ts`:

```typescript
providerRegistry.register({
  id: "critic",
  name: "Reflection Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"],
});

providerRegistry.register({
  id: "curator",
  name: "Memory Consolidation Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api", "git-write"], // Needs to commit to .bakudo/
});
```

### 3. Create the Critic Runner
Create `src/worker/criticRunner.ts`:

```typescript
import { providerRegistry } from "../host/providerRegistry.js";

const CRITIC_PROMPT = `
You are the Critic. The Worker agent just failed to complete its task after multiple retries.
Below is the execution transcript and the final git diff.
Analyze exactly WHY the Worker failed. Was it a syntax error? A misunderstanding of the codebase?
Output a structured Post-Mortem starting with "LESSON LEARNED: ".
`;

export const runCritic = (transcript: string, diff: string) => {
  const provider = providerRegistry.get("critic");
  return {
    command: provider.command,
    stdin: `${CRITIC_PROMPT}\n\nTRANSCRIPT:\n${transcript}\n\nDIFF:\n${diff}`,
  };
};
```

### 4. Hook the Critic into the Orchestrator
In `src/host/orchestration/objectiveController.ts` (from Wave 3), update the failure path:

```typescript
import { runCritic } from "../../worker/criticRunner.js";
import { triggerCurator } from "../../daemon/curator.js";

// Inside advance()
if (winnerIndex >= 0) {
  // ... success path
} else {
  activeCampaign.status = "failed";
  
  // Grab the transcript of the first failed candidate
  const failedCandidate = activeCampaign.candidateSet.candidates[0];
  const transcript = await readTranscript(failedCandidate.candidateId);
  const diff = await readDiff(failedCandidate.candidateId);
  
  // 1. Reflect
  const postMortem = await executeAttempt({ ...failedCandidate, runner: runCritic(transcript, diff) });
  
  // 2. Consolidate
  await triggerCurator(postMortem.output);
  
  // 3. Retry Campaign with new memory
  this.retryCampaign(activeCampaign);
}
```

### 5. Implement the Curator
Create `src/daemon/curator.ts`:

```typescript
import { headlessExecute } from "../host/orchestration/headlessExecute.js";
import { gitWriteMutex } from "./gateway.js";

const CURATOR_PROMPT = `
You are the Curator. You manage the Semantic Memory of this codebase.
Read the Post-Mortem below. Decide if it warrants a new rule in the Knowledge Graph, or an update to an existing rule.
Write the updated Markdown file to .bakudo/memory/semantic/.

CRITICAL RULES:
- You may create or edit files in .bakudo/memory/
- You may run \`git add\` and \`git commit\` for those files.
- You MUST NEVER push, merge PRs, or modify code outside of .bakudo/memory/.
`;

export const triggerCurator = async (postMortem: string) => {
  // Acquire the Daemon-level git mutex to prevent collisions with the Janitor
  const release = await gitWriteMutex.acquire();
  try {
    // Dispatch a background attempt for the Curator provider
    // using headlessExecute so it bypasses the interactive CLI.
  } finally {
    release();
  }
};
```

## Testing
- **End-to-End Learning Test:** 
  1. Give the Daemon an Objective that requires `pnpm`.
  2. The Worker (by default) tries `npm install` and fails.
  3. Verify the Critic writes a Post-Mortem.
  4. Verify the Curator writes `.bakudo/memory/semantic/package-manager.md`.
  5. Verify the retried Worker successfully uses `pnpm`.

## Cleanup
- Ensure transcripts are properly rotated out of `episodic/` to avoid disk bloat.

## Acceptance Criteria
- A failed Campaign automatically triggers a Critic reflection.
- The Curator successfully writes generalized rules to `.bakudo/memory/semantic/`.
- Subsequent Campaigns automatically load relevant Semantic Memory into the Worker's prompt.
