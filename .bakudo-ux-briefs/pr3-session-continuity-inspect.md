# PR3 — Session continuity, command registry, /inspect unification, dialog queue

You are an autonomous coding agent working in the bakudo repository. This brief is your complete spec.

## Working directory and branch

- Repo: `/home/al/git/bakudo-abox/bakudo/`
- Current branch: `feat/ux-phase1-pr3-session-continuity-inspect` (already created, stacked on PR2 commit `b9ae93f8`)
- Do NOT switch branches. Do NOT touch `abox/` or `plans/`.

## Goal

Land four interconnected pieces of Phase 1:

1. v2 session schema with backward-compatible v1 migration loader (Workstream 3)
2. Active-session continuity via `host-state.json` + `sessionController` (Workstreams 2/3)
3. Command registry with new commands and compatibility aliases, including the Standard/Plan/Autopilot mode rename (Workstream 6 + 2026-04-14 reference additions)
4. `/inspect` formatter unification + dialog-queue scaffolding + reducer-as-source-of-truth cleanup (Workstreams 5, 6.5, plus PR2 review fixes)

This is PR3 of 4 in Phase 1.

## Authoritative design

The internal structure for this PR was designed by a Plan subagent. **Read its design doc** — it covers: schema migration field-by-field, host-state shape, command registry shape, mode-rename strategy, dialog-queue callback architecture, `/inspect` formatter contract, reducer-as-source-of-truth refactor, test plan, and a 4-commit structure.

I'm reproducing the key resolved decisions inline below so you don't have to chase the design doc for everything, but the design doc's section numbers (§1 through §10) are the canonical reference for ambiguities.

## Resolved decisions (overrides where the design doc was open)

- **§4 mode rename**: Adopt **Option A**. `ComposerMode` becomes `"standard" | "plan" | "autopilot"`. Default initial mode: `"standard"`. The existing `composer.autoApprove: boolean` stays in state for compatibility but is read-only — derived from `composer.mode === "autopilot"`. Worker protocol (`TaskMode` in `protocol.ts`) keeps `"build" | "plan"` for now; translate at the boundary in `createTaskSpec` (`orchestration.ts`): `standard → build`, `autopilot → build`, `plan → plan`.
- **§7.7 schema field name**: Keep the field `schemaVersion` on `SessionRecord` (do NOT rename to `sessionSchemaVersion`). Change its type from `ProtocolSchemaVersion` to `number` and let value 1 (or absent) = v1, value 2 = v2. The session schema is logically independent from the worker protocol schema; the conflation in current code is a bug to fix.
- **§10.1 v1 `repoRoot`**: Use literal `"."` for migrated v1 sessions. Do not infer.
- **§10.3 `/compact`**: Stub. Register the command, handler emits `"compact: not yet available (Phase 2)"` as a transcript event, returns 0.
- **§10.5 `paths.ts` extraction**: Do NOT extract in PR3. The new `sessionController.ts` will reduce printers' need for `storageRootFor` naturally.
- **§10.8 SIGINT handler**: Branch on queue length. Non-empty queue: cancel front prompt. Empty: preserve today's `rl.close()` exit semantics.

## What this PR DOES (in commit order — see §9)

### Commit 1: `refactor(host): introduce v2 session schema and migration loader`

- Modify `src/sessionTypes.ts`:
  - Add v2 types: `SessionAttemptRecord`, `SessionTurnRecord`. Update `SessionRecord` to have `turns: SessionTurnRecord[]` AND keep `tasks?: SessionTaskRecord[]` deprecated for migration only.
  - Change `schemaVersion: ProtocolSchemaVersion` to `schemaVersion: number`.
  - Add new status enums: `TurnStatus = "queued" | "running" | "reviewing" | "completed" | "awaiting_user" | "failed"`. `AttemptStatus` reuses existing `TaskStatus`.
- Modify `src/sessionStore.ts`:
  - Replace existing `normalizeSessionRecord` with the dispatch loader: detect v2 (`schemaVersion === 2 && Array.isArray(turns)`), v1 (`Array.isArray(tasks) && typeof goal === "string"`), or throw.
  - Add private `migrateV1ToV2(raw)` doing the field-by-field mapping per design doc §1.4.
  - Add `upsertTurn(sessionId, turn): Promise<void>` and `upsertAttempt(sessionId, turnId, attempt): Promise<void>`. `upsertTask` becomes a deprecated shim that maps onto the new helpers (against turn 1).
- Modify `src/host/orchestration.ts`:
  - Switch from `upsertTask` to `upsertTurn`/`upsertAttempt`. Adjust `executeTask` and `runNewSession` to write turns and attempts.
  - Translate composer mode to worker `TaskMode` at the boundary.
- Modify `src/host/printers.ts`:
  - `latestTaskRecord(session)` becomes `latestAttempt(latestTurn(session))`. Update callers.
  - Field reads adapt to v2 shapes.
