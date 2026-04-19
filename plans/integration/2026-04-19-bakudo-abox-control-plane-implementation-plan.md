# bakudo ↔ abox control-plane alignment — implementation plan

**Status:** proposed
**Date:** 2026-04-19
**Implements:** `2026-04-19-bakudo-abox-control-plane-spec.md`
**Scope:** bakudo-only unless a small abox interface gap appears during implementation

---

## Goal

Deliver the bakudo-side correction in a sequence that restores end-to-end correctness first, then grows automation and future orchestration hooks:

1. correct the single-worker lifecycle,
2. make preserved-worktree review real,
3. restore installed/runtime correctness,
4. build a reusable live workflow harness,
5. leave clean seams for later parallel-worker compare.

---

## Guiding constraints

- Follow the existing architectural direction; do not redesign abox.
- Keep `AttemptSpec` worker-facing and introduce host-owned control-plane state separately.
- Use functional host state updaters for any `src/host/**` mutation paths.
- Prefer host-generated artifacts for merge candidates.
- Preserve failed code-changing candidates instead of discarding useful evidence.
- Keep tests contract-focused.

---

## Wave order

### Wave 0 — prerequisites and correctness blockers

Fix the issues that would make later preserved-worktree work unreliable or misleading.

### W0.1. Ship a real installed default config

Files:

- `package.json`
- `scripts/package-release.sh`
- `scripts/postbuild.mjs` if needed
- install smoke coverage

Work:

- ship `config/default.json` in the published bundle,
- make installed `bakudo` resolve its default config relative to the install root rather than the caller cwd,
- keep `--config` override behavior intact.

Tests:

- release bundle contains `config/default.json`,
- installed/default-config resolution works outside the repo checkout,
- explicit `--config` still wins.

### W0.2. Make worker stdin real

Files:

- `src/workerRuntime.ts`
- `src/worker/taskKinds.ts`
- unit tests for stdin-delivery

Work:

- write `TaskRunnerCommand.stdin` to the spawned child when present,
- ensure timeouts, output capture, and close handling still behave correctly.

Tests:

- unit test with a command that reads stdin and echoes it,
- regression test ensuring large prompts do not require argv-only delivery.

### W0.3. Fix the `run_check` execution path

Files:

- `src/host/attemptCompiler.ts`
- `src/worker/checkRunner.ts`
- compiler/dispatch tests

Work:

- make `run_check` compile runnable commands into the shape the verification runner actually consumes,
- decide one source of truth:
  - either populate `acceptanceChecks[].command`,
  - or make `verification_check` honor `execution.command`.

Recommendation:

- use `acceptanceChecks[].command` so the review layer and runner share the same command contract.

Tests:

- `planAttempt("run tests")` yields a runnable check command,
- the runner executes the intended command,
- the check result is persisted and surfaced.

### W0.4. Stop hardcoding "ephemeral code-changing" in host messaging

Files:

- `src/host/init.ts`
- `src/host/oneShotRun.ts`
- `src/host/sessionLifecycle.ts`
- `src/host/orchestrationSupport.ts`
- help tests that currently pin `--ephemeral` copy

Work:

- update messaging so it describes lifecycle truthfully,
- keep changes behavioral/truthful rather than polishing wording for its own sake.

---

### Wave 1 — introduce host-owned `DispatchPlan`

Create the control-plane object that bakudo is currently missing.

### W1.1. Add `DispatchPlan` and `ExecutionProfile`

Suggested files:

- new `src/host/dispatchPlan.ts`
- `src/host/planner.ts`
- `src/host/attemptCompiler.ts`
- `src/sessionTypes.ts`
- session persistence/migration tests

Work:

- define `DispatchPlan`,
- define the initial execution profiles,
- make `planAttempt()` return `{ intent, spec, dispatchPlan }`,
- persist the dispatch plan on `SessionAttemptRecord`.

Important choice:

- keep `attemptSpec` as the worker-facing payload,
- do not bury host lifecycle state inside worker-only codepaths.

Tests:

- planner tests assert correct profile mapping per intent kind,
- persisted session attempts retain the dispatch plan,
- tolerant load/migration for older sessions still works.

### W1.2. Route session controller and one-shot flows through `DispatchPlan`

Files:

- `src/host/sessionController.ts`
- `src/host/oneShotRun.ts`
- `src/host/orchestration.ts` if needed

Work:

- stop passing only `AttemptSpec` through the host execution path,
- make `executeAttempt` or its replacement accept the full host plan.

Tests:

- current single-turn and append-turn flows still persist the correct attempt IDs and reviews,
- no direct host state mutation is introduced.

---

### Wave 2 — repair `assistant_job`

Replace the current prose-only runner with a real noninteractive agent execution contract.

### W2.1. Make `assistant_job` backend-driven

Files:

- `src/host/attemptCompiler.ts`
- `src/worker/assistantJobRunner.ts`
- config surface if a backend/profile setting is added
- unit tests

