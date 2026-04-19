# Control-Plane Implementation Progress

**Branch:** `manus/20260419-consolidated`
**Implements:** [`2026-04-19-bakudo-abox-control-plane-spec.md`](2026-04-19-bakudo-abox-control-plane-spec.md) per the [implementation plan](2026-04-19-bakudo-abox-control-plane-implementation-plan.md) and [review](2026-04-19-control-plane-review.md).

## Pinned decisions (from spec §"Questions to confirm before coding")

| Q | Decision |
| :--- | :--- |
| Q1: `inspect_repository` persistence | **Preserved + harvest + discard** |
| Q2: Default `assistant_job` backend | **`codex exec --dangerously-bypass-approvals-and-sandbox`** (the abox guest *is* the sandbox boundary). Backend is configurable; a `claude` profile may be added later. |
| Q3: Interactive merge behavior | **Auto-merge only in auto/noninteractive mode** for v1. Interactive standard mode preserves accepted candidates pending follow-up. |
| Q4: `run_explicit_command` mutation | **Ephemeral in v1**, surface mutation as a fact. |

## Constraints applied

- **No legacy preservation.** `WorkerTaskSpec`, `executeTask`, `BAKUDO_EPHEMERAL`, prose-only `assistant_job`, `request/result/metadata` legacy attempt fields, and any other deprecated codepaths are deleted, not deprecated.
- **Functional state updates** (per `AGENTS.md`).
- **Frequent commits + push** to `manus/20260419` so progress is reviewable.

## Wave checklist

- [x] **Wave 0** — installed config, stdin pipeline, `run_check` fix, lifecycle wording.
- [x] **Wave 1** — `DispatchPlan` + `ExecutionProfile`.
- [x] **Wave 2** — `assistant_job` backend-driven, reserved guest output dir.
- [x] **Wave 3** — split `aboxAdapter`, host lifecycle helpers, remove `BAKUDO_EPHEMERAL`.
- [x] **Wave 4** — worktree inspection, host-generated artifacts, profile-aware review, decoupled execute/review.
- [x] **Wave 5** — approval copy + lifecycle persistence + inspect surfaces.
- [x] **Wave 6** — mock live workflow harness + non-live coverage; **Wave 7** — batch/candidate seams.
- [x] **UX realignment** — candidate cards, lifecycle/merge chips, footer hints, `output` transcript kind, log v2 envelope renderer.
- [x] **Cleanup + docs + delivery report.**

## Per-wave notes

### 2026-04-19: Plan Set Delivered

The complete junior-engineer-proof implementation plan set has been written under [`control-plane/`](control-plane/). Highlights:

- **Master execution overview** ([`control-plane/00-execution-overview.md`](control-plane/00-execution-overview.md)): phasing strategy, parallelism opportunities, hand-off criteria, risk management.
- **8 wave detail plans** covering W0 through UX Realignment with code examples, file lists (delete/add/modify), test strategy, acceptance criteria, rollback.
- **Mermaid dependency graph** rendered to PNG showing the critical path.
- **Index README** ([`control-plane/README.md`](control-plane/README.md)) cross-linking everything with usage instructions.

### 2026-04-19: Wave 0.1 Landed

Configuration resolution fix has been committed and pushed:
- `src/config.ts`: `resolveDefaultConfigPath()` with install-root fallback
- `src/node-shims.d.ts`: `process.cwd()` declaration
- `package.json`: include `config/` in published files
- `scripts/package-release.sh`: copy `config/` into release bundle

Validated: `bakudo` invoked from `/tmp` successfully reads its config. Unit tests: 1398 pass / 0 fail.

### 2026-04-19: Wave 0.2 Landed

Worker stdin delivery is now wired through the runtime and assistant-job dispatch:
- `src/workerRuntime.ts`: when a resolved command includes stdin, spawn now uses piped stdin and writes/ends it deterministically.
- `src/worker/assistantJobRunner.ts`: bounded prompt now flows through `TaskRunnerCommand.stdin` instead of argv.
- `tests/unit/taskKindDispatch.test.ts`: assistant-job assertions now verify stdin payload semantics.
- `tests/unit/workerRuntime.test.ts`: added stdin piping regression coverage and relaxed stderr brittleness from local shell tooling noise.

Validated: `pnpm test:unit` passed (1399 pass / 0 fail / 1 skipped).

### 2026-04-19: Wave 0.3 Landed

`run_check` now compiles and runs through a single command contract shared by runner + review:
- `src/host/attemptCompiler.ts`: `run_check` emits derived command via `acceptanceChecks[0].command`.
- `src/worker/checkRunner.ts`: prefers `spec.execution.command` when explicitly provided, otherwise falls back to acceptance-check folding.
- `tests/unit/attemptCompiler.test.ts` and `tests/unit/taskKindDispatch.test.ts`: added/updated coverage for the new command source-of-truth behavior.

