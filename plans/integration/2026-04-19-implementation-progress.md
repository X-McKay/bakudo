# Control-Plane Implementation Progress

**Branch:** `manus/20260419`
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
- [ ] **Wave 3** — split `aboxAdapter`, host lifecycle helpers, remove `BAKUDO_EPHEMERAL`.
- [ ] **Wave 4** — worktree inspection, host-generated artifacts, profile-aware review, decoupled execute/review.
- [ ] **Wave 5** — approval copy + lifecycle persistence + inspect surfaces.
- [ ] **Wave 6** — live workflow harness + non-live coverage; **Wave 7** — batch/candidate seams.
- [ ] **UX realignment** — candidate cards, lifecycle/merge chips, footer hints, `output` transcript kind, log v2 envelope renderer.
- [ ] **Cleanup + docs + delivery report.**

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
