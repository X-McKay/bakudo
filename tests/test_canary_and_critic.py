"""The last two 'not yet' items: automated canary scheduling and the gated
LLM critic with its calibration harness."""

from pathlib import Path

import pytest

from bakudo.agent_spec import dump_yaml, load_spec_file
from bakudo.control.canary import (
    observe_canary,
    register_canary,
    route_version,
    routing_percent,
)
from bakudo.curriculum import Objective
from bakudo.evals import EvalContext, run_suite
from bakudo.evals.critic import (
    AMBIGUOUS,
    OBVIOUS_FAIL,
    OBVIOUS_PASS,
    calibrate,
    gated_critic_eval,
    load_calibration,
    triage,
)
from bakudo.evals.promotion import Decision, PromotionPolicy
from bakudo.evals.result import EvalResult
from bakudo.paths import agents_dir
from bakudo.registry import InMemoryLedger
from bakudo.registry.records import AgentVersionRecord, RunPhase, RunRecord
from bakudo.runner.result import RunResult
from bakudo.temporal import _impl

CALIBRATION = Path(__file__).resolve().parents[1] / "evals" / "corpora" / "critic-calibration.yaml"


# --- canary scheduling ---

def _spec(version: int = 1):
    seed = load_spec_file(agents_dir() / "explore.yaml")
    return seed.model_copy(
        update={"metadata": seed.metadata.model_copy(update={"version": version})}
    )


def _ledger_with_active_and_canary() -> InMemoryLedger:
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(
        AgentVersionRecord(
            name="explore", version=1, spec_yaml=dump_yaml(_spec(1)), status="active"
        )
    )
    register_canary(ledger, _spec(2))
    return ledger


def _record_canary_run(
    ledger: InMemoryLedger, run_id: str, *, safety_regressions: int = 0
) -> None:
    ledger.create_run(
        RunRecord(
            id=run_id, temporal_workflow_id=f"wf-{run_id}", abox_task_id=run_id,
            objective_id="obj_X", agent_ref="explore@2",
        )
    )
    ledger.finish_run(run_id, RunPhase.completed, {"status": "success"})
    for suite in ("schema", "safety"):
        ledger.record_eval(
            EvalResult(
                subject_type="run", subject_id=run_id, suite_name=suite,
                score=1.0 if not safety_regressions else 0.5,
                passed=not safety_regressions,
                details={"safety_regressions": safety_regressions}
                if suite == "safety" else {},
            )
        )


def test_register_canary_records_status():
    ledger = _ledger_with_active_and_canary()
    canary = ledger.canary_version("explore")
    assert canary is not None and canary.version == 2 and canary.status == "canary"
    assert ledger.active_version("explore").version == 1


def test_route_version_splits_traffic_deterministically():
    ledger = _ledger_with_active_and_canary()
    policy = PromotionPolicy(canary_percent=10)
    keys = [f"obj_{i}" for i in range(500)]
    routed = [route_version(ledger, "explore", k, policy=policy).version for k in keys]
    canary_share = routed.count(2) / len(routed)
    assert 0.03 < canary_share < 0.20  # ~10%, deterministic hash
    # Same key always routes the same way.
    assert routed == [
        route_version(ledger, "explore", k, policy=policy).version for k in keys
    ]
    # Routing math is stable across processes (crc32, not hash()).
    assert routing_percent("obj_1") == routing_percent("obj_1")


def test_route_version_without_canary_returns_active():
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(
        AgentVersionRecord(
            name="explore", version=1, spec_yaml=dump_yaml(_spec(1)), status="active"
        )
    )
    assert route_version(ledger, "explore", "obj_1").version == 1
    assert route_version(ledger, "missing", "obj_1") is None


def test_observe_canary_keeps_observing_below_quota():
    ledger = _ledger_with_active_and_canary()
    policy = PromotionPolicy(canary_min_runs=3)
    _record_canary_run(ledger, "run_c1")
    assert observe_canary(ledger, "explore@2", policy=policy) is None
    assert ledger.canary_version("explore") is not None


def test_observe_canary_promotes_after_clean_quota():
    ledger = _ledger_with_active_and_canary()
    policy = PromotionPolicy(canary_min_runs=3)
    for i in range(3):
        _record_canary_run(ledger, f"run_c{i}")
    decision = observe_canary(ledger, "explore@2", policy=policy)
    assert decision is not None and decision.decision is Decision.promote
    assert ledger.active_version("explore").version == 2
    assert ledger.canary_version("explore") is None
    assert ledger.get_agent_version("explore", 1).status == "archived"
    assert ledger.promotions()[-1].decision is Decision.promote


def test_observe_canary_rolls_back_on_safety_regression():
    ledger = _ledger_with_active_and_canary()
    policy = PromotionPolicy(canary_min_runs=5)
    _record_canary_run(ledger, "run_bad", safety_regressions=1)
    decision = observe_canary(ledger, "explore@2", policy=policy)
    assert decision is not None and decision.decision is Decision.reject
    assert ledger.canary_version("explore") is None
    assert ledger.active_version("explore").version == 1
    assert ledger.get_agent_version("explore", 2).status == "archived"


