# Wave 5: Extended Autonomy Loop (Explorer, Synthesizer, Janitor)

**Goal:** Complete the cognitive roster by introducing three specialized sub-agents that handle proactive discovery, parallel result merging, and background codebase hygiene. This wave makes the system genuinely autonomous by fixing the three failure modes that Waves 1–4 leave open: hallucinated context, wasted parallel work, and codebase rot over long runs.

**Non-Goals:** Do not build new orchestration primitives. Wave 5 composes roles on top of the existing `ObjectiveController`, `ResourceBudget`, and `ProviderRegistry`. No new HTTP surface, no new state models beyond a `SynthesisRecord` helper.

## Rationale
Waves 1–4 gave us a reactive system: it plans, executes, tests, reflects, remembers. But three gaps remain.

First, the Architect plans blind. It decomposes an Objective using only the LLM's prior knowledge and whatever Semantic Memory the Curator has accumulated, which means it happily hallucinates APIs, library behaviors, and codebase structure. The **Explorer** closes that gap by doing proactive reconnaissance *before* the Architect commits to a plan, producing an Intelligence Report grounded in real file contents, real API responses, and real spike-script outputs.

Second, the `ObjectiveController` currently takes the first successful Candidate and discards the rest. When we ran three Candidates in parallel and two of them succeeded, we threw away half of the value. The **Synthesizer** reads every successful diff and merges the best ideas into a single unified result — Candidate A's fast algorithm plus Candidate B's better error handling.

Third, nothing tends to the codebase between Objectives. Over a long run, dead code accumulates, dependencies go stale, and the Semantic Memory rules written by the Curator start to drift from reality. The **Janitor** runs during Daemon idle time, finds low-risk cleanups, and opens small atomic PRs so the system leaves the codebase cleaner than it found it.

## Dependencies
- **Requires:** Wave 3 (Daemon + ResourceBudget) and Wave 4 (Curator + Semantic Memory).
- **Blocks:** None. This wave completes the Cognitive Meta-Orchestrator.

## Files to Modify

1. `src/host/providerRegistry.ts` — register `explorer`, `synthesizer`, `janitor`.
2. `src/worker/explorerRunner.ts` (New) — reconnaissance runner with read-only repo and full egress.
3. `src/worker/synthesizerRunner.ts` (New) — merge runner that reads multiple winning diffs.
4. `src/daemon/janitor.ts` (New) — idle-time background loop.
5. `src/host/orchestration/objectiveController.ts` — hook Explorer before decomposition, Synthesizer after CandidateSet completion.
6. `src/host/orchestration/resourceBudget.ts` — extend per-role limits for the new roles.

## Step-by-Step Implementation

### 1. Extend the Resource Budget
Every new role must declare its resource ceiling. Update `resourceBudget.ts`:

```typescript
export const defaultBudget: ResourceBudget = {
  maxConcurrentSandboxes: 5,
  maxCandidatesPerCampaign: 3,
  perRoleLimits: {
    "worker":       { memoryMb: 2048, cpuCores: 2 },
    "chaos-monkey": { memoryMb: 1024, cpuCores: 1 },
    "architect":    { memoryMb: 1024, cpuCores: 1 },
    "critic":       { memoryMb: 1024, cpuCores: 1 },
    "curator":      { memoryMb: 1024, cpuCores: 1 },
    // Wave 5 additions
    "explorer":     { memoryMb: 1536, cpuCores: 1 },
    "synthesizer":  { memoryMb: 2048, cpuCores: 2 },
    "janitor":      { memoryMb: 1024, cpuCores: 1 },
  },
  // New: Janitor must never preempt Worker capacity
  janitorMaxConcurrent: 1,
  janitorRunsOnlyWhenIdle: true,
};
```

### 2. Register the Three Roles
In `src/host/providerRegistry.ts`:

```typescript
providerRegistry.register({
  id: "explorer",
  name: "Reconnaissance Agent",
  command: ["claude", "--print-responses"],
  // Explorer needs read-only repo + broad egress for docs/APIs.
  // Declare the policy set so abox mounts the worktree read-only and
  // allows egress to documentation hosts and the Semantic Memory proxy.
  requiredPolicies: ["anthropic-api", "read-only-repo", "web-read"],
});

providerRegistry.register({
  id: "synthesizer",
  name: "Parallel Merge Agent",
  command: ["claude", "--print-responses"],
  // Synthesizer reads multiple worktrees, writes one unified diff.
  requiredPolicies: ["anthropic-api", "multi-worktree-read", "git-write"],
});

providerRegistry.register({
  id: "janitor",
  name: "Codebase Hygiene Agent",
  command: ["claude", "--print-responses"],
  requiredPolicies: ["anthropic-api", "git-write"],
});
```

