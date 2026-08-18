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


# --- unified eval assembly (TMP-22) ---


def _optimize_objective():
    return Objective(
        type="optimize", repo="r", title="t",
        acceptanceCriteria=["All existing tests pass"],
        performance={
            "workloadRef": {
                "name": "smoke-python-loop",
                "version": "1.0.0",
                "source": "directory",
            },
            "primaryMetric": "elapsed_seconds",
        },
    )


def test_assemble_suite_does_not_trust_optimize_self_reported_metrics():
    """Trusted performance evidence is evaluated by the optimization control loop."""
    from bakudo.evals import assemble_suite

    add_feature = assemble_suite(
        EvalContext(result=_result(), objective=_objective()), with_critic=False
    )
    optimize = assemble_suite(
        EvalContext(result=_result(), objective=_optimize_objective()),
        with_critic=False,
    )
    add_suites = {r.suite_name for r in add_feature}
    opt_suites = {r.suite_name for r in optimize}
    assert "perf" not in add_suites and "simplicity" not in add_suites
    assert opt_suites == add_suites


def test_assemble_suite_omits_critic_without_a_sandbox():
    """with_critic is availability-gated: no sandbox -> no critic suite, so the
    offline paths never silently differ from the Temporal path by an errored
    critic (they differ only by the critic's presence, explicitly)."""
    from bakudo.evals import assemble_suite

    ctx = EvalContext(result=_result(), objective=_objective())
    with_flag_no_sandbox = assemble_suite(ctx, sandbox=None, with_critic=True)
    plain = assemble_suite(ctx, with_critic=False)
    assert {r.suite_name for r in with_flag_no_sandbox} == {r.suite_name for r in plain}
    assert "critic" not in {r.suite_name for r in with_flag_no_sandbox}
