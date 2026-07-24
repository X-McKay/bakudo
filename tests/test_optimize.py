"""The optimize slice: graders, suite selection, and the fan-out/selection
logic behind OptimizationWorkflow (all pure, no Temporal worker needed)."""

from __future__ import annotations

from pathlib import Path

from bakudo.control.optimize import (
    attempt_objective,
    round_feedback,
    scout_objective,
    select_winner,
)
from bakudo.curriculum.objective import Objective
from bakudo.evals import (
    OPTIMIZE_SUITE,
    EvalContext,
    perf_eval,
    run_suite,
    simplicity_eval,
    suite_for,
)
from bakudo.evals.corpus import load_corpus
from bakudo.runner.result import RunResult

CORPUS = Path(__file__).resolve().parents[1] / "evals" / "corpora" / "optimize.yaml"


def make_objective(**overrides) -> Objective:
    data = {
        "type": "optimize",
        "repo": "payments-api",
        "title": "Optimize invoice listing",
        "constraints": {
            "maxFilesChanged": 4,
            "benchCommand": "pytest tests/benchmarks -q",
            "targetPaths": ["src/billing/**"],
        },
    }
    data.update(overrides)
    return Objective.model_validate(data)


def make_result(metrics: dict | None = None, **overrides) -> RunResult:
    data = {
        "run_id": "run-1",
        "agent": "optimize-attempt@1",
        "objective_id": "obj-1",
        "status": "success",
        "summary": "batched the lookups",
        "metrics": metrics or {},
    }
    data.update(overrides)
    return RunResult.model_validate(data)


def ctx_with(metrics: dict | None = None) -> EvalContext:
    return EvalContext(result=make_result(metrics), objective=make_objective())


# --- graders ---


def test_perf_eval_scores_improvement():
    res = perf_eval(ctx_with({"bench_seconds_before": 10.0, "bench_seconds_after": 7.0}))
    assert res.passed
    assert res.score == 0.8  # 0.5 neutral + 30% improvement
    assert res.details["measured"] is True


def test_perf_eval_fails_regression_beyond_noise():
    res = perf_eval(ctx_with({"bench_seconds_before": 10.0, "bench_seconds_after": 11.0}))
    assert not res.passed
    assert res.score < 0.5


def test_perf_eval_tolerates_measurement_noise():
    res = perf_eval(ctx_with({"bench_seconds_before": 10.0, "bench_seconds_after": 10.1}))
    assert res.passed  # within the 2% noise tolerance


def test_perf_eval_neutral_when_unmeasured():
    res = perf_eval(ctx_with())
    assert res.passed
    assert res.score == 0.5
    assert res.details["measured"] is False


def test_simplicity_eval_scores_complexity_delta():
    res = simplicity_eval(ctx_with({"complexity_before": 40.0, "complexity_after": 30.0}))
    assert res.passed
    assert res.score == 0.75

    worse = simplicity_eval(ctx_with({"complexity_before": 40.0, "complexity_after": 44.0}))
    assert not worse.passed


def test_suite_selection_adds_optimize_graders_only_for_optimize():
    assert suite_for("optimize") == OPTIMIZE_SUITE
    assert perf_eval not in suite_for("add-feature")

    results = run_suite(
        EvalContext(
            result=make_result({"bench_seconds_before": 2.0, "bench_seconds_after": 1.0}),
            objective=make_objective(),
        )
    )
    assert {r.suite_name for r in results} >= {"perf", "simplicity", "safety", "code"}


# --- objective builders ---


def base_objective_dict() -> dict:
    return make_objective(description="Listing is slow.").to_dict()


def test_scout_objective_is_readonly_explore_with_context():
    obj = scout_objective(base_objective_dict(), feedback=["'idea': regressed perf"])
    validated = Objective.model_validate(obj)
    validated.validate_against_schema()
    assert obj["type"] == "explore"
    assert obj["suggestedAgents"] == ["optimize-scout"]
    assert "src/billing/**" in obj["description"]
    assert "regressed perf" in obj["description"]
    assert "empty proposedFollowups" in obj["description"]


