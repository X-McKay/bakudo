# Wave 0: Correctness Floor

**Goal:** Fix pre-existing bugs in the current execution pipeline so that the foundation is solid before structural refactoring begins.

**Non-Goals:** Do not introduce new types (`DispatchPlan`, `ExecutionProfile`) or change the orchestration flow. This wave is strictly about fixing bugs in the current architecture.

## Pre-reads & Vocabulary
- Review `2026-04-19-bakudo-abox-control-plane-spec.md` (Observations O-1 through O-5).
- Understand that `workerRuntime.ts` currently ignores `stdin` when spawning tasks.

## Dependencies
- **Requires:** None.
- **Blocks:** Wave 1 (Data Model).

## Files to Modify

1. `src/config.ts`
   - **Reason:** Add `resolveDefaultConfigPath()` to fallback to the install root so `bakudo` works outside the repo.
2. `package.json`
   - **Reason:** Add `config/default.json` to the `files` array so it is published.
3. `scripts/package-release.sh`
   - **Reason:** Copy `config/default.json` into the release bundle.
4. `src/workerRuntime.ts`
   - **Reason:** Pipe `stdin` to the spawned child process if `resolved.stdin` is provided.
5. `src/worker/assistantJobRunner.ts`
   - **Reason:** Stop passing the prompt as a positional argument; populate `TaskRunnerCommand.stdin` instead.
6. `src/worker/checkRunner.ts`
   - **Reason:** Respect `spec.execution.command` if provided, instead of hardcoding `bash -lc`.
7. `src/host/sessionLifecycle.ts`
   - **Reason:** Change "Task Failed" terminal wording to "Attempt Failed" to align with the new vocabulary.

## Step-by-Step Implementation

### 1. Fix Config Resolution (W0.1)

Modify `src/config.ts` to add a resolver that checks the caller's CWD first, then falls back to the install root.

```typescript
// src/config.ts
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG_FILE = "config/default.json";

const installRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
};

export const resolveDefaultConfigPath = (
  override?: string | undefined,
  cwd: string = process.cwd(),
): string => {
  if (override !== undefined && override.length > 0 && override !== DEFAULT_CONFIG_FILE) {
    return resolve(cwd, override);
  }
  const cwdCandidate = resolve(cwd, DEFAULT_CONFIG_FILE);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return resolve(installRoot(), DEFAULT_CONFIG_FILE);
};

// Update loadConfig to use it:
export const loadConfig = async (path: string): Promise<RuntimeFileConfig> => {
  const resolved = resolveDefaultConfigPath(path);
  const raw = await readFile(resolved, "utf8");
  return JSON.parse(raw) as RuntimeFileConfig;
};
```

Update `src/node-shims.d.ts` to add `cwd(): string;` to the `process` declaration, otherwise the build will fail.

Update `package.json` and `scripts/package-release.sh` to include `config/default.json`.

### 2. Fix Stdin Pipeline (W0.2)

Modify `src/workerRuntime.ts` to pipe stdin if the resolved command provides it.

```typescript
// src/workerRuntime.ts (around line 339)
  const hasStdin = typeof resolved.stdin === "string";
  const child = spawn(resolved.spawnArgs[0], resolved.spawnArgs[1], {
    cwd,
    env: runtimeProcess.env,
    stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });

  if (hasStdin && child.stdin) {
    child.stdin.write(resolved.stdin);
    child.stdin.end();
  }
```

Modify `src/worker/assistantJobRunner.ts` to populate `stdin` instead of argv.

```typescript
// src/worker/assistantJobRunner.ts
export const runAssistantJob = (spec: AttemptSpec): TaskRunnerCommand => {
  const args: string[] = ["claude"];
  if (spec.permissions.allowAllTools) {
    args.push("--dangerously-skip-permissions");
  }
  args.push("--print");
  
  // Build the bounded prompt and pass it via stdin, NOT argv
  const boundedPrompt = [spec.prompt, ...spec.instructions].join("\n\n");
  
  return { command: args, stdin: boundedPrompt };
};
```

### 3. Fix `run_check` Execution (W0.3)

Modify `src/worker/checkRunner.ts` to respect `spec.execution.command` if provided.

```typescript
// src/worker/checkRunner.ts
export const runVerificationCheck = (spec: AttemptSpec): TaskRunnerCommand => {
  // If the host provided an explicit execution command, use it directly.
  if (spec.execution?.command && spec.execution.command.length > 0) {
    return { command: spec.execution.command };
  }

  // Fallback to legacy behavior: fold acceptance checks into bash -lc
  const commands = spec.acceptanceChecks
    .filter((check) => check.command && check.command.length > 0)
    .map((check) => check.command!.join(" "));

  if (commands.length === 0) {
    return { command: ["echo", "no acceptance checks defined"] };
  }

  return { command: ["bash", "-lc", commands.join(" && ")] };
};
```

### 4. Update Lifecycle Wording (W0.4)

Modify `src/host/sessionLifecycle.ts` to change "Task" to "Attempt" in terminal states.

```typescript
// src/host/sessionLifecycle.ts (around line 118)
  if (outcome.action === "terminal_fail") {
    stdoutWrite(`\n${red("Attempt Failed")}\n`);
    // ...
  } else if (outcome.action === "terminal_success") {
    stdoutWrite(`\n${green("Attempt Succeeded")}\n`);
    // ...
  }
```

## Test Strategy
- **Unit:** Ensure `pnpm test:unit` passes.
- **Integration:** Verify that installed `bakudo` (via `pnpm start`) resolves the default config correctly from outside the repo.

## Acceptance Criteria
- `bakudo` can be invoked from `/tmp` and successfully loads `config/default.json`.
- The worker successfully pipes stdin to the spawned child process.
- `run_check` attempts use `spec.execution.command` if provided.

## Rollback
If the config resolver breaks, revert `src/config.ts` to `readFile(path, "utf8")`. If the stdin pipeline hangs, ensure `child.stdin.end()` is being called.
