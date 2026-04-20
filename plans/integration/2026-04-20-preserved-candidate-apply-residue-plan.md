# Preserved Candidate Apply Residue Plan

**Branch:** `feat/candidate-apply-residue`  
**Base commit on `main`:** `e851fd5` (`feat(host): replace merge acceptance with candidate apply`)  
**Status:** Post-cutover follow-up planning after the preserved-candidate apply stack landed on bakudo `main`.

## Purpose

The merge-era acceptance path is now removed from bakudo `main`. `accept` applies the reviewed
candidate into the source repo, bakudo owns candidate/apply/recovery state, and apply-time
verification runs through abox-backed dispatches.

This document captures the remaining bugs, coverage gaps, and cleanup work that should be
scheduled after the cutover landed cleanly.

## Landed baseline

The following are already on `main` and are **not** residue items:

- persisted candidate/apply state replaced merge-era lifecycle state
- apply recovery now understands interrupted `apply_staging`, `apply_verifying`, and
  `apply_writeback` phases
- candidate manifest + fingerprint artifacts are persisted and collision-proof in storage
- drift gating exists before source mutation
- inspect/review surfaces now prefer persisted apply-state truth over raw worker success
- bakudo no longer depends on `abox merge` for agent-produced candidate edits

## Follow-on backlog

### R1. Cover explicit-confirmation follow-up end to end

**Why this remains:** bakudo now supports `needs_confirmation`, but the dedicated accept/halt
follow-up coverage is still uneven. The unit suite covers several `candidate_ready` accept flows and
halt from preserved candidates, but it does not pin the full `needs_confirmation -> accept` success
path with the same depth as the automatic paths.

**Current evidence**

- `src/host/followUpActions.ts`
- `tests/unit/followUpActions.test.ts`
- `tests/integration/live-apply-workflow.test.ts`

**Work**

- add a unit test for `applyFollowUpAction({ action: { kind: "accept" } })` when the persisted
  attempt already sits in `candidateState: "needs_confirmation"`
- add a matching discard/halt test from `needs_confirmation`
- extend live E2E coverage so a preserved candidate can be reviewed, then accepted or halted,
  instead of stopping at the initial blocked state

**Done when**

- accept-from-`needs_confirmation` writes the expected apply artifacts and final state
- halt-from-`needs_confirmation` proves discard + cleanup behavior
- live/manual confirmation flow is exercised, not just the initial block

### R2. Pin non-interactive blocked and failed apply outcomes

**Why this remains:** the preserved-candidate pipeline is well-covered for successful auto-apply and
several failure/recovery cases, but the initial non-interactive execution path still needs direct
integration coverage for blocked and failed terminal states.

**Current evidence**

- `src/host/executeAttempt.ts`
- `tests/integration/pipeline.test.ts`
- `tests/integration/inspect-surface.test.ts`
- `tests/regression/F-03-resume-attempt-spec.test.ts`

**Work**

- add pipeline coverage for a first-pass non-interactive run that ends in `needs_confirmation`
- add pipeline coverage for a first-pass non-interactive run that ends in `apply_failed`
- verify that `status`, `review`, and `inspect --json` remain truthful after reload/restart for both
  states

**Done when**

- blocked and failed apply outcomes are both asserted from initial execution through persisted read
  surfaces
- restart/reload does not regress the reported candidate state or review outcome

### R3. Finish the drift-policy and unsupported-surface test matrix

**Why this remains:** the implementation covers more cases than the tests pin today. That leaves too
much room for accidental behavior drift around source changes and unsupported repository surfaces.

**Current evidence**

- `src/host/sourceBaseline.ts`
- `tests/unit/sourceBaseline.test.ts`
- `src/host/candidateApplier.ts`
- `tests/unit/applyWorkspace.test.ts`

**Work**

- extend `sourceBaseline` tests to cover the full drift matrix:
  branch switch, head advance, dirty-source overlap, deletes, and no-op source edits
- add explicit candidate-apply tests for symlink, binary, and submodule surfaces
- pin the persisted conflict/report artifacts for unsupported-surface outcomes

**Done when**

- every drift decision has a named regression test
- unsupported surfaces fail or require confirmation deterministically with explicit artifact output

### R4. Make the golden-fixture harness work from isolated bakudo worktrees

**Why this remains:** `pnpm test` in an isolated bakudo worktree still requires a temporary local
symlink to satisfy golden fixture discovery. That is a harness bug, not a product behavior issue.

**Current evidence**

- `tests/helpers/golden.ts`
- `tests/helpers/golden.ts:71-86` walks parent directories looking for
  `plans/bakudo-ux/examples`
- full-suite runs from `/home/al/.codex-worktrees/...` fail without a local symlink

**Work**

- stop assuming the UX fixture tree is present as a parent-workspace sibling
- resolve fixtures from a stable repo-root contract or an explicit env override
- keep `pnpm test` green from the main checkout and from isolated bakudo worktrees

**Done when**

- `pnpm test` passes in an isolated bakudo worktree without creating `plans/bakudo-ux` manually

### R5. De-brittle artifact assertions in preserved-candidate integration tests

**Why this remains:** at least one preserved-candidate pipeline assertion still deep-equals the full
artifact name list. That is overly strict for a subsystem that is expected to grow apply-time
artifacts over time.

**Current evidence**

- `tests/integration/pipeline.test.ts:245-264`

**Work**

- replace full-list equality checks with required-artifact assertions
- keep exactness only where the artifact contract is intentionally closed

**Done when**

- apply-related tests fail only for contract regressions, not for additive artifact output

### R6. Remove disposable pre-cutover session migration code

**Why this remains:** the product decision for this cutover was that pre-cutover session data is
disposable. Bakudo still carries legacy migration logic and tests for older session shapes.

**Current evidence**

- `src/sessionMigration.ts`
- `tests/unit/sessionMigration.test.ts`

**Work**

- verify no active commands/tests still depend on v1/v2 migration behavior
- delete legacy migration paths and tighten the accepted persisted session contract

**Done when**

- pre-cutover migration code is removed and the session schema only describes the post-cutover model

## Suggested order

1. `R4` so bakudo test runs no longer depend on a local symlink workaround.
2. `R1` and `R2` to tighten behavioral confidence on the confirmation/apply lifecycle.
3. `R3` to harden drift and unsupported-surface policy.
4. `R5` to reduce false-positive integration failures.
5. `R6` once the new persisted contract is fully pinned.

## External follow-up noted but not owned by this branch

- Workspace-root `just integration-test` still only exercises the live E2E apply flow when
  `BAKUDO_INTEGRATION_E2E=1` is set.
- `abox` still needs its own CLI/E2E regression for the hardened non-`CONFLICT` merge failure path.