def test_attempt_objective_carries_one_hypothesis():
    obj = attempt_objective(
        base_objective_dict(), approach="Batch the per-invoice queries.", index=1
    )
    validated = Objective.model_validate(obj)
    validated.validate_against_schema()
    assert obj["type"] == "optimize"
    assert obj["suggestedAgents"] == ["optimize-attempt"]
    assert "[optimize-attempt 2]" in obj["title"]
    assert "Batch the per-invoice queries." in obj["description"]
    assert "bench_seconds_before" in obj["description"]


# --- winner selection ---


def candidate(
    *,
    run_id: str = "run-a",
    overall: float = 0.8,
    perf: float = 0.8,
    simplicity: float = 0.5,
    passed=("schema", "safety", "task", "code", "perf", "simplicity"),
    safety_regressions: int = 0,
    critical_failures: int = 0,
    status: str = "success",
    changed_files: int = 2,
) -> dict:
    return {
        "run_id": run_id,
        "git_branch": f"bakudo/{run_id}",
        "result": {
            "status": status,
            "summary": f"attempt {run_id}",
            "changed_files": [f"src/f{i}.py" for i in range(changed_files)],
        },
        "scorecard": {
            "overall_score": overall,
            "suites": {"perf": perf, "simplicity": simplicity},
            "passed_suites": list(passed),
            "failed_suites": [],
            "safety_regressions": safety_regressions,
            "critical_failures": critical_failures,
        },
    }


def test_select_winner_picks_best_eligible():
    winner = select_winner(
        [
            candidate(run_id="a", overall=0.7),
            candidate(run_id="b", overall=0.9),
            candidate(run_id="c", overall=0.8),
        ]
    )
    assert winner is not None and winner["run_id"] == "b"


def test_select_winner_gates_are_hard():
    assert select_winner([candidate(safety_regressions=1)]) is None
    assert select_winner([candidate(critical_failures=1)]) is None
    assert select_winner([candidate(passed=("schema", "safety", "task"))]) is None
    assert select_winner([candidate(status="failed")]) is None
    # A regression in either measured dimension disqualifies.
    assert select_winner([candidate(perf=0.4)]) is None
    assert select_winner([candidate(simplicity=0.3)]) is None


def test_select_winner_rejects_no_measured_improvement():
    # Both dimensions exactly neutral = churn without measured benefit.
    assert select_winner([candidate(perf=0.5, simplicity=0.5)]) is None


def test_select_winner_prefers_smaller_diff_on_ties():
    winner = select_winner(
        [
            candidate(run_id="big", overall=0.8, changed_files=6),
            candidate(run_id="small", overall=0.8, changed_files=2),
        ]
    )
    assert winner is not None and winner["run_id"] == "small"


def test_select_winner_none_when_empty():
    assert select_winner([]) is None


def test_round_feedback_names_each_failure():
    feedback = round_feedback(
        [
            candidate(run_id="a", status="failed"),
            candidate(run_id="b", perf=0.3),
            candidate(run_id="c"),  # eligible — produces no feedback line
        ]
    )
    assert len(feedback) == 2
    assert any("failed" in line for line in feedback)
    assert any("regressed" in line for line in feedback)


# --- corpus ---


def test_optimize_corpus_loads_and_validates():
    from bakudo.evals.promotion import PromotionPolicy

    suite_name, cases = load_corpus(CORPUS)
    assert suite_name == "optimize-regression"
    # The corpus must be large enough for promotion decisions to be eligible.
    assert len(cases) >= PromotionPolicy().min_eval_cases
    assert len({c.name for c in cases}) == len(cases), "case names must be unique"
    for case in cases:
        case.objective.validate_against_schema()

    decoys = [c for c in cases if c.expect.max_changed_files == 0]
    assert len(decoys) == 5, "the corpus must reward leaving optimal code alone"
    planted = [c for c in cases if (c.expect.max_changed_files or 0) > 0]
    assert len(planted) == 20
    assert all(c.expect.changes_paths for c in planted)
    # Every planted case constrains where the diff may land.
    assert all(c.objective.constraints.target_paths for c in cases)


def test_optimize_corpus_constraints_are_typed():
    _, cases = load_corpus(CORPUS)
    first = cases[0]
    assert first.objective.constraints.bench_command is not None
    assert first.objective.constraints.target_paths == ["src/billing/**"]