Work:

- populate `AttemptSpec.execution.command` for `assistant_job`,
- stop hardcoding `claude --print`,
- make the runner use the command from the spec,
- choose a first verified backend profile.

Recommendation:

- initial default: `codex exec --full-auto`

Tests:

- compiler test for `implement_change` and `inspect_repository` includes the expected agent backend command,
- runner test verifies the prompt is delivered via stdin or argv as designed,
- no regression to `explicit_command` or `verification_check`.

### W2.2. Reserve `.bakudo/out/<attemptId>/`

Files:

- `src/host/attemptCompiler.ts`
- `src/worker/assistantJobRunner.ts`
- maybe new helper `src/host/outputPaths.ts`

Work:

- derive a deterministic guest output path per attempt,
- include instructions telling the agent when to write report artifacts there,
- keep the reserved path host-owned and predictable.

Tests:

- output path derivation is stable,
- inspect-profile prompts mention the report path,
- implement-change prompts distinguish repo changes from report output.

---

### Wave 3 — preserved sandbox orchestration

This is the core bakudo-side alignment with abox.

### W3.1. Split abox adapter responsibilities

Files:

- `src/aboxAdapter.ts`
- new helper(s) if needed, such as:
  - `src/host/sandboxLifecycle.ts`
  - `src/host/worktreeDiscovery.ts`

Work:

- stop treating `ABoxAdapter` as "only `run` with an env var deciding ephemeral",
- add explicit host calls for:
  - run preserved sandbox,
  - run ephemeral sandbox,
  - merge sandbox,
  - clean/discard sandbox,
  - optionally list/inspect sandbox status if useful.

Also:

- stop using `BAKUDO_EPHEMERAL` as the primary control-plane switch,
- derive persistence from the execution profile instead.

Tests:

- adapter tests for preserved vs ephemeral argv,
- merge/discard command construction tests,
- installed `abox` path and explicit `--abox-bin` coverage remains intact.

### W3.2. Discover preserved worktrees on the host

Files:

- new `src/host/worktreeDiscovery.ts`
- `src/host/executeAttempt.ts` or replacement
- persistence/review tests

Work:

- after preserved runs, discover the actual worktree path using host git state,
- persist sandbox ID, branch, and worktree path durably.

Tests:

- unit tests with mocked `git worktree list --porcelain`,
- integration test against a real preserved sandbox when live mode is enabled.

### W3.3. Harvest, merge, discard

Files:

- new `src/host/mergeController.ts` or similar
- `src/host/executeAttempt.ts`
- `src/host/sessionArtifactWriter.ts`
- review/inspect rendering files as needed

Work:

- for `inspect_repository`: harvest artifacts from `.bakudo/out/<attemptId>/`, then discard,
- for `implement_change` in auto mode: inspect, verify, merge, then clean,
- for failed/uncertain `implement_change`: preserve candidate and mark it pending host action.

Tests:

- merge success path updates host repo and cleans the candidate,
- discard path removes the candidate,
- failed merge or failed review preserves candidate state and surfaces it clearly.

---

### Wave 4 — worktree-aware review

Make review depend on actual candidate state.

### W4.1. Add host worktree inspection

Suggested files:

- new `src/host/worktreeInspector.ts`
- `src/reviewer.ts`
- `src/host/sessionArtifactWriter.ts`
- review unit tests

Work:

- collect changed files, diff size, dirty state, reserved-output-path contents,
- produce host-generated artifacts such as `patch.diff` and `changed-files.json`,
- feed inspection output into review.

Tests:

- success with no mutation is rejected for `implement_change`,
- repo mutation is rejected for `inspect_repository`,
- host-generated diff artifact matches the preserved candidate.

### W4.2. Separate execution success from merge success

Files:

- `src/reviewer.ts`
- `src/sessionTypes.ts`
- result classification tests

Work:

- distinguish:
  - worker execution succeeded,
  - candidate review accepted,
  - merge succeeded,
  - candidate preserved pending user decision.

This avoids collapsing all outcomes into the current "success/failure based on exit code" shape.

Tests:

- accepted-but-not-yet-merged candidate is not rendered as fully complete in interactive flows,
- auto-mode merge success is rendered as success,
- merge failure is surfaced as a host-side failure with preserved candidate context.

---

### Wave 5 — approval and lifecycle surfaces

Make the preserved sandbox model visible and durable.

### W5.1. Update approval text and follow-up actions

Files:

- `src/host/approvalProducer.ts`
- `src/host/oneShotRun.ts`
- `src/host/sessionLifecycle.ts`
- follow-up action handling if needed

Work:

- approval prompts should mention preserved merge-candidate vs report-only sandbox,
- auto-mode should auto-merge accepted code-changing candidates,
- interactive mode should preserve accepted candidates for later merge/discard.

Tests:

- approval-required flow for preserved code-changing work,
- auto-approved flow merges on success,
- deny still wins.

