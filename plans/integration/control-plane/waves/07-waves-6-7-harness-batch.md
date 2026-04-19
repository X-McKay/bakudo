# Waves 6 & 7: Live Harness & Batch Seams

**Goal:** Create a live integration test harness that mocks `abox` so the host pipeline can be tested end-to-end without a real microVM, and lay the data-model foundation for multi-candidate batching (Wave 7).

**Non-Goals:** Do not build the parallel orchestration runner yet. The batch seams are just data types and UI placeholders to prepare for future parallel execution.

## Pre-reads & Vocabulary
- Review `2026-04-19-bakudo-abox-control-plane-spec.md` (Sections: Wave 6 and Wave 7).
- **Mock Abox:** A shell script that pretends to be the `abox` CLI, creating dummy worktrees and outputting predictable text.
- **CandidateSet:** A group of parallel executions for the same task.

## Dependencies
- **Requires:** Wave 5 (Persistence & UI).
- **Blocks:** None.

## Files to Modify

1. `tests/helpers/mockAbox.sh` (New File)
   - **Reason:** The mock executable.
2. `tests/integration/pipeline.test.ts` (New File)
   - **Reason:** The end-to-end test suite using the mock.
3. `src/attemptProtocol.ts`
   - **Reason:** Add `CandidateSet` and `BatchSpec` types.

## Step-by-Step Implementation

### 1. Create the Mock Abox (`tests/helpers/mockAbox.sh`)

This script intercepts `abox run`, `abox merge`, and `abox stop`.

```bash
#!/bin/bash
# tests/helpers/mockAbox.sh

COMMAND=$1
shift

if [ "$COMMAND" = "run" ]; then
  # Parse args
  while [[ "$#" -gt 0 ]]; do
    case $1 in
      --task) TASK_ID="$2"; shift ;;
      --repo) REPO="$2"; shift ;;
      --ephemeral) EPHEMERAL=1 ;;
    esac
    shift
  done

  echo "Mocking abox run for task: $TASK_ID"
  
  if [ -z "$EPHEMERAL" ]; then
    # Simulate a preserved worktree
    WORKTREE_PATH="/tmp/mock-worktree-$TASK_ID"
    mkdir -p "$WORKTREE_PATH"
    
    # Mock the git porcelain output by writing a fake file that the test harness can inject into discoverWorktree
    echo "worktree $WORKTREE_PATH" > "/tmp/mock-git-porcelain-$TASK_ID"
    echo "HEAD 123456" >> "/tmp/mock-git-porcelain-$TASK_ID"
    echo "branch refs/heads/agent/$TASK_ID" >> "/tmp/mock-git-porcelain-$TASK_ID"
    
    # Simulate the worker writing artifacts
    mkdir -p "$WORKTREE_PATH/.bakudo-artifacts"
    echo "fake patch" > "$WORKTREE_PATH/.bakudo-artifacts/patch.diff"
  fi
  
  exit 0
fi

if [ "$COMMAND" = "merge" ]; then
  echo "Mocking abox merge"
  exit 0
fi

if [ "$COMMAND" = "stop" ]; then
  echo "Mocking abox stop"
  exit 0
fi
```

### 2. Create the Integration Test (`tests/integration/pipeline.test.ts`)

Write a test that overrides the `aboxBin` path in the config to point to the mock script, then calls `executeAttempt`.

```typescript
// tests/integration/pipeline.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { executeAttempt } from "../../src/host/executeAttempt.js";
// ... imports ...

test("executeAttempt - auto merge pipeline", async () => {
  // 1. Set up mock context
  const ctx = {
    repoRoot: "/tmp/mock-repo",
    sessionDir: "/tmp/mock-session",
    config: { aboxBin: "./tests/helpers/mockAbox.sh" },
  };
  
  // 2. Create a DispatchPlan with auto-merge
  const plan = {
    // ... valid DispatchPlan ...
    profile: {
      agentBackend: "mock",
      sandboxLifecycle: "preserved",
      mergeStrategy: "auto",
    }
  };
  
  // 3. Execute
  const result = await executeAttempt(ctx, plan);
  
  // 4. Assert
  assert.equal(result.status, "succeeded");
  // Assert that mockAbox.sh was called with merge
});
```

### 3. Add Batch Types (`src/attemptProtocol.ts`)

Introduce the types for future parallel execution.

```typescript
// src/attemptProtocol.ts

export type BatchSpec = {
  batchId: string;
  intentId: string;
  candidates: DispatchPlan[];
};

export type CandidateSetResult = {
  batchId: string;
  results: Record<string, AttemptExecutionResult>;
  selectedCandidateId?: string;
};
```

## Test Strategy
- **Integration:** The new `pipeline.test.ts` acts as the primary test for the entire host pipeline.

## Acceptance Criteria
- `pnpm test` runs the integration test successfully.
- The types are available for the UX layer to consume.

## Rollback
Delete the test file and mock script if they cause CI instability.
