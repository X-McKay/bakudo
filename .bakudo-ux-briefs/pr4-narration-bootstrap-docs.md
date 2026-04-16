# PR4 — Progress mapper, bootstrap (preAction), PR3 cleanup, docs

You are an autonomous coding agent working in the bakudo repository. This brief is your complete spec.

## Working directory and branch

- Repo: `/home/al/git/bakudo-abox/bakudo/`
- Current branch: `feat/ux-phase1-pr4-narration-bootstrap-docs` (already created, stacked on PR3 commit `9992fb6`)
- Do NOT switch branches. Do NOT touch `abox/` or `plans/`.

## Goal

Finish Phase 1 with four concerns:

1. **Semantic progress narration**: map low-level worker events to assistant-grade transcript lines (Workstream 7).
2. **Bootstrap discipline**: preAction ordering, `memoize`, try-finally disposal, startup profiling (from 2026-04-15 second-pass additions).
3. **PR3 cleanup**: 10 follow-up items identified by the PR3 reviewer — small to medium grooming, all well-understood.
4. **Docs and tests**: README, AGENTS.md template, `/help`, and required test coverage.

This is PR4 of 4 in Phase 1.

## Commit structure

Four commits, each green by `mise run check`. Do NOT squash.

### Commit 1: `feat(host): add semantic progress mapper with 16ms coalescing`

Workstream 7 scope. Plus 2026-04-14 reference additions for streaming cadence.

Create `src/host/progressMapper.ts`:

```ts
export type ProgressStage =
  | "queued"
  | "started"
  | "running_output"
  | "timed_out"
  | "completed"
  | "failed";

export type ProgressMapping = {
  stage: ProgressStage;
  line?: string;       // transcript line to emit (absent = no emit)
  tone?: "info" | "success" | "warning" | "error";
};

export const mapWorkerEventToNarration = (
  event: WorkerTaskProgressEvent,
  lastStage?: ProgressStage,
): ProgressMapping => { ... };
```

Rules (phase doc lines 824–887):
- `task.queued` → stage `"queued"`, line `"Queued sandbox attempt."`, tone `"info"`
- `task.started` → stage `"started"`, line `"Sandbox worker started."`, tone `"info"`
- `task.progress` with `timedOut` → stage `"timed_out"`, line `"Worker hit its timeout and is being stopped."`, tone `"warning"`
- `task.progress` (running) → stage `"running_output"`, line `"Worker is producing output."` only if `lastStage !== "running_output"`. Coalescence: repeat events at the same stage produce NO transcript line.
- `task.completed` → stage `"completed"`, line `"Worker completed. Reviewing result."`, tone `"info"`
- `task.failed` → stage `"failed"`, line `"Worker failed. Reviewing result."`, tone `"error"`

Create `src/host/progressCoalescer.ts`:
- Maintains the 16ms timer-tick boundary (2026-04-14 reference addition). Events arriving within the same tick collapse to the latest per-stage emission.
- Export `createProgressCoalescer(emit: (line: TranscriptItem) => void): (event: WorkerTaskProgressEvent) => void`.
- Internally uses `setTimeout(..., 16)` to flush; on flush, emit the latest mapping per stage.
- Escalation rule (phase doc lines 880–887): if stage escalates to `"timed_out"` or `"failed"`, flush immediately without waiting for the 16ms boundary.

Wire into `src/host/interactiveRenderLoop.ts`'s `executePrompt`:
- Replace the current ad-hoc `"Dispatching sandbox attempt."` / `"Worker completed."` / `"Worker completed with errors."` transcript items with the coalescer's emissions.
- Raw low-level event lines (byte counters, `task.progress` raw bytes) MUST NOT appear in the main transcript. Those belong in the log surface.
- Tests: `tests/unit/progressMapper.test.ts` (stage table + coalescence rule + escalation).

### Commit 2: `feat(host): preAction bootstrap with memoization and disposal`

