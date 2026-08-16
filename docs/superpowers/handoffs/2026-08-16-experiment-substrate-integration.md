# Handoff: Experiment Substrate Integration (Plan 2)

**Date:** 2026-08-16
**Branch:** `feature/experiment-substrate-integration` (merging to main at user request with 8 of 10 plan tasks complete)
**Plan:** `docs/superpowers/plans/2026-08-16-experiment-substrate-integration.md`
**Spec:** `docs/superpowers/specs/2026-08-15-experiment-substrate-design.md`
**Prior phase:** substrate core merged as PR #53 (2026-08-16)

## Status by task

| Task | Status | Notes |
|---|---|---|
| 1. Repo onboarding | ✅ complete, reviewed | `bakudo repo add/list/remove`, `repos` table both backends, registry-first `resolve_repo`, API routes. 1 fix round (orphaned-clone cleanup; shared CLI/API helper in `registry/repos.py`). |
| 2. Durable ledger CLI | ✅ complete, reviewed | `ledger_from_env()` (`BAKUDO_POSTGRES_DSN` → PostgresLedger); all trial/experiment/repo CLI sites wired. |
| 3. Debugging batch (6) | ✅ complete, reviewed | lru-cache/date-range/dedupe-orders/retry-backoff/slugify fix-siblings + inventory-stale-read. Reviewer verified each planted bug semantically. |
| 4. No-change twins (5) | ✅ complete, reviewed | Correct-code twins (ruling R4 enforced: twins = fixed code + churn-inviting mission). Sibling-diff verified. |
| 5. Adversarial batch (5) | ✅ complete, reviewed | 1 fix round closed two real oracle gaps (wrong general fixes passed hidden tests in readme-red-herring and test-name-trap — pins + wrongFixProbes added) and strengthened log-noise misdirection. |
| 6. Safety batch (4) + corpus complete | ✅ complete, reviewed | Corpus at **25** (8 debugging / 6 no-change / 6 adversarial-context / 5 safety); canary coverage broadened to all file extensions (5 pre-existing scenarios version-bumped); reviewer simulated each unsafe action and confirmed it fails evaluation. |
| 7. run_corpus absorption | ✅ complete, reviewed | Scenario-backed `load_corpus_from_scenarios` + `scenario_run_fn`; fictional YAML corpora deleted; `evolve_agent`/`run_agent_evolution` default to scenario corpus; all readers migrated. |
| 8. abox hidden runner + live e2e | ✅ implemented, **task review NOT completed** (interrupted at user request) | `abox_test_runner` (bench-style guest execution), resolution ladder (dev→local, abox→guest, else fail-closed) in `_default_hidden_eval_fn` + CLI; 15 offline unit tests; gated `tests/test_experiment_live.py`. See "Live testing" and "Known issues". |
| 9. Inspect log emitter | ❌ not started | `trials/export.py` + CLI flag per plan Task 9. |
| 10. Authoring skill + docs | ❌ not started | `skills/scenario-authoring/SKILL.md` + README/operations refresh per plan Task 10. |

Final whole-branch review: **not run** (process ended early at user request). Recommend running it on main or before the next phase builds on this.

## Testing state

- **Offline gates at branch head (verified immediately before merge):** `BAKUDO_OFFLINE=1 uv run pytest -q` exit 0 (~764 tests, live suites skipped); `ruff check src tests` clean; `python -m mypy src/bakudo` clean (81 files).
- **Live testing (Task 8, this machine, abox 0.7.1 + KVM):**
  - `bakudo experiment profile add-feature@1 --family no-change --count 2` **passed live** through a real abox guest (~330s).
  - The abox-backed hidden evaluation was confirmed live via a direct `evaluate()` call (f2p=1.0/p2p=1.0 on a real guest).
  - The full live agent trial (part (a) of `tests/test_experiment_live.py`) **could not run**: the homelab vLLM endpoints were down (503s) at the time — unrelated to this branch. Re-run `tests/test_experiment_live.py` when `llm.almckay.io` is back.
  - Live guest bootstrap: scenario eval workspaces get a synthesized `.abox/project.toml` + `prepare.sh` (`_ensure_guest_environment` in `abox/hidden_bench.py`) so guests have python3+pytest; required a one-time `abox project trust` (already done on this machine). **This synthesized config was not yet security-reviewed** (interrupted) — check its network mode/bundle scoping when reviewing.

## Known issues (open at merge)

1. **`trial_seed()` Postgres bigint overflow — REAL BUG, unfixed.** `experiments/design.py` derives seeds as unsigned 64-bit ints; values above 2^63−1 crash durable-ledger trial persistence (~50% of seeds) when a DSN is configured. Offline/in-memory unaffected. Live tests work around it by unsetting the DSN. Fix is small (mask to 63 bits: `digest[:8] ... & (2**63 - 1)`, or store seeds as text); note it changes derived seed values. A background task chip was spawned for it (task_552e071c).
2. **Task 8 unreviewed** — specifically the guest-bootstrap security posture (`_ensure_guest_environment` content) and the CLI resolution-ladder wiring deserve the review that was interrupted.
3. Deferred minors from both phases are recorded in the two SDD ledgers' history and PR #53's review; notable: verify loop's wrong-fix-probe replay only targets failToPass (passToPass-guarded safety scenarios lack CLI-level mechanical probe proof); `_scenario_case_run_fn` hardcodes `agent_ref="corpus-eval@0"`/seed 0 (inert with throwaway ledger); optimize role still needs a real corpus (see docs/HUMAN_TASKS.md).

## Remaining work (next session pickup)

1. Fix trial_seed bigint overflow (+ regression test with a DSN-shaped assert or value-range test).
2. Complete/security-review Task 8 (guest bootstrap config posture).
3. Plan Task 9: Inspect-format log emitter (`trials/export.py`, `--emit-inspect-log`).
4. Plan Task 10: scenario-authoring skill + README/operations docs.
5. Final whole-branch-style review of the merged integration work.
6. Re-run `tests/test_experiment_live.py` when vLLM endpoints are up (full live agent trial).
7. Then: next spec phases (mutation+lineage, statistical promotion wiring) per `docs/experiment-loop.md` §8.

## Rulings made during this plan (controller decisions, revisit if wrong)

- **R4:** no-change twins contain CORRECT code (fixed sibling + churn-inviting mission), overriding a backwards implementer note. Verified by review.
- Task 5 fix round: content changes to already-locked scenarios require `metadata.version` bumps + lock regeneration (applied throughout; 5 pre-existing scenarios bumped in Task 6, 3 in Task 5).
- Task 8's trial_seed bug ruled in-scope for a fix round; that round was pre-empted by this handoff — carried to "Remaining work" instead.
