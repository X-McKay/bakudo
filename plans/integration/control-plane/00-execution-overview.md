# Bakudo Control-Plane Realignment: Execution Overview

**Status:** Ready for Implementation
**Author:** Manus AI

This document provides a high-level execution strategy for the bakudo↔abox control-plane realignment described in the [2026-04-19 spec](../2026-04-19-bakudo-abox-control-plane-spec.md). It is designed to allow a team of engineers (or parallel agents) to safely implement the 12,000+ line refactor across 8 waves without breaking the `main` branch.

## Phasing and Parallelism

The implementation is strictly sequenced into **Waves**. A wave represents a unit of work that can be merged to `main` while keeping the test suite green.

### Sequential Path (The Critical Path)
Waves 0, 1, 3, and 4 must be implemented sequentially. They form the structural spine of the refactor:
1. **Wave 0:** Correctness floor (fixes bugs in the current pipeline).
2. **Wave 1:** Data model (`DispatchPlan`, `ExecutionProfile`).
3. **Wave 3:** Orchestration (`aboxAdapter` split, worktree discovery).
4. **Wave 4:** Review decoupling (host-generated artifacts, decoupled review).

### Parallel Opportunities
Once the critical path is moving, several waves can be executed in parallel by different engineers:
- **Wave 2 (assistant_job backend)** can be implemented in parallel with Wave 1. It only touches the worker layer.
- **Wave 5 (Approval copy & Inspect surfaces)** can be implemented in parallel with Wave 4, as long as it mocks the `SandboxLifecycleState` persistence until Wave 4 lands.
- **UX Realignment** can begin as soon as Wave 1 (Data model) lands, allowing the frontend to bind to the new vocabulary before the orchestration actually produces it.

## The Detailed Implementation Plans

This directory contains a junior-engineer-proof, step-by-step implementation plan for each wave. If followed exactly, the refactor will succeed.

| Plan | Scope | Risk |
| :--- | :--- | :--- |
| [Wave 0: Correctness Floor](waves/01-wave-0-correctness.md) | Config resolution, stdin pipeline, `run_check` fix. | Low |
| [Wave 1: Data Model](waves/02-wave-1-data-model.md) | `DispatchPlan`, `ExecutionProfile`, planner routing. | Low |
| [Wave 2: Worker Backend](waves/03-wave-2-worker-backend.md) | `codex exec` backend, reserved output directory. | Medium |
| [Wave 3: Orchestration](waves/04-wave-3-orchestration.md) | Split `aboxAdapter`, `worktreeDiscovery`, remove legacy code. | High |
| [Wave 4: Review Decoupling](waves/05-wave-4-review-decoupling.md) | `worktreeInspector`, host artifacts, decoupled review pipeline. | High |
| [Wave 5: Persistence & UI](waves/06-wave-5-persistence-ui.md) | Lifecycle persistence, inspect tabs, approval copy. | Medium |
| [Waves 6 & 7: Live Harness & Batch](waves/07-waves-6-7-harness-batch.md) | Live test harness, `CandidateSet` seams. | Medium |
| [UX Realignment](waves/08-ux-realignment.md) | Candidate cards, merge chips, footer hints, log v2 envelopes. | Medium |

## Hand-off Criteria

Before a wave is considered complete and ready for merge:
1. **Code:** All files listed in the wave's "Files to modify/delete" section have been updated.
2. **Legacy:** No deprecated code from prior waves was preserved.
3. **Tests:** `pnpm test:unit` passes. (Full `pnpm test` with goldens is only required to pass at the end of Wave 5 and the UX Realignment).
4. **Docs:** Any structural changes deviating from the wave plan are recorded in an ADR.

## Risk Management

- **Context Loss:** The largest risk in this refactor is losing the thread during Waves 3 and 4, which touch the core `executeAttempt.ts` pipeline. Engineers must rely heavily on the type system (`tsc -w`) to guide the refactor.
- **Golden Snapshots:** Golden tests will break during Wave 4 and the UX Realignment. Do not attempt to "fix" them by reverting code; instead, regenerate the fixtures using the updated transcript model.
- **Legacy Preservation:** Do not leave `WorkerTaskSpec` or `BAKUDO_EPHEMERAL` around "just in case." The spec mandates their deletion to prevent split-brain behavior.

Proceed to [Wave 0: Correctness Floor](waves/01-wave-0-correctness.md).