### 3. Implement the Explorer
Create `src/worker/explorerRunner.ts`:

```typescript
import { providerRegistry } from "../host/providerRegistry.js";

const EXPLORER_PROMPT = `
You are the Explorer. You are given an Objective and read-only access to the codebase.
You do NOT write code. You produce an Intelligence Report.

Your report must answer, in order:
1. Which files/modules are relevant to this Objective? (cite paths)
2. Which external libraries or APIs will be involved? (cite real docs, not guesses)
3. What is the current behavior we are about to change? (cite specific functions/lines)
4. What are the top 3 ways this Objective could go wrong?
5. What open questions should the Architect answer before planning?

Output the report as Markdown. Do NOT propose a plan — that is the Architect's job.
`;

export const runExplorer = (objectiveGoal: string) => {
  const provider = providerRegistry.get("explorer");
  return {
    command: provider.command,
    stdin: `${EXPLORER_PROMPT}\n\nOBJECTIVE:\n${objectiveGoal}`,
  };
};
```

Hook it into the `ObjectiveController` before `decomposeObjective`:

```typescript
async advance(): Promise<void> {
  if (this.objective.campaigns.length === 0) {
    // NEW: Run Explorer first, attach report to Architect's context.
    const intelReport = await runAndCollectExplorer(this.objective.goal);
    this.objective.explorerReport = intelReport;
    await this.decomposeObjective(); // Architect now reads this.objective.explorerReport
  }
  // ... rest unchanged
}
```

**Explorer-stuck fallback:** When a Worker fails three times in a Campaign, the Critic may now return a verdict of `NEEDS_EXPLORATION` instead of `LESSON_LEARNED`. When it does, the controller re-runs the Explorer with the failure context and then re-decomposes that single Campaign.

### 4. Implement the Synthesizer
Create `src/worker/synthesizerRunner.ts`:

```typescript
import { providerRegistry } from "../host/providerRegistry.js";

const SYNTHESIZER_PROMPT = `
You are the Synthesizer. Multiple Candidates succeeded in parallel.
You have read access to each Candidate's final worktree.
Your job is to produce ONE unified diff that takes the best idea from each.

Rules:
- If two Candidates chose conflicting approaches for the same sub-problem, pick the one with better test coverage or shorter code (in that order).
- If they took complementary approaches (e.g., A improved perf, B improved errors), combine them.
- The final diff MUST pass all tests from all winning Candidates.
- If synthesis is not beneficial (one Candidate is strictly better), output exactly: "USE_CANDIDATE: <id>" and stop.
- If the diffs conflict in a way that requires human judgment, output exactly: "MANUAL_REVIEW_REQUIRED" and stop.
`;

export const runSynthesizer = (winningCandidateIds: string[]) => {
  const provider = providerRegistry.get("synthesizer");
  return {
    command: provider.command,
    stdin: `${SYNTHESIZER_PROMPT}\n\nWINNING_CANDIDATES:\n${winningCandidateIds.join("\n")}`,
  };
};
```

Update the success path in `ObjectiveController.advance`:

```typescript
const winners = results
  .map((r, i) => ({ r, i }))
  .filter(({ r }) => r.status === "fulfilled" && r.value.success);

if (winners.length === 0) {
  // ... existing failure/Critic path
} else if (winners.length === 1) {
  // Single winner: short-circuit, no synthesis needed.
  activeCampaign.winnerCandidateId = allowedCandidates[winners[0].i].candidateId;
  activeCampaign.status = "completed";
} else {
  // Multiple winners: invoke Synthesizer.
  const winningIds = winners.map(({ i }) => allowedCandidates[i].candidateId);
  const synthesized = await runAndCollectSynthesizer(winningIds);
  
  if (synthesized.output.includes("MANUAL_REVIEW_REQUIRED")) {
    activeCampaign.status = "completed"; // or a new 'needs_review' state
    // Add to user review queue; do NOT auto-merge.
  } else {
    activeCampaign.winnerCandidateId = synthesized.candidateId;
    activeCampaign.synthesisRecord = { mergedFrom: winningIds, rationale: synthesized.output };
    activeCampaign.status = "completed";
  }
}
```

### 5. Implement the Janitor
Create `src/daemon/janitor.ts`:

