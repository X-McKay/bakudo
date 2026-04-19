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

- [ ] **Wave 0** — installed config, stdin pipeline, `run_check` fix, lifecycle wording.
- [ ] **Wave 1** — `DispatchPlan` + `ExecutionProfile`.
- [ ] **Wave 2** — `assistant_job` backend-driven, reserved guest output dir.
- [ ] **Wave 3** — split `aboxAdapter`, host lifecycle helpers, remove `BAKUDO_EPHEMERAL`.
- [ ] **Wave 4** — worktree inspection, host-generated artifacts, profile-aware review, decoupled execute/review.
- [ ] **Wave 5** — approval copy + lifecycle persistence + inspect surfaces.
- [ ] **Wave 6** — live workflow harness + non-live coverage; **Wave 7** — batch/candidate seams.
- [ ] **UX realignment** — candidate cards, lifecycle/merge chips, footer hints, `output` transcript kind, log v2 envelope renderer.
- [ ] **Cleanup + docs + delivery report.**

## Per-wave notes

(Filled in as each wave lands.)