- Tests: `tests/unit/sessionMigration.test.ts` (8+ assertions, design doc §8).

### Commit 2: `feat(host): persist active session and introduce sessionController`

- Create `src/host/hostStateStore.ts`:
  - `HostStateRecord = { schemaVersion: 1; lastActiveSessionId?: string; lastActiveTurnId?: string; lastUsedMode: ComposerMode; autoApprove: boolean }`.
  - `loadHostState(repoRoot)`, `saveHostState(repoRoot, record)`, `hostStateFilePath(repoRoot)`. Atomic write via temp file + rename. Malformed JSON → null (no throw).
- Create `src/host/sessionController.ts`:
  - `appendTurnToActiveSession(sessionId, prompt, mode, args)` — load session, append turn, create first attempt at dispatch, run via `executeTask`, save.
  - `createAndRunFirstTurn(prompt, mode, args)` — mints session + first turn + first attempt.
  - `resumeNamedSession(sessionId, args)` — wraps existing resume.
- Modify `src/host/interactive.ts` and `interactiveRenderLoop.ts`:
  - On shell start: `loadHostState`. If `lastActiveSessionId` exists and the session loads cleanly, dispatch `set_active_session`. Restore `mode` and `autoApprove` via reducer.
  - Plain-text prompt routing: if `appState.activeSessionId` set, call `appendTurnToActiveSession`; otherwise `createAndRunFirstTurn`.
  - After each turn, `set_active_session` with the new session/turn IDs and `saveHostState`.
- Tests: `tests/unit/hostStateStore.test.ts`, `tests/unit/sessionController.test.ts`.

### Commit 3: `feat(host): introduce command registry, inspect formatter, and mode rename`

- Modify `src/host/appState.ts`:
  - Rename `ComposerMode` to `"standard" | "plan" | "autopilot"`.
  - Default initial mode: `"standard"`.
  - `autoApprove` becomes a derived getter or a frozen field always equal to `mode === "autopilot"`. Document this.
- Modify `src/host/reducer.ts`:
  - Update `set_mode` to accept the new union.
  - Add `cycle_mode` action (Shift+Tab semantics): `standard → plan → autopilot → standard`.
  - `set_auto_approve` becomes a no-op (still typed for backward compat — emit a notice if dispatched).
- Create `src/host/commandRegistry.ts`:
  - `HostCommandSpec` per design doc §3.1.
  - `registerCommand`, `getCommand`, `listCommands(ctx?)`, `dispatchCommand(line, ctx)`.
  - Throws on duplicate name or alias collision.
- Create `src/host/commands/` with one file per group:
  - `session.ts` — `/new`, `/resume`, `/sessions`
  - `inspect.ts` — `/inspect [tab]`
  - `composer.ts` — `/mode`, `/autopilot` (alias `/approve`), `/compact` (stub), `/clear`
  - `system.ts` — `/help` (contextual), `/exit` (alias `/quit`), `/init`
  - `legacy.ts` — `/run`, `/build`, `/plan`, `/status`, `/tasks`, `/review`, `/sandbox`, `/logs`
- Create `src/host/inspectFormatter.ts`:
  - Pure formatters returning `string[]`. Ordering contract per design doc §6.3.
  - `formatInspectSummary`, `formatInspectReview`, `formatInspectSandbox`, `formatInspectArtifacts`, `formatInspectLogs`.
- Modify `src/host/printers.ts`:
  - `printReview`, `printSandbox`, `printLogs` reduced to thin callers of `inspectFormatter`. No string template duplication.
- Modify `src/host/interactive.ts` and `interactiveRenderLoop.ts`:
  - `executePrompt` calls registry first; falls through to exec only when handler returns `InteractiveResolution`.
  - **Fix the duplicated prompt** (PR2 review feedback): `rl.question("")` instead of `rl.question(renderPrompt(shellState))`. The frame's `> ` is the only visible prompt. Header info moves into `frame.header` (already there, just needs to be populated from live `appState` + repo root).
  - **Fix `/resume` failure phrasing** (PR2 review feedback): `/resume` is now a dedicated registry handler, not an exec command. Its outcome strings are appropriate to resume (e.g., `"Resumed session 8ab1cd34."` or `"No saved session to resume."`).
- Tests: `tests/unit/commandRegistry.test.ts`, `tests/unit/inspectFormatter.test.ts`, `tests/unit/modeRename.test.ts`.

### Commit 4: `feat(host): dialog queue scaffolding and reducer-as-source-of-truth`

- Modify `src/host/appState.ts`:
  - Add `promptQueue: ReadonlyArray<{ id: string; kind: PromptKind; payload: unknown }>`.
  - Remove the old `overlay` discriminated union — overlay is now derived from `promptQueue[0]` in the selector.
- Modify `src/host/reducer.ts`:
  - Add `enqueue_prompt`, `dequeue_prompt`, `cancel_prompt` actions. Remove `open_overlay` / `close_overlay`.