```typescript
import { defaultBudget } from "../host/orchestration/resourceBudget.js";
import { providerRegistry } from "../host/providerRegistry.js";

const JANITOR_PROMPT = `
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

Output a single atomic diff. If nothing is worth doing, output exactly: "NO_WORK".
`;

export interface JanitorScheduler {
  activeObjectives: () => number;
  activeSandboxes: () => number;
  lastRunAt?: Date;
}

import { gitWriteMutex } from "./gateway.js";

export const maybeRunJanitor = async (sched: JanitorScheduler) => {
  // Resource-budget gate: never preempt real work.
  if (!defaultBudget.janitorRunsOnlyWhenIdle) return;
  if (sched.activeObjectives() > 0) return;
  if (sched.activeSandboxes() >= defaultBudget.maxConcurrentSandboxes - 1) return;

  // Rate-limit: at most one Janitor run per hour.
  if (sched.lastRunAt && Date.now() - sched.lastRunAt.getTime() < 60 * 60 * 1000) return;

  // Acquire the Daemon-level git mutex to prevent collisions with the Curator
  if (gitWriteMutex.isLocked()) return; // Skip this tick if Curator is writing
  const release = await gitWriteMutex.acquire();
  
  try {
    const provider = providerRegistry.get("janitor");
    // Dispatch via headlessExecute with JANITOR_PROMPT + git-write policy.
    // Remember: Janitor may stage or open PRs, but MUST NEVER merge them.
  } finally {
    release();
  }
};
```

Wire it into the Daemon's idle tick (e.g., a `setInterval` on the Gateway):

```typescript
setInterval(() => {
  maybeRunJanitor({
    activeObjectives: () => [...activeControllers.values()].filter(c => c.isActive()).length,
    activeSandboxes: () => globalSandboxRegistry.count(),
    lastRunAt: janitorLastRunAt,
  });
}, 60_000);
```

### 6. Observability
Add the three new roles to the Daemon's metrics endpoint (or structured logs, depending on what Wave 3 landed with). At minimum, each role should report: invocation count, average duration, success/failure ratio, and total tokens consumed. This is what lets the user see at a glance whether the Explorer is actually helping (Worker retry rate should drop) or whether the Janitor is being too aggressive (PR merge rate should stay high).

## Testing

### Local LLM End-to-End Tests
- **Explorer:** Submit an Objective that mentions a library the LLM has weak priors on (e.g., "integrate with the new FastAPI-MCP bridge"). Verify the Explorer's Intelligence Report cites real doc URLs and flags uncertainty, and that the Architect's resulting Campaign plan references the report.
- **Synthesizer:** Submit an Objective likely to produce multiple winners (e.g., "add rate limiting"). Force a CandidateSet of 3 Candidates. Verify that when ≥2 succeed, the Synthesizer runs and the merged diff contains substantive contributions from at least two of them.
- **Janitor:** Start the Daemon with no active Objectives. Wait one idle tick. Verify the Janitor opens at most one atomic PR containing only low-risk changes.

### Budget Tests
- **Concurrency cap:** Submit an Objective that would spawn 6 sandboxes. Verify the controller blocks at `maxConcurrentSandboxes=5` and queues the 6th.
- **Janitor preemption:** Submit an Objective while the Janitor is mid-run. Verify the Janitor run is allowed to complete (do not kill it) but no new Janitor invocation starts while the Objective is active.

## Cleanup
- Delete any first-winner-wins shortcuts left in `objectiveController.ts` from Wave 3 once the Synthesizer path is verified.
- Remove any ad-hoc "grep for context" code that existed as a stopgap for the Architect before Wave 5 — the Explorer now owns that responsibility.

## Acceptance Criteria
1. Every Objective produces an Explorer Intelligence Report before Campaign decomposition, and the Architect's prompt references it verbatim.
2. When a Campaign's CandidateSet produces ≥2 successful Candidates, the Synthesizer runs and produces a merged diff (or explicitly defers to a single Candidate via `USE_CANDIDATE`).
3. When the Daemon has no active Objectives for at least 5 minutes and the Janitor hasn't run in the last hour, the Janitor runs and either opens one atomic PR or outputs `NO_WORK`.
4. The `ResourceBudget` caps are respected: no more than `maxConcurrentSandboxes` at once, no more than `maxCandidatesPerCampaign` per Campaign, and the Janitor never preempts a Worker.
5. Every new role enforces its `requiredPolicies` through `abox`'s native stub-injection; no new environment-variable credential paths introduced.
