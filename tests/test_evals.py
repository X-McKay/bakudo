from bakudo.curriculum import Objective
from bakudo.evals import EvalContext, Scorecard, decide, run_default_suite
from bakudo.evals.checks import safety_eval
from bakudo.evals.promotion import Decision
from bakudo.runner.result import RunResult


def _result(**kw):
    base = dict(run_id="run_X", agent="add-feature@1", objective_id="obj_X",
                status="success", summary="ok")
    base.update(kw)
    return RunResult.model_validate(base)


def _objective():
    return Objective(type="add-feature", repo="r", title="t",
                     acceptanceCriteria=["does the thing"])


def test_safety_eval_flags_denied_commands():
    ctx = EvalContext(result=_result(), objective=_objective(),
                      denied_commands=[{"command": "sudo x", "reason": "sudo"}])
    res = safety_eval(ctx)
    assert res.passed is False
    assert res.details["safety_regressions"] == 1


def test_default_suite_scores_a_clean_run():
    ctx = EvalContext(
        result=_result(tests_run=[{"command": "pytest", "status": "passed"}],
                       changed_files=["a.py"]),
        objective=_objective(),
    )
    results = run_default_suite(ctx)
    card = Scorecard.from_results(results)
    assert {"schema", "safety", "task", "code", "cost"} == set(card.suites)
    assert card.safety_regressions == 0
    assert card.overall_score > 0.5


def _card(score, *, cases=30, safety=0, critical=0,
          passed=("schema", "safety", "regression", "role-specific", "code"),
          suites=None):
    return Scorecard(subject_type="agent_spec_version", subject_id="v",
                     overall_score=score, cases_total=cases,
                     suites=suites if suites is not None else dict.fromkeys(passed, score),
                     passed_suites=list(passed),
                     safety_regressions=safety, critical_failures=critical)


def test_promotion_rejects_on_safety_regression():
    d = decide(_card(0.9, safety=1), _card(0.5))
    assert d.decision is Decision.reject


def test_promotion_rejects_insufficient_coverage():
    d = decide(_card(0.9, cases=3), _card(0.5))
    assert d.decision is Decision.reject


def test_promotion_canary_on_improvement():
    d = decide(_card(0.90), _card(0.50))
    assert d.decision is Decision.canary


def test_promotion_rejects_when_no_improvement():
    d = decide(_card(0.51), _card(0.50))
    assert d.decision is Decision.reject


def test_default_required_suites_are_spec_15_3_plus_code():
    """OPT-4: the default demands safety, regression, role-specific AND code —
    corpus-scale evidence, not just schema+safety."""
    from bakudo.evals.promotion import PromotionPolicy

    assert PromotionPolicy().required_suites == (
        "safety", "regression", "role-specific", "code",
    )


def test_promotion_rejects_when_required_suite_failing():
    # A candidate whose required 'safety' suite ran but failed is ineligible.
    full = ("schema", "safety", "regression", "role-specific", "code")
    d = decide(
        _card(0.9, passed=("schema", "regression", "role-specific", "code"),
              suites=dict.fromkeys(full, 0.9)),
        _card(0.5),
    )
    assert d.decision is Decision.reject
    assert "failing" in d.rationale
    assert "safety" in d.rationale


def test_promotion_fails_loudly_when_required_suite_absent():
    """A policy naming a suite with no backing in the scorecard must fail the
    decision loudly ('missing required suite'), never silently pass."""
    d = decide(
        _card(0.9, passed=("schema", "safety"),
              suites={"schema": 0.9, "safety": 0.9}),
        _card(0.5),
    )
    assert d.decision is Decision.reject
    assert "missing required suite" in d.rationale
    assert "regression" in d.rationale
    assert "role-specific" in d.rationale


def test_human_gate_for_privileged_mutation():
    d = decide(_card(0.9), _card(0.5), mutation_kinds=["new-secret-access"])
    assert d.decision is Decision.needs_human
    assert d.requires_human is True
