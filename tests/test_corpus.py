from bakudo.curriculum import Objective
from bakudo.evals import Scorecard
from bakudo.evals.corpus import (
    CaseRun,
    EvalCase,
    OutcomeConstraints,
    grade_expectations,
    run_corpus,
)
from bakudo.runner.result import RunResult


def _result(status="success", changed=("a.py",), tests=(("pytest", "passed"),)):
    return RunResult.model_validate(
        {
            "run_id": "run_X",
            "agent": "add-feature@1",
            "objective_id": "obj_X",
            "status": status,
            "summary": "s",
            "changed_files": list(changed),
            "tests_run": [{"command": c, "status": s} for c, s in tests],
        }
    )


def _case(name="c1", paths=("a.py",)):
    return EvalCase(
        name=name,
        objective=Objective(type="add-feature", repo="r", title="t", acceptanceCriteria=["do it"]),
        constraints=OutcomeConstraints(allowed_change_paths=list(paths)),
    )


def test_grade_expectations_flags_missing_path_and_denials():
    run = CaseRun(
        result=_result(changed=("other.py",)),
        denied_commands=[{"command": "sudo", "reason": "sudo"}],
    )
    passed, reasons = grade_expectations(_case(paths=("a.py",)), run)
    assert not passed
    assert any("a.py" in r for r in reasons)
    assert any("denied" in r for r in reasons)


def test_run_corpus_aggregates_and_reports_case_count():
    cases = [_case("c1"), _case("c2"), _case("c3")]

    def run_fn(objective):
        return CaseRun(result=_result(), diff="")

    results = run_corpus("add-feature", cases, run_fn, subject_id="add-feature@2")
    by_suite = {r.suite_name: r for r in results}
    assert "role-specific" in by_suite
    # A corpus run IS the regression evidence (spec §15.3): the synthetic
    # 'regression' suite passes only when every case is fully clean.
    assert "regression" in by_suite
    assert by_suite["regression"].passed is True
    # Every aggregated suite reports the corpus size as cases_total.
    assert all(r.details["cases_total"] == 3 for r in results)

    card = Scorecard.from_results(results)
    # cases_total is the distinct case count (3), not the sum across suites.
    assert card.cases_total == 3
    assert "role-specific" in card.passed_suites
    assert "regression" in card.passed_suites


def test_run_corpus_regression_suite_fails_on_any_dirty_case():
    cases = [_case("c1"), _case("c2", paths=("missing.py",))]

    def run_fn(objective):
        return CaseRun(result=_result(), diff="")

    results = run_corpus("add-feature", cases, run_fn, subject_id="add-feature@2")
    regression = next(r for r in results if r.suite_name == "regression")
    assert regression.passed is False
    assert regression.score == 0.5
    assert regression.details["cases_passed"] == 1