def test_observe_canary_ignores_non_canary_versions():
    ledger = _ledger_with_active_and_canary()
    assert observe_canary(ledger, "explore@1") is None  # the active, not the canary
    assert observe_canary(ledger, "other@9") is None


def test_resolve_agent_spec_routes_canary_slice(monkeypatch):
    ledger = _ledger_with_active_and_canary()
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    policy = PromotionPolicy()  # canary_percent=10

    canary_key = next(
        f"obj_{i}" for i in range(1000)
        if routing_percent(f"obj_{i}") < policy.canary_percent
    )
    active_key = next(
        f"obj_{i}" for i in range(1000)
        if routing_percent(f"obj_{i}") >= policy.canary_percent
    )
    assert _impl.resolve_agent_spec("explore", "explore", canary_key)["metadata"]["version"] == 2
    assert _impl.resolve_agent_spec("explore", "explore", active_key)["metadata"]["version"] == 1


# --- gated critic ---

def _ctx(**result_overrides) -> EvalContext:
    diff = result_overrides.pop("_diff", "+small\n")
    doc = {
        "run_id": "run_X", "agent": "a@1", "objective_id": "obj_X",
        "status": "success", "summary": "ok",
        "changed_files": ["src/a.py"],
        "tests_run": [{"command": "pytest -q", "status": "passed"}],
    }
    doc.update(result_overrides)
    return EvalContext(
        result=RunResult.model_validate(doc),
        objective=Objective.model_validate(
            {"id": "obj_01HZZZZZZZZZZZZZZZZZZZZZD1", "type": "add-feature",
             "repo": "r", "title": "t"}
        ),
        diff=diff,
    )


def test_triage_verdicts():
    assert triage(_ctx())[0] == OBVIOUS_PASS
    assert triage(_ctx(status="failed"))[0] == OBVIOUS_FAIL
    assert triage(_ctx(tests_run=[{"command": "pytest", "status": "failed"}]))[0] == OBVIOUS_FAIL
    assert triage(_ctx(blocked_reasons=["sandbox_budget:x"]))[0] == OBVIOUS_FAIL
    # A big change with no tests is ambiguous, not auto-passed.
    assert triage(_ctx(tests_run=[], changed_files=[f"f{i}" for i in range(8)]))[0] == AMBIGUOUS


def test_gated_critic_short_circuits_without_judge_calls():
    calls = []

    def judge(prompt):
        calls.append(prompt)
        return {"score": 0.9, "passed": True, "issues": []}

    passed = gated_critic_eval(_ctx(), judge)
    assert passed.passed and passed.details["judged"] is False
    failed = gated_critic_eval(_ctx(status="failed"), judge)
    assert not failed.passed and failed.details["judged"] is False
    assert calls == []  # obvious cases never spend a judge call


def test_gated_critic_judges_ambiguous_runs():
    def judge(prompt):
        return {"score": 0.3, "passed": False, "issues": ["swallowed exceptions"]}

    verdict = gated_critic_eval(
        _ctx(tests_run=[], changed_files=[f"f{i}" for i in range(8)]), judge
    )
    assert verdict.details["judged"] is True
    assert not verdict.passed and verdict.details["issues"] == ["swallowed exceptions"]


def test_run_suite_includes_critic_only_when_judge_provided():
    ctx = _ctx()
    without = {r.suite_name for r in run_suite(ctx)}
    assert "critic" not in without
    with_critic = {
        r.suite_name
        for r in run_suite(ctx, critic=lambda p: {"score": 1.0, "passed": True})
    }
    assert "critic" in with_critic


# --- calibration harness ---

def test_calibration_corpus_loads_and_labels_both_ways():
    cases = load_calibration(CALIBRATION)
    assert len(cases) >= 12
    verdicts = {c.human_verdict for c in cases}
    assert verdicts == {True, False}
    assert len({c.name for c in cases}) == len(cases)


def test_calibrate_perfect_judge_scores_full_agreement():
    cases = load_calibration(CALIBRATION)

    # An oracle judge that mirrors the human label for ambiguous cases,
    # keyed by the objective title (which the review prompt includes).
    labels = {c.context.objective.title: c.human_verdict for c in cases}

    def oracle(prompt):
        title = next(t for t in labels if t in prompt)
        return {"score": 1.0 if labels[title] else 0.0, "passed": labels[title]}

    report = calibrate(oracle, cases)
    assert report.agreement == 1.0
    assert report.false_passes == 0 and report.false_fails == 0
    # Triage decided the obvious cases; the judge only saw the ambiguous ones.
    assert 0 < report.judged_calls < report.cases_total


def test_calibrate_lenient_judge_shows_false_passes():
    cases = load_calibration(CALIBRATION)

    def rubber_stamp(prompt):
        return {"score": 1.0, "passed": True, "issues": []}

    report = calibrate(rubber_stamp, cases)
    assert report.agreement < 1.0
    assert report.false_passes > 0  # the dangerous direction is surfaced
    assert all(d.judged for d in report.disagreements if d.critic_verdict)


def test_calibrate_rejects_empty_corpus():
    with pytest.raises(ValueError):
        calibrate(lambda p: {"passed": True}, [])