### W5.2. Persist sandbox lifecycle state durably

Files:

- `src/sessionTypes.ts`
- session store helpers
- inspect surfaces

Work:

- make preserved candidate state inspectable after the run,
- surface merge/discard/cleanup status in inspect and JSON mode.

Tests:

- preserved candidate survives process restart,
- inspect output shows worktree path and lifecycle status,
- cleanup updates persisted state.

---

### Wave 6 — reusable live workflow harness

This is the confidence-building wave and should land with the functional changes, not after them.

### W6.1. Extract a live workflow helper

Suggested files:

- new `tests/helpers/liveWorkflowHarness.ts`
- update `tests/integration/live-python-workflow.test.ts`

Harness responsibilities:

- create isolated repos,
- seed files,
- run bakudo with explicit repo/config/abox settings,
- inspect session artifacts and preserved worktrees,
- run host verification commands,
- clean up repos and leftovers.

### W6.2. Add realistic workflow suites

Recommended tests:

- `tests/integration/live-python-workflow.test.ts`
- new Node workflow test
- new inspect-only workflow test
- new preserved-failure-and-discard test
- new installed-vs-explicit-abox-path live test

Each live test should be gated and repeatable:

- gate with env vars like `BAKUDO_INTEGRATION_E2E=1`,
- keep assertions stable and contract-based,
- avoid asserting on model chatter/noise.

### W6.3. Add non-live integration coverage around the same contracts

Not every contract needs a VM boot.

Add fast tests for:

- planner profile mapping,
- adapter argv,
- worktree discovery,
- merge/discard orchestration,
- review classification,
- artifact harvesting.

---

### Wave 7 — future parallel compare seam

Do not implement full multi-worker orchestration yet, but leave the codebase ready for it.

### W7.1. Reserve batch/candidate identifiers

Potential files:

- `src/host/dispatchPlan.ts`
- `src/sessionTypes.ts`

Work:

- allow a dispatch plan to carry an optional `batchId` / `candidateId`,
- do not wire actual fan-out yet.

### W7.2. Keep merge/discard logic candidate-scoped

Work:

- design merge/discard helpers so they operate on one preserved candidate at a time,
- avoid any assumption that there is only one candidate per turn forever.

This is enough to support a later "five approaches in parallel" phase without redoing the correctness work.

---

## File-level forecast

Most likely touched files:

- `src/aboxAdapter.ts`
- `src/host/attemptCompiler.ts`
- `src/host/planner.ts`
- `src/host/sessionController.ts`
- `src/host/oneShotRun.ts`
- `src/host/sessionLifecycle.ts`
- `src/reviewer.ts`
- `src/sessionTypes.ts`
- `src/worker/assistantJobRunner.ts`
- `src/worker/checkRunner.ts`
- `src/workerRuntime.ts`
- `src/host/sessionArtifactWriter.ts`
- `src/host/approvalProducer.ts`
- `src/host/init.ts`
- new host helpers for:
  - dispatch plan
  - worktree discovery
  - sandbox lifecycle
  - merge/discard orchestration
  - worktree inspection
- new test helper:
  - `tests/helpers/liveWorkflowHarness.ts`

---

## Suggested commit slices

When implementation starts, keep commits intentionally reviewable.

Recommended slices:

1. `fix(dist): ship default config with installed bakudo`
2. `fix(worker): honor stdin and repair run_check execution`
3. `refactor(host): add dispatch plan and execution profiles`
4. `fix(worker): make assistant_job use a real agent backend`
5. `feat(host): preserve merge-candidate sandboxes and discover worktrees`
6. `feat(host): review preserved candidates against worktree state`
7. `test(integration): add reusable live workflow harness and preserved-flow coverage`

No commits should span both repos unless an actual abox-side gap appears.

---

## Exit criteria

The design is implemented when all of these are true:

1. `implement_change` no longer routes through ephemeral sandboxes by default.
2. A successful auto-mode code-changing run updates the host repo via merge, not by assuming stdout means success.
3. A code-changing run that exits 0 but makes no requested mutation is rejected.
4. `inspect_repository` produces durable report artifacts without mutating the repo.
5. Failed/uncertain code-changing candidates remain inspectable and discardable.
6. `run_check` executes the intended command through the verification pipeline.
7. Installed bakudo works with its default config.
8. Live workflow tests cover both preserved merge-candidate flows and ephemeral check/report flows.

---

## Questions to confirm before coding

These are the decisions worth explicitly confirming:

1. Default `assistant_job` backend:
   Recommendation: `codex exec --full-auto`
2. `inspect_repository` persistence:
   Recommendation: preserved + harvest + discard
3. interactive merge behavior:
   Recommendation: auto-merge only in auto/noninteractive mode for the first wave
4. mutating `run_explicit_command` behavior:
   Recommendation: keep ephemeral in v1 and surface mutation as a fact, not a merged result

With those confirmed, implementation can proceed without reopening the control-plane model itself.
