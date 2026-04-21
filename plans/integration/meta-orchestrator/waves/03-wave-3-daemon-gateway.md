# Wave 3: Daemon Gateway & Control Plane

**Goal:** Introduce the long-running background Daemon and the new `Objective` state model. This wave builds the infrastructure required to decompose high-level goals into Campaigns, and to dispatch parallel CandidateSets using the Provider Registry built in Wave 1.

**Non-Goals:** Do not implement the cognitive reflection (Critic) or background memory management (Librarian) yet. This wave focuses purely on multi-task orchestration and persistence.

## Rationale
`bakudo` currently runs as a foreground CLI. If you close your terminal, the agent dies. To be a "very long running" Meta-Orchestrator, we need a background Daemon (like `dockerd` or OpenHarness's Gateway) that owns the state of active `Objectives`. The Daemon can spawn parallel `abox` sandboxes and wait for them to return asynchronously.

## Dependencies
- **Requires:** Wave 1 (Provider Registry) and Wave 2 (Chaos Monkey).
- **Blocks:** Wave 4 (Cognitive Layer).

## Files to Modify

1. `src/attemptProtocol.ts`
   - **Reason:** Update the `BatchSpec` and `CandidateSet` Zod schemas to support the new `Objective` and `Campaign` fields so they survive serialization.
2. `src/host/orchestration/objectiveState.ts` (New File)
   - **Reason:** Define the durable state model: `Objective` -> `Campaign` -> `CandidateSet`.
3. `src/host/orchestration/headlessExecute.ts` (New File)
   - **Reason:** The execution wrapper that isolates the Daemon from the interactive `SessionController` and orchestrates the Worker -> Chaos Monkey loop.
4. `src/host/orchestration/objectiveController.ts` (New File)
   - **Reason:** The state machine that advances an Objective by calling `headlessExecute` in parallel.
5. `src/daemon/gateway.ts` (New File)
   - **Reason:** A simple HTTP server that accepts Objectives and provides the `gitWriteMutex` primitive for background agents.
6. `src/host/providerRegistry.ts`
   - **Reason:** Register the "Architect" agent.

## Step-by-Step Implementation

### 0. Define the Resource Budget
Create `src/host/orchestration/resourceBudget.ts`:

```typescript
export interface ResourceBudget {
  maxConcurrentSandboxes: number;
  maxCandidatesPerCampaign: number;
  perRoleLimits: {
    [role: string]: {
      memoryMb: number;
      cpuCores: number;
    };
  };
}

export const defaultBudget: ResourceBudget = {
  maxConcurrentSandboxes: 5,
  maxCandidatesPerCampaign: 3,
  perRoleLimits: {
    "worker": { memoryMb: 2048, cpuCores: 2 },
    "chaos-monkey": { memoryMb: 1024, cpuCores: 1 },
    "architect": { memoryMb: 1024, cpuCores: 1 },
  },
};
```

### 1. Update Protocol Schemas
In `src/attemptProtocol.ts`, ensure `CandidateSet` can carry the new state fields:

```typescript
export const CandidateSetSchema = BatchSpecSchema.extend({
  objectiveId: z.string().optional(),
  campaignId: z.string().optional(),
});
export type CandidateSet = z.infer<typeof CandidateSetSchema>;
```

### 2. Define the Objective State Model
Create `src/host/orchestration/objectiveState.ts`:

```typescript
import { z } from "zod";
import type { BatchSpec } from "../../attemptProtocol.js";

export const CampaignSchema = z.object({
  campaignId: z.string(),
  description: z.string(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  candidateSet: z.any(), // Maps to existing BatchSpec
  winnerCandidateId: z.string().optional(),
});

export const ObjectiveSchema = z.object({
  objectiveId: z.string(),
  goal: z.string(),
  status: z.enum(["active", "paused", "completed"]),
  campaigns: z.array(CampaignSchema),
});

export type Objective = z.infer<typeof ObjectiveSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
```

### 3. Register the Architect
In `src/host/providerRegistry.ts`, add the Architect role:

```typescript
providerRegistry.register({
  id: "architect",
  name: "Decomposition Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api"], // Only needs LLM access, no network egress
});
```

### 4. The Objective Controller Loop
Create `src/host/orchestration/objectiveController.ts`:

```typescript
import { headlessExecute } from "./headlessExecute.js";
import type { Objective, Campaign } from "./objectiveState.js";

export class ObjectiveController {
  constructor(private objective: Objective) {}

  async advance(): Promise<void> {
    if (this.objective.campaigns.length === 0) {
      await this.decomposeObjective();
    }

    const activeCampaign = this.objective.campaigns.find(c => c.status === "pending");
    if (!activeCampaign) return;

    activeCampaign.status = "running";
    
    // Dispatch candidates in parallel, respecting the ResourceBudget
    const allowedCandidates = activeCampaign.candidateSet.candidates.slice(0, defaultBudget.maxCandidatesPerCampaign);
    
    const promises = allowedCandidates.map(candidate => 
      headlessExecute(candidate) // This triggers the Worker -> Chaos Monkey loop from Wave 2
    );

    const results = await Promise.allSettled(promises);
    
    // Select the winner (first successful candidate)
    const winnerIndex = results.findIndex(r => r.status === "fulfilled" && r.value.success);
    
    if (winnerIndex >= 0) {
      activeCampaign.status = "completed";
      activeCampaign.winnerCandidateId = activeCampaign.candidateSet.candidates[winnerIndex].candidateId;
      // TODO (Wave 4): Extract lessons from losers here
    } else {
      activeCampaign.status = "failed";
    }
  }

  private async decomposeObjective() {
    // 1. Build an AttemptSpec for the 'architect' provider.
    // 2. Prompt it to output a JSON array of Campaigns based on the objective.goal.
    // 3. Parse JSON and populate this.objective.campaigns.
  }
}
```

### 5. The Daemon Gateway and Git Mutex
Create `src/daemon/gateway.ts` (a simple HTTP server):

```typescript
import express from "express";
import { Mutex } from "async-mutex";

export const gitWriteMutex = new Mutex(); // Exported for Curator and Janitor to acquire

import { ObjectiveController } from "../host/orchestration/objectiveController.js";

const app = express();
app.use(express.json());

const activeControllers = new Map<string, ObjectiveController>();

app.post("/objective", (req, res) => {
  const { goal } = req.body;
  const objectiveId = `obj-${Date.now()}`;
  
  const controller = new ObjectiveController({
    objectiveId,
    goal,
    status: "active",
    campaigns: []
  });
  
  activeControllers.set(objectiveId, controller);
  
  // Kick off the background loop
  controller.advance().catch(console.error);
  
  res.json({ objectiveId, status: "accepted" });
});

app.listen(3000, () => console.log("Daemon Gateway listening on port 3000"));
```

## Testing
- **Local Integration Test:** Start the daemon. Use `curl` to submit an Objective: "Refactor the auth middleware to use JWT." Verify the Architect decomposes it, and the Daemon spawns multiple `abox` sandboxes in parallel to execute the first Campaign.

## Cleanup
- No major cleanup required; this code sits parallel to the existing interactive `SessionController`.

## Acceptance Criteria
- The Daemon can accept an Objective via HTTP and return immediately.
- The Architect successfully decomposes the Objective into a list of Campaigns.
- The Daemon executes the Candidates of a Campaign in parallel using `Promise.allSettled`.
