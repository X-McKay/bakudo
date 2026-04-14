# PR1 — Extract hostCli.ts into `src/host/*` modules

You are an autonomous coding agent running inside an abox sandbox VM. Your
working directory is `/workspace`, which is a git worktree of the bakudo
repository on branch `agent/<task-id>` forked from `main`.

This brief is your complete spec. Do not consult external sources unless
something here is genuinely contradictory.

## Goal

Refactor `src/hostCli.ts` (currently 1718 lines) into 6 smaller modules
under `src/host/*`. **This is a pure extraction — zero behavior change.**

Every existing test must continue to pass. `mise run check` must remain
green. The 5 public exports of `hostCli.ts` must still be exported from
`hostCli.ts` (re-exported from the new modules is fine).

## Why

`hostCli.ts` is a 1452-line god module that mixes ANSI rendering, command
parsing, session orchestration, inspect-surface printers, and the
interactive shell. Subsequent work (session continuity, transcript
renderer, semantic progress mapping) needs these concerns split apart so
each can be edited in isolation. PR1 sets that up without touching
behavior.

This is PR1 of 4 in Phase 1 of the bakudo UX overhaul. Future PRs will
replace the dashboard, add session continuity, and add a semantic
progress mapper. **Do not do any of that work in this PR.**

## Deliverable: 6 new modules under `src/host/`

Read `src/hostCli.ts` end-to-end first. Then create exactly these files:

### 1. `src/host/ansi.ts`

Pure rendering primitives, no I/O, no state.

Move:
- `ANSI` const map
- `supportsAnsi()` — note: this reads `process.stdout.isTTY` and
  `process.env.NO_COLOR`. Keep it self-contained — it can read those
  globals directly. Do not invent an injection layer.
- `paint`, `bold`, `dim`, `cyan`, `blue`, `green`, `yellow`, `red`,
  `gray` (note: `magenta` was deleted in a prior commit — do not
  reintroduce it)
- `ANSI_PATTERN`, `stripAnsi`, `displayWidth`, `fitDisplay`, `wrapPlain`
- `renderTitle`, `renderSection`, `renderKeyValue`, `renderCommandHint`,
  `renderModeChip`, `renderApprovalChip`
- `renderBox`, `mergeColumns`
- `overviewPanelLines`

Export everything that other modules need. Internal helpers like
`paint` should still be exported because every color helper uses it
(but the new modules will import from this one — they should not
re-implement).

### 2. `src/host/io.ts`

Stdout/stderr management and shared mutable state.

Move:
- `HostIo` type
- `TextWriter` type
- `runtimeIo`, `runtimeProcess` module-level constants (lines ~104–110
  of current hostCli.ts)
- `activeStdoutWriter` mutable variable plus `baseStdout`, `stdoutWrite`,
  `stderrWrite`, `withCapturedStdout`

Export the functions and types. Keep the mutable state private to this
module (do not export `activeStdoutWriter` directly — provide the
existing `withCapturedStdout` helper as the only mutator).

### 3. `src/host/parsing.ts`

CLI argument and command-string parsing.