### 2026-04-19: Wave 0.4 Landed

Lifecycle wording no longer hardcodes an "ephemeral code-changing sandbox":
- Updated host-facing copy in `src/host/init.ts`, `src/host/oneShotRun.ts`, `src/host/sessionLifecycle.ts`, and `src/host/orchestrationSupport.ts` to use attempt/sandbox language aligned with current lifecycle behavior.

Validated: `pnpm test:unit` passed after W0.3+W0.4 changes.

### 2026-04-19: Wave 1 Landed

Introduced host-owned dispatch planning and threaded it through planner/execution persistence:
- `src/attemptProtocol.ts`: added `ExecutionProfile` + `DispatchPlan` types and Zod schemas.
- `src/host/planner.ts`: now emits `{ intent, plan, spec }` where `plan` contains candidate id, execution profile, and compiled spec.
- `src/host/sessionController.ts` + `src/host/executeAttempt.ts`: execution now accepts a `DispatchPlan` argument and persists `dispatchPlan` on attempts.
- `src/sessionTypes.ts`: `SessionAttemptRecord` now carries `dispatchPlan` (with `attemptSpec` retained as compatibility fallback).
- `src/host/inspectTabs.ts` + `src/host/inspectFormatter.ts`: provenance/inspect spec rendering now prefers `dispatchPlan.spec`.

Validated: `pnpm test:unit` passed (1401 pass / 0 fail / 1 skipped).

### 2026-04-19: Wave 2 Landed

`assistant_job` is now backend/profile-driven and reserves a stable guest output directory:
- `src/worker/taskKinds.ts`: task-kind runners now receive `ExecutionProfile` alongside `AttemptSpec`.
- `src/worker/assistantJobRunner.ts`: backend command is parsed from `profile.agentBackend`; bounded prompt is piped via stdin; runner exports `BAKUDO_GUEST_OUTPUT_DIR=/tmp/bakudo-artifacts`.
- `src/workerRuntime.ts`: task-kind resolution now loads `executionProfile` from worker payload with a safe default fallback profile.
- `src/aboxTaskRunner.ts` + `src/host/executeAttempt.ts`: host now threads `DispatchPlan.profile` into worker payload encoding.
- `tests/unit/taskKindDispatch.test.ts`: updated backend/dispatch assertions for profile-driven assistant-job commands.

Validated: `pnpm test:unit` passed (1401 pass / 0 fail / 1 skipped).

### 2026-04-19: Wave 3 In Progress (Slice A)

Started orchestration split with lifecycle foundations and env-decoupling:
- `src/host/sandboxLifecycle.ts`: added canonical task-id generation + ephemeral lifecycle helpers.
- `src/host/worktreeDiscovery.ts`: added `git worktree list --porcelain` parser + discovery helper.
- `src/host/mergeController.ts`: added explicit `abox merge` / `abox stop --clean` wrappers.
- `src/aboxAdapter.ts` + `src/aboxTaskRunner.ts`: removed env-coupled ephemeral control path and now pass explicit `{ taskId, ephemeral }` invocation options.
- Added unit coverage in `tests/unit/sandboxLifecycle.test.ts`, `tests/unit/worktreeDiscovery.test.ts`, and updated adapter expectations in `tests/unit/aboxAdapter.test.ts`.

Validated: `pnpm test:unit` passed (1406 pass / 0 fail / 1 skipped).

### 2026-04-19: Waves 3-7 + UX Completed

The remaining control-plane realignment landed across execution, review, persistence, UX, and integration coverage:

- `src/host/sessionRunSupport.ts` and `src/host/sessionLifecycle.ts` now route session start/resume through `executeAttempt` instead of the deprecated `executeTask` path.
- `src/host/orchestration.ts` has now been deleted; the remaining session-entry helpers live in `sessionRunSupport.ts` / `sessionLifecycle.ts`.
- `src/aboxAdapter.ts` is now a raw argv/spawn wrapper, `src/aboxTaskRunner.ts` dispatches direct `AttemptSpec` payloads, and `src/workerCli.ts` / `src/workerRuntime.ts` decode either `AttemptSpec` v3 or legacy `TaskRequest` v1 directly without the deprecated `WorkerTaskSpec` wrapper.
- `src/host/worktreeInspector.ts` and `src/host/hostArtifactGenerator.ts` inspect preserved worktrees, harvest reserved-output artifacts from `.bakudo/out/<attempt>`, and persist host-generated `patch.diff`, `changed-files.json`, and `merge-result.json`.
- `src/host/executeAttempt.ts`, `src/reviewer.ts`, and `src/sessionTypes.ts` now persist sandbox lifecycle state, review preserved candidates by actual worktree state, and auto-merge/discard preserved candidates when the execution profile requires it.
- `src/host/followUpActions.ts` now resolves preserved interactive candidates on host follow-up: accept merges + cleans up, halt discards, and the attempt lifecycle/status are updated durably.
- `src/host/orchestrationSupport.ts` now includes `sandboxLifecycleState` on `host.review_completed` envelopes so the event log carries the same lifecycle decision persisted on the attempt record.
- `src/host/inspectFormatter.ts`, `src/host/renderModel.ts`, `src/host/renderers/transcriptRenderer.ts`, `src/host/renderers/plainRenderer.ts`, `src/host/interactiveRenderLoop.ts`, and `src/host/printers.ts` now surface lifecycle/worktree details and render the host-owned `output` transcript/log shapes correctly.
- `src/attemptProtocol.ts` now carries `candidateId` / `batchId` seams plus `BatchSpec` / `CandidateSetResult` for future multi-candidate fan-out.
- `tests/helpers/mockAbox.sh` and `tests/integration/pipeline.test.ts` add preserved-worktree pipeline coverage without depending on a real abox VM boot.