- Modify `src/host/renderModel.ts`:
  - `selectRenderFrame` projects `overlay` from `promptQueue[0]`. `frame.mode = "transcript"` when queue non-empty.
- Modify `src/host/renderers/transcriptRenderer.ts` and `plainRenderer.ts`:
  - Render `frame.overlay` above the composer area. Trivial template; no styling beyond what existed.
- Implement the resume-confirm producer:
  - In the `/resume` handler in `src/host/commands/session.ts`: when active session exists AND requested session differs from current, enqueue a `resume_confirm` prompt; await user response via the resolver Map; proceed only on confirmation.
  - Maintain `Map<id, resolver>` outside reducer state (e.g., in a `promptResolvers.ts` module or attached to `interactiveRenderLoop`'s deps).
- Modify `src/host/interactive.ts`:
  - Install custom SIGINT handler. Branch: queue non-empty → `cancel_prompt` (and call resolver with cancelled sentinel); queue empty → `rl.close()` (preserves exit).
- **Reducer-as-source-of-truth cleanup**: Delete `syncComposerFromShell`. Delete the legacy `InteractiveShellState`. All composer reads come from `appState`.
- Tests: `tests/unit/dialogQueue.test.ts`.

## What this PR does NOT do (reserved for PR4 / later phases)

- No progress mapper / 16ms cadence (PR4)
- No preAction / memoize / try-finally / profileCheckpoint bootstrap (PR4)
- No README/help docs update (PR4)
- No internal routing of `bakudo plan|build|review|sandbox|logs` CLI commands through new model (PR4 — Workstream 8)
- No Zod runtime validation
- No new dependencies
- No keybindings parser/matcher/validator (Phase 5; PR3 only emits the reserved-shortcuts table somewhere — design doc didn't require this, **deferred to Phase 5**)
- No live `Shift+Tab` keybinding wiring beyond exposing `cycle_mode` reducer action — readline doesn't natively expose Shift+Tab without raw mode; defer to Phase 5 keybindings system
- No PTY golden tests (PR4 / Phase 6)
- No `inspectPane` split-view rendering (deferred — `/inspect` output goes into transcript as event lines for PR3)

## Quality gates (non-negotiable)

1. `cd /home/al/git/bakudo-abox/bakudo && mise run check` exits 0 after EACH commit. The 7 pre-existing `any` warnings in test files are baseline.
2. `mise exec -- pnpm test` passes after each commit. New tests pass.
3. No file > 400 lines.
4. NO new dependencies. `package.json` and `pnpm-lock.yaml` unchanged.
5. NO `--no-verify`, NO `--amend`, NO force-push.
6. Each of the 4 commits uses a conventional commit message starting with the prefix shown in the section header above. Add `Co-Authored-By: Claude Code <noreply@anthropic.com>` trailer to each.
7. The 4 commits MUST be separate (not squashed). Order: schema → persistence → registry+inspect+rename → dialog queue + cleanup.
8. `abox/` and `plans/` untouched.
9. `.bakudo/` (untracked runtime dir at repo root) NOT added to any commit.

## Working procedure

1. `cd /home/al/git/bakudo-abox/bakudo`. Verify branch is `feat/ux-phase1-pr3-session-continuity-inspect`.
2. Read end-to-end before starting:
   - `src/sessionTypes.ts`, `src/sessionStore.ts`, `src/protocol.ts`
   - `src/host/orchestration.ts`, `src/host/printers.ts`
   - `src/host/interactive.ts`, `src/host/interactiveRenderLoop.ts`
   - `src/host/appState.ts`, `src/host/reducer.ts`, `src/host/renderModel.ts`
3. Plan the schema migration in detail before writing code. Verify the v1→v2 mapping handles every `SessionTaskRecord` field.
4. Implement Commit 1. Run `mise run check` and `mise exec -- pnpm test`. Both must be green. Commit.
5. Implement Commit 2. Verify. Commit.
6. Implement Commit 3. Verify. Commit.
7. Implement Commit 4. Verify. Commit.
8. If any commit fails verification, root-cause it. NO `--no-verify`, NO `--amend`. If you discover the design doc has a wrong assumption, stop and report — don't push through.
9. After all 4 commits land, report.

## Final report

Return a structured report:
1. Files created / modified / deleted with line counts (per commit if helpful)
2. The 4 commit SHAs (`git log --oneline feat/ux-phase1-pr2-app-state-transcript..HEAD`)
3. `mise run check` exit code on the final commit + warning summary
4. Test pass count on the final commit (was 72/72 after PR2)
5. Any deviations from this brief, with justification
6. A short paragraph confirming the duplicated-prompt fix from PR2 actually works (test it manually if you can — `node ./dist/src/cli.js` non-interactively or with a piped command — and paste a short transcript)
7. Anything you flagged as ambiguous and how you resolved it

Begin now.