Move:
- `HostCommand` type
- `HostCliArgs` type (this is currently exported from hostCli.ts —
  re-export from there for backward compatibility, see §"Public
  surface" below)
- `HOST_COMMANDS`, `RUN_COMMANDS`, `SESSION_REQUIRED_COMMANDS` sets
- `SlashCommandSpec` type and `INTERACTIVE_COMMANDS` array
- `parsePositiveInteger`, `readLongFlag`
- `parseHostArgs` (currently exported)
- `shouldUseHostCli` (currently exported)
- `tokenizeCommand`
- `buildUsageLines`, `printUsage`

`parseHostArgs` and `shouldUseHostCli` are part of the public surface —
they must be re-exported from `hostCli.ts` so external callers
(`src/cli.ts`, `tests/unit/hostCli.test.ts`) keep working without
changes.

### 4. `src/host/printers.ts`

Inspect-surface command printers (status, sandbox, review, logs, etc.).
Read-only; no session mutation.

Move:
- `statusBadge`, `formatUtcTimestamp`, `nextActionHint`, `formatArtifacts`,
  `taskModeLabel`, `latestTaskRecord`
- `printRunSummary`
- `printTasks`, `printSessions`, `printStatus`
- `printSandbox`, `printReview`, `printLogs`
- `reviewedOutcomeExitCode` (currently exported from hostCli.ts — must
  be re-exported)

### 5. `src/host/orchestration.ts`

Session/task lifecycle: create, dispatch, resume, init.

Move:
- `storageRootFor`, `repoRootFor`, `buildAgentsTemplate`
- `sessionStatusFromReview`, `requiresSandboxApproval`
- `promptForApproval`
- `createTaskSpec`, `recordTask`, `writeSessionArtifact`
- `executeTask`
- `runNewSession`, `resumeSession`
- `runInit`

### 6. `src/host/interactive.ts`

The interactive REPL shell, dashboard, and dispatch routing.

Move:
- `InteractiveShellState` type
- `InteractiveResolution` type
- `InteractiveDashboard` class
- `createDashboardCapture`
- `createInteractiveSessionIdentity`
- `buildInteractiveRunResolution`
- `resolveSessionScopedInteractiveCommand`
- `resolveInteractiveInput`
- `rememberInteractiveContext`
- `sessionPromptLabel`
- `renderPrompt`
- `dispatchHostCommand`
- `runInteractiveShell`

## What stays in `hostCli.ts`

After extraction, `src/hostCli.ts` should be a thin entry point with:
- The shebang line
- Imports from `./host/*`
- Re-exports of the 5 public bindings (`HostCliArgs`, `parseHostArgs`,
  `shouldUseHostCli`, `reviewedOutcomeExitCode`, `runHostCli`)
- The `runHostCli` function itself (it's small — 18 lines or so. It can
  live here and call into `dispatchHostCommand` / `runInteractiveShell`
  from the interactive module.)
- The `if (isMainModule(...))` bootstrap at the bottom

Target line count for `hostCli.ts` after extraction: under 80 lines,
ideally 40–60.

## Public surface — must be preserved exactly

These 5 bindings must be importable from `./hostCli.js` after extraction:

1. `HostCliArgs` (type)
2. `parseHostArgs` (function)
3. `shouldUseHostCli` (function)
4. `reviewedOutcomeExitCode` (function)
5. `runHostCli` (function)

They are imported by:
- `src/cli.ts` (uses `runHostCli`, `shouldUseHostCli`)
- `tests/unit/hostCli.test.ts` (uses all 5)

Do not change the import paths in those caller files — re-export from
`hostCli.ts`.

## File-size constraint

No new file may exceed 400 lines. If `interactive.ts` or
`orchestration.ts` would exceed 400 lines after extraction, split them
along an obvious seam (e.g., move `InteractiveDashboard` into
`interactive/dashboard.ts`). Document each split in the commit message.

## Working procedure

1. `cd /workspace`
2. Read `src/hostCli.ts` and `tests/unit/hostCli.test.ts` end-to-end
   before making any edits.
3. Plan your extraction. Verify your file-by-file mapping against the
   six sections above.
4. Create the new files one at a time. For each:
   - Move the relevant bindings.
   - Add necessary imports.
   - Run `mise exec -- pnpm build` to verify TypeScript compiles.
   - Do not commit yet.
5. Trim `hostCli.ts` to its thin entry-point form. Verify build still
   compiles.
6. Run `mise run check` (lint + build + tests). All must pass.
7. Run `mise exec -- pnpm test` explicitly to be sure tests pass.
8. If anything fails, investigate root cause. Do not skip checks. Do
   not use `--no-verify`. Do not use `git commit --amend`.
9. Stage and commit with this message:

   ```
   refactor(host): split hostCli.ts into focused modules under src/host/

   Extracts hostCli.ts (1718 lines) into ansi, io, parsing, printers,
   orchestration, and interactive modules under src/host/. Pure
   extraction — zero behavior change. All five public exports
   (HostCliArgs, parseHostArgs, shouldUseHostCli, reviewedOutcomeExitCode,
   runHostCli) are preserved and re-exported from hostCli.ts. PR1 of 4
   in Phase 1 of the bakudo UX overhaul.
   ```

   Add a `Co-Authored-By: Claude Code <noreply@anthropic.com>` trailer.

10. Print a final report: file list with line counts, test results,
    `mise run check` exit code, and any deviations from this brief
    (with justification).

## Anti-goals — DO NOT do any of these

- Do not change any user-visible behavior. The dashboard, prompts,
  output formatting, exit codes, and session storage paths must be
  byte-for-byte identical to before.
- Do not introduce new dependencies (no `chalk`, no `commander`, no
  `ink`).
- Do not refactor logic — moving code is fine; rewriting it is not.
- Do not invent new abstractions ("renderer interface", "command
  registry class") in this PR. That work is reserved for PR2.
- Do not add docstrings or comments to the moved code. Keep it
  identical.
- Do not delete the brief file at `.bakudo-ux-briefs/pr1-extract-hostcli.md`.
- Do not touch anything under `abox/` or in any path outside
  `/workspace/`.

## Definition of done

- 6 new files exist under `src/host/`.
- `hostCli.ts` is < 80 lines and is a thin entry point.
- All 5 public exports are still importable from `./hostCli.js`.
- `mise run check` exits 0.
- `mise exec -- pnpm test` passes (all existing tests pass without
  modification).
- One commit with the message above is on the current branch.
- Final report printed to stdout.

Begin now.