From the 2026-04-15 second-pass additions:

Create `src/host/bootstrap.ts`:

```ts
const memoize = <T>(fn: () => Promise<T>): (() => Promise<T>) => { ... };

export const initHost = memoize(async (): Promise<HostBootstrap> => {
  profileCheckpoint("preaction_entry");
  // 1. Load config (host-state.json) — no agent config yet; Phase 2 adds that.
  // 2. Apply safe env (NO_COLOR, BAKUDO_LOG_LEVEL placeholder).
  // 3. Register graceful-shutdown handlers (SIGINT, SIGTERM, uncaughtException).
  // 4. Async prefetch: sessions index (if exists), abox capabilities stub (Phase 6 replaces).
  // 5. Defer heavy work until a real subcommand runs.
  profileCheckpoint("preaction_done");
  return { ... };
});

export const withBootstrap = async <T>(fn: (b: HostBootstrap) => Promise<T>): Promise<T> => {
  const boot = await initHost();
  try { return await fn(boot); }
  finally { await disposeHost(boot); }
};
```

Create `src/host/startupProfiler.ts`:

```ts
export const profileCheckpoint = (name: string): void => { ... };
export const profileReport = (): void => { ... };
```

- Records `{ name, ms }` relative to process start (`performance.now()` at module load).
- `profileReport()` writes to `.bakudo/log/startup-<pid>-<iso>.json` if `BAKUDO_PROFILE=1` set (env-gated; default off).
- If the `.bakudo/log/` directory doesn't exist, create it silently.
- Non-fatal: any write error is swallowed (logging should never crash the shell).

Wire into `src/hostCli.ts`'s `runHostCli`:
- Fast-path: `args.help` prints usage and returns before any bootstrap. Target: return in <50ms.
- Otherwise: call `withBootstrap(...)`.

Do NOT add any new dependencies. `performance.now()` is available on the Node globals; access via `globalThis.performance` if the existing `node-shims.d.ts` doesn't declare it.

Tests:
- `tests/unit/bootstrap.test.ts` (memoize returns same promise across concurrent callers; disposal runs once even on error).
- `tests/unit/startupProfiler.test.ts` (checkpoints recorded; profileReport env-gated; missing dir handled).

### Commit 3: `refactor(host): PR3 cleanup and inspect ordering fixes`

Apply the reviewer's grooming list verbatim:

1. **Delete `handleControlCommand`** in `src/host/interactiveRenderLoop.ts` (lines 128–167 range). It's superseded by the registry. If the `dispatched.kind === "unknown"` branch needs fallback behavior, push a notice instead. Verify no tests depend on it.
2. **Plumb `/exit` and `/quit` through the registry**. Delete the short-circuit in `src/host/interactive.ts:282-284`. The registry's `system.ts` `/exit` handler should return a sentinel (e.g. a numeric exit code paired with a "shell should terminate" marker, OR a dedicated discriminated-union resolution type). Recommendation: add a new `InteractiveResolution` variant `{ kind: "exit"; code: number }` and have the shell loop recognize it.
3. **Thread `repoLabel` into `tickRender`**. Pass the short repo basename (e.g. `basename(repoRootFor(undefined))`) into `selectRenderFrame` via the `repoLabel` field. Today the header's repo slot is empty.
4. **Fix `formatInspectSummary` ordering** (`src/host/inspectFormatter.ts:34-59`). Reorder to match the brief's priority: Session → Repo → Goal → Outcome/Action → Attempt/Sandbox → State/Updated/Turns. Add a test in `inspectFormatter.test.ts` asserting this ordering.
5. **Fix `printReview` Artifacts duplication** (`src/host/printers.ts:286-288`). Either remove the extra `Artifacts:` push or prune the formatter's Dispatch/Worker lines when rendered through the CLI. Prefer removing the extra push since the formatter already includes artifact paths.
6. **Remove stale `INTERACTIVE_COMMANDS`** table (`src/host/parsing.ts:64-96`). Regenerate from the registry if any caller still needs the list, or just delete if no callers remain. `/help` uses the registry directly.
7. **Remove/deprecate `renderPrompt`** in `src/host/interactiveResolvers.ts:121-126`. It's no longer consumed (`rl.question("")` everywhere).
8. **Add inspect ordering invariant test**. In `tests/unit/inspectFormatter.test.ts`, assert that `formatInspectReview(...)` output has `indexOf("Outcome")` < any raw-log-line index. Explicit regression guard.
9. **Use `CURRENT_SESSION_SCHEMA_VERSION`** in `src/sessionStore.ts:177` dispatch check (replace hardcoded `2`).
10. **Expand migration test coverage** in `tests/unit/sessionMigration.test.ts`:
    - All 6 `TaskStatus` values remap correctly to `TurnStatus` and `AttemptStatus`.
    - `metadata.sandboxTaskId` survives v1→v2.
    - Round-trip: write v1 file to temp dir, `SessionStore.loadSession`, save, reload, assert `schemaVersion === 2` and content equivalence (turns length, prompt, attempts count).

