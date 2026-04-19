# Control-Plane Design Review

**Status:** Complete
**Date:** 2026-04-19
**Subject:** Implementation-readiness review of `2026-04-19-bakudo-abox-control-plane-spec.md` and its companion implementation plan.
**Reviewer:** Manus AI

## Executive Summary

**Verdict: READY FOR IMPLEMENTATION**

The proposed control-plane realignment is structurally sound, correctly identifies the current architectural gaps in `bakudo`, and respects the existing `abox` substrate. The implementation plan sequences the work logically, ensuring correctness blockers (Wave 0) and data model changes (Wave 1) land before orchestration changes (Wave 3). 

The design correctly observes that `bakudo` currently treats `abox` as an opaque shell-command runner and relies entirely on worker stdout for review. Shifting to a preserved-worktree model with host-owned inspection is the correct path forward for a reliable agentic control plane.

There are a few minor gaps and clarifications required, detailed below, but none require a fundamental redesign. The implementation can proceed with these adjustments.

## Codebase Cross-Check Validation

The review cross-checked the design's observations against the `bakudo` `main` branch. The code confirms the design's premises:

| Observation | Code Evidence | Status |
| :--- | :--- | :--- |
| **O-1: Prose-only runner** | `src/worker/assistantJobRunner.ts:16-28` hardcodes `claude --print` and passes the prompt as a positional argument. | **Verified** |
| **O-2: Ephemeral default** | `src/aboxAdapter.ts:176` uses `process.env.BAKUDO_EPHEMERAL !== "0"` to control persistence. | **Verified** |
| **O-3: stdin ignored** | `src/workerRuntime.ts:342` explicitly spawns the worker with `stdio: ["ignore", "pipe", "pipe"]`. | **Verified** |
| **O-4: stdout-only review** | `src/reviewer.ts` bases acceptance on exit code and check results, with no worktree inspection logic. | **Verified** |
| **O-5: run_check mismatch** | `src/worker/checkRunner.ts` builds its own shell command from `acceptanceChecks` and ignores `spec.execution.command`. | **Verified** |

## Severity-Ranked Findings

### 1. High: `executeAttempt` structural gap (Missing from Wave 1)

**Finding:** The implementation plan (Wave 1) introduces `DispatchPlan` and routes it through the session controller, but it understates the structural change required in `src/host/executeAttempt.ts`. Currently, `executeAttempt` fires `reviewAttemptResult` immediately after `runner.runAttempt` finishes. 

**Correction:** Wave 3 (Preserved Sandbox Orchestration) must explicitly decouple execution from review. The pipeline must become: `execute` -> `discover worktree` -> `inspect worktree` -> `review` -> `merge/discard`. The plan implies this in Wave 4, but it must be an explicit structural refactor in `executeAttempt.ts`.

### 2. Medium: `assistantJobRunner` docstring mismatch

**Finding:** `src/worker/assistantJobRunner.ts` lines 8-9 claim: "The bounded prompt... is passed via stdin so it is not subject to ARG_MAX limits." However, lines 27-28 actually append it as a positional argument.

**Correction:** Wave 0.2 (Make worker stdin real) must not only update `workerRuntime.ts` to pipe stdin, but also fix `assistantJobRunner.ts` to actually send the prompt via stdin instead of argv.

### 3. Medium: Artifact persistence model

**Finding:** The design (P-6) correctly prefers host-generated artifacts (`patch.diff`, `changed-files.json`). However, `src/host/sessionArtifactWriter.ts` is currently hardcoded to write exactly three execution-time artifacts (`result.json`, `worker-output.log`, `dispatch.json`). 

**Correction:** Wave 4.1 must explicitly expand `sessionArtifactWriter.ts` to accept and persist the new host-generated worktree artifacts, ensuring they are registered in the v2 NDJSON artifact log.

### 4. Low: Fallback for `git worktree list`

**Finding:** The design recommends discovering preserved worktrees via `git worktree list --porcelain` matching the `agent/<sandboxId>` branch. While `abox` (via `git2_workspace.rs`) creates standard git worktrees, `bakudo` must handle cases where the host git version is old or the worktree is detached.

**Correction:** Wave 3.2 should include a robust fallback or strict validation when parsing the `git worktree` output.

## Implementation Guidance

Proceed with the implementation plan as written, incorporating the corrections above. The wave structure is excellent for maintaining a green CI pipeline throughout the refactor. 

**Recommended immediate next step:** Begin Wave 0, starting with the installed default config fix and the `run_check` / stdin pipeline repairs.
