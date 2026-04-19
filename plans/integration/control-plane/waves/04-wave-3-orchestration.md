# Wave 3: Orchestration & Adapter Split

**Goal:** Deconstruct the monolithic `aboxAdapter.ts` into focused lifecycle modules (`sandboxLifecycle.ts`, `worktreeDiscovery.ts`, `mergeController.ts`), and update the host execution pipeline to use `profile.sandboxLifecycle` instead of the `BAKUDO_EPHEMERAL` environment variable.

**Non-Goals:** Do not change how the host reviews the result yet. The execution pipeline will still call `reviewAttemptResult` immediately after the worker finishes.

## Pre-reads & Vocabulary
- Review `2026-04-19-bakudo-abox-control-plane-spec.md` (Section: The Orchestration Layer).
- **Worktree Discovery:** The process of running `git worktree list --porcelain` to find the physical path of a preserved sandbox.
- **Merge Controller:** The host-side logic that invokes `abox merge` or `abox stop --clean`.

## Dependencies
- **Requires:** Wave 1 (Data Model).
- **Blocks:** Wave 4 (Review Decoupling).

## Files to Modify

1. `src/host/aboxAdapter.ts`
   - **Reason:** Strip this down to just the raw `runInStreamLive` spawn wrapper. Move task ID generation out.
2. `src/host/sandboxLifecycle.ts` (New File)
   - **Reason:** Centralize task ID generation, sandbox naming conventions, and the logic to decide if `--ephemeral` should be passed to `abox run`.
3. `src/host/worktreeDiscovery.ts` (New File)
   - **Reason:** Implement the `git worktree list --porcelain` parser.
4. `src/host/mergeController.ts` (New File)
   - **Reason:** Implement `abox merge` and `abox stop --clean` wrappers.
5. `src/host/executeAttempt.ts`
   - **Reason:** Update to use `sandboxLifecycle.ts` to build the command, reading from `plan.profile.sandboxLifecycle` instead of `process.env.BAKUDO_EPHEMERAL`.
6. `src/host/orchestration.ts` (Delete)
   - **Reason:** Remove legacy `executeTask` and `WorkerTaskSpec` wrappers.

## Step-by-Step Implementation

### 1. Create `sandboxLifecycle.ts`

This module owns the mapping from `ExecutionProfile` to `abox` flags.

```typescript
// src/host/sandboxLifecycle.ts
import type { ExecutionProfile } from "../attemptProtocol.js";

export const generateSandboxTaskId = (attemptId: string): string => {
  const sanitized = attemptId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `bakudo-${sanitized}`;
};

export const buildAboxRunArgs = (
  taskId: string,
  profile: ExecutionProfile,
  repoPath?: string,
): string[] => {
  const args = [];
  if (repoPath) {
    args.push("--repo", repoPath);
  }
  args.push("run", "--task", taskId);
  
  if (profile.sandboxLifecycle === "ephemeral") {
    args.push("--ephemeral");
  }
  
  return args;
};
```

### 2. Create `worktreeDiscovery.ts`

Implement the git parser.

```typescript
// src/host/worktreeDiscovery.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorktreeSnapshot = {
  path: string;
  branch: string;
  head: string;
};

export const discoverWorktree = async (
  repoPath: string,
  taskId: string,
): Promise<WorktreeSnapshot | null> => {
  const expectedBranch = `refs/heads/agent/${taskId}`;
  
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
    });
    
    let currentPath = "";
    let currentHead = "";
    
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice(9).trim();
      } else if (line.startsWith("HEAD ")) {
        currentHead = line.slice(5).trim();
      } else if (line.startsWith("branch ")) {
        const branch = line.slice(7).trim();
        if (branch === expectedBranch) {
          return { path: currentPath, branch, head: currentHead };
        }
      }
    }
    return null;
  } catch (err) {
    // If git fails (e.g., old version, no repo), return null
    return null;
  }
};
```

### 3. Create `mergeController.ts`

```typescript
// src/host/mergeController.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const mergeSandbox = async (
  aboxBin: string,
  repoPath: string,
  taskId: string,
): Promise<void> => {
  await execFileAsync(aboxBin, ["--repo", repoPath, "merge", "--task", taskId]);
};

export const discardSandbox = async (
  aboxBin: string,
  repoPath: string,
  taskId: string,
): Promise<void> => {
  await execFileAsync(aboxBin, ["--repo", repoPath, "stop", "--task", taskId, "--clean"]);
};
```

### 4. Update `executeAttempt.ts`

Remove the `BAKUDO_EPHEMERAL` check. Use `sandboxLifecycle.ts` to build the arguments.

```typescript
// src/host/executeAttempt.ts
import { generateSandboxTaskId, buildAboxRunArgs } from "./sandboxLifecycle.js";

// Inside executeAttempt:
const taskId = generateSandboxTaskId(plan.spec.attemptId);
const aboxArgs = buildAboxRunArgs(taskId, plan.profile, ctx.repoRoot);

// ... pass aboxArgs to the simplified adapter ...
```

### 5. Strip `aboxAdapter.ts`

Remove `buildInvocation` and the `sequence` state. The adapter should just take `cmd: string[]` directly from the caller.

### 6. Delete Legacy Code

Delete `src/host/orchestration.ts` entirely. Remove any imports of `WorkerTaskSpec` or `executeTask` from the codebase.

## Test Strategy
- **Unit:** Write tests for `worktreeDiscovery.ts` that mock `execFile` and return various `--porcelain` outputs.
- **Integration:** None required yet; the merge controller is not called until Wave 4.

## Acceptance Criteria
- `pnpm test:unit` passes.
- `BAKUDO_EPHEMERAL` no longer appears anywhere in the codebase.
- `orchestration.ts` is deleted.

## Rollback
If the adapter split causes widespread breakage in tests, revert the commit. This wave touches the core pipeline, so it must land cleanly before proceeding.