Do NOT address the pre-existing `src/workerRuntime.ts` at 420 lines — it's outside Phase 1 scope. Leave as-is.

### Commit 4: `feat(host): non-interactive CLI compatibility routing through session model`

Workstream 8 (phase doc lines 888–922). The existing `bakudo plan "..."`, `bakudo build "..."`, `bakudo review ...`, `bakudo sandbox ...`, `bakudo logs ...` top-level commands must keep working but internally route through the new v2 session/turn model.

- `bakudo plan "goal"` and `bakudo build "goal"` should go through `sessionController.createAndRunFirstTurn` (or `appendTurnToActiveSession` if a persisted active session exists — TBD: for non-interactive one-shots, PREFER `createAndRunFirstTurn` and do NOT persist an active session). Mode is derived from the CLI flag (`build → standard`, `plan → plan`; the CLI's `--mode` flag keeps `build|plan` tokens for backward compat; `standard` is the new name but old scripts use `build`).
- `bakudo review <session>`, `bakudo sandbox <session>`, `bakudo logs <session>` go through `inspectFormatter` (which Commit 3's cleanup already wired). These should target the latest turn unless a turn/attempt is specified (phase doc line 915).
- Copilot-parity flag namespace reservation (2026-04-14 reference additions): `-p/--prompt`, `--stream=off`, `--plain-diff`, `--output-format=json`, `--allow-all-tools`, `--no-ask-user`. For PR4, ONLY add the flag parsers in `parsing.ts` (so they're recognized). Full semantics land in Phase 5. The flags should NOT error out when passed; at minimum they set a field on `HostCliArgs` that's not yet consumed. Document this in the commit message.

Tests:
- `tests/unit/nonInteractiveCompat.test.ts` — asserts `bakudo plan "goal"` creates a v2 session and exits cleanly; `bakudo review <id>` outputs expected content. Use in-process `runHostCli` calls with `withCapturedStdout`; no subprocesses.

### Commit 5: `docs(host): Phase 1 README, AGENTS.md, /help updates`

Phase doc lines 1163–1176.

Update `README.md`:
- New transcript-first shell examples (copy from the phase doc's example transcripts at lines 527–540, 566–597).
- Document `/new`, `/resume`, `/inspect`, `/mode`, `/autopilot`, `/compact`, `/help`, `/exit`, `/sessions`.
- Explain that plain text continues the active session.
- Document that provenance/logs are available via `/inspect logs` and the legacy aliases are still present.

Update `buildAgentsTemplate` in `src/host/init.ts`:
- Reflect the new command set.
- Keep it under 40 lines of template content.

Update `/help` output in `src/host/commands/system.ts`:
- Already contextual per PR3. Verify it matches the required ordering from phase doc lines 788–797: prompt usage, /new, /resume, /inspect, /mode, /autopilot (formerly /approve), compat aliases, /exit.
- If it doesn't match, fix.

No tests required for this commit beyond the documentation snapshot test if one exists.

## What PR4 does NOT do

- **No PTY golden tests** (phase doc line 1142). PTY testing is notoriously fragile in CI. The phase doc's "Manual Verification Checklist" (lines 1374–1386) covers the TTY behavior. Defer PTY golden tests to Phase 6 (per phase 6 doc Workstream 10 — "Formalize PTY And Golden Test Maintenance").
- **No Zod runtime validation**. Deferred to Phase 2 when the config cascade and permission rules land.
- **No abox capability probe**. The bootstrap's abox probe is a stub; Phase 6 Workstream 3 implements the real probe.
- **No live `Shift+Tab` binding**. Readline doesn't natively expose Shift+Tab without raw mode; defer to Phase 5 keybindings.
- **No config cascade** (`.bakudo/config.json`, `~/.config/bakudo/config.json`, etc). That's Phase 2.
- **No progress rendering in the inspect pane**. `/inspect logs` uses whatever the current raw-log emission path produces; PR4 does not reformat logs.

## Quality gates (non-negotiable)

1. `cd /home/al/git/bakudo-abox/bakudo && mise run check` exits 0 after each commit. The 7 baseline warnings may persist; no NEW warnings.
2. `mise exec -- pnpm test` passes each commit. The PR3 ending was 118/118; PR4 should end at least that many, ideally +15 to +25 new tests.
3. No file > 400 lines EXCEPT pre-existing `workerRuntime.ts`. PR4 files that approach 400 should be split.
4. NO new dependencies. `package.json` and `pnpm-lock.yaml` unchanged.
5. NO `--no-verify`, NO `--amend`, NO force-push.
6. Conventional commits with the prefixes above. Each carries `Co-Authored-By: Claude Code <noreply@anthropic.com>` trailer.
7. 5 commits MUST be separate in the listed order.
8. `abox/` and `plans/` untouched.
9. `.bakudo/` at repo root NOT added to any commit.

## Working procedure

1. `cd /home/al/git/bakudo-abox/bakudo`. Verify branch.
2. Read in full before starting:
   - `src/host/interactiveRenderLoop.ts` (the wiring target for progress narration)
   - `src/host/aboxTaskRunner.ts` and `src/aboxTaskRunner.ts` (wherever the existing event loop lives — check both paths)
   - `src/protocol.ts` (for `WorkerTaskProgressEvent` shape)
   - `src/hostCli.ts` (the fast-help path)
   - `src/host/parsing.ts` (for flag additions)
   - `src/host/printers.ts` (for commit 3 cleanup)
   - `src/host/inspectFormatter.ts` (for commit 3 cleanup)
   - `src/host/init.ts`, `src/host/commands/system.ts` (for docs updates)
   - `README.md` (for commit 5)
3. Implement Commit 1 (progress mapper). Verify. Commit.
4. Implement Commit 2 (bootstrap). Verify. Commit.
5. Implement Commit 3 (cleanup). Verify. Commit.
6. Implement Commit 4 (non-interactive compat). Verify. Commit.
7. Implement Commit 5 (docs). Verify. Commit.
8. If any commit fails verification, root-cause it. No `--no-verify`, no `--amend`.

## Final report

Return a structured report:
1. Files created/modified/deleted per commit with line counts
2. 5 commit SHAs (`git log --oneline 9992fb6..HEAD`)
3. `mise run check` exit code and warning summary on HEAD
4. Test pass count (was 118/118 after PR3)
5. Any deviations from brief with justification
6. Short manual-verification notes for each of the 8 items in the phase doc's Manual Verification Checklist (lines 1374–1386). You may mark items as "cannot test without interactive TTY" — call out which ones.
7. List of the PR3 follow-up items addressed (should be 1-10 from Commit 3) with a short confirmation each.

Begin now.