Validated:

- `pnpm build`
- `node --loader ts-node/esm --test tests/unit/aboxAdapter.test.ts tests/integration/spawn-abox-path.test.ts tests/regression/F-04-path-preservation.test.ts tests/unit/aboxTaskRunnerNegotiation.test.ts tests/unit/aboxTaskRunnerEnvFilter.test.ts tests/unit/probeFailureEmitter.test.ts tests/unit/aboxTaskRunnerWorkerBundle.test.ts tests/unit/workerRuntime.test.ts tests/unit/executeAttempt.test.ts tests/harness.test.ts tests/unit/followUpActions.test.ts tests/unit/reviewer.test.ts tests/unit/taskKindDispatch.test.ts tests/unit/attemptProtocol.test.ts tests/unit/worktreeInspector.test.ts tests/unit/attemptCompiler.test.ts tests/unit/modeRename.test.ts tests/integration/eventLogPersistence.test.ts tests/regression/F-03-resume-attempt-spec.test.ts tests/unit/transcriptRenderer.test.ts tests/unit/renderModel.test.ts tests/unit/interactiveRenderLoop.test.ts tests/integration/plain-mode.test.ts tests/unit/nonInteractiveCompat.test.ts tests/integration/pipeline.test.ts`

### 2026-04-19: Consolidated Branch Created

Manus reviewed both parallel implementations (Claude Code `claude/manus-implementation-iX2Rh` and Codex `codex/begin-work-on-kickoff-prompt`) and produced the final consolidated branch `manus/20260419-consolidated`.

**Consolidation decisions:**

| Wave | Winner | Reason |
| :--- | :--- | :--- |
| W0 (Correctness) | **Codex** | Identical correctness; Codex's `WorkerDispatchInput` union type replaces `WorkerTaskSpec` entirely. |
| W1 (Data Model) | **Codex** | Both equivalent; Codex's `candidateId` is optional (correct for batch future), `reservedGuestOutputDirForAttempt` is a single source of truth in `attemptProtocol.ts`. |
| W2 (Worker Backend) | **Codex** | Uses `reservedGuestOutputDirForAttempt` from `attemptProtocol.ts` instead of hardcoding the path inline. Throws on empty `agentBackend` instead of silently returning `false`. |
| W3 (Orchestration) | **Codex** | `orchestration.ts` fully deleted. `mergeController.ts` uses factory pattern enabling DI for tests. `sandboxLifecycle.ts` has `isEphemeralSandbox` helper and `buildAboxShellCommandArgs`. |
| W4 (Review Decoupling) | **Codex** | `worktreeInspector.ts` uses `git status --porcelain` + recursive artifact discovery + separates `repoChangedFiles` from `outputArtifacts`. Claude used `git diff HEAD --name-only` which misses untracked files. |
| W5 (Persistence & UI) | **Codex** | Equivalent; Codex has `sessionRunSupport.ts` as a clean replacement for deleted `orchestration.ts` helpers. |
| W6/W7 (Harness/Batch) | **Codex** | More complete test harness; `harness.test.ts` added. |
| UX Realignment | **Codex** | Equivalent; both implement `output` transcript kind correctly. |
| Tests | **Codex** | 30 test files vs Claude's 17. Codex adds `mergeController.test.ts`, `worktreeInspector.test.ts`, `interactiveRenderLoop.test.ts`, `reviewer.test.ts`, `followUpActions.test.ts`, `attemptProtocol.test.ts`, and more. |

**Cherry-picked from Claude:** `sandboxBranchName` helper added to `sandboxLifecycle.ts` (useful utility absent from Codex).

**Quality gates passed:**
- `pnpm build` — zero errors
- `pnpm test:unit` — 1422 pass / 0 fail / 1 skipped
- `git grep BAKUDO_EPHEMERAL` in `src/` — nothing
- `git grep executeTask` in `src/` — nothing
- `git grep WorkerTaskSpec` in `src/` — nothing
