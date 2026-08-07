"""Phase 3: harness-measured metrics, the sandbox/regression eval levels,
the FauxDriver, and the executable corpus harness."""

from pathlib import Path

import pytest

from bakudo.abox.local import _git_init, local_sandbox
from bakudo.agent_spec import load_spec_file
from bakudo.bundle import Budget, TaskBundle
from bakudo.control import run_objective
from bakudo.curriculum import Objective
from bakudo.evals import EvalContext, sandbox_eval
from bakudo.evals.corpus import CorpusReport, EvalCase, Expectations, run_corpus_report
from bakudo.evals.evolution import regression_result
from bakudo.evals.harness import make_fixture_case_runner
from bakudo.evals.measure import (
    Measurements,
    apply_measurements,
    complexity_of_source,
    measure_complexity,
    time_command,
)
from bakudo.paths import agents_dir
from bakudo.registry import RunPhase
from bakudo.runner.result import RunResult
from bakudo.testing import FauxDriver, FauxRun

FIXTURE = Path(__file__).resolve().parents[1] / "evals" / "fixtures" / "payments-api"


def _objective(**overrides) -> Objective:
    doc = {
        "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ8",
        "type": "explore",
        "repo": "payments-api",
        "title": "phase-3 scenario",
    }
    doc.update(overrides)
    return Objective.model_validate(doc)


def _result(**overrides) -> RunResult:
    doc = {
        "run_id": "run_X", "agent": "a@1", "objective_id": "obj_X",
        "status": "success", "summary": "ok",
    }
    doc.update(overrides)
    return RunResult.model_validate(doc)


# --- measurement primitives ---

def test_time_command_measures_and_flags_failures(tmp_path):
    ok = time_command("python -c pass", tmp_path, runs=2, warmup=0)
    assert ok.ok and ok.median_seconds > 0 and len(ok.runs) == 2

    bad = time_command("python -c 'raise SystemExit(3)'", tmp_path, runs=2)
    assert not bad.ok


def test_time_command_warmup_discards_first_run(tmp_path):
    measured = time_command("python -c pass", tmp_path, runs=2, warmup=1)
    assert measured.ok and len(measured.runs) == 2  # warm-up not among samples


def test_complexity_is_deterministic_and_branch_weighted():
    simple = complexity_of_source("x = 1\ny = 2\n")
    branchy = complexity_of_source("if x:\n    y = 1\nelse:\n    y = 2\n")
    assert simple == 2.0
    assert branchy > simple
    assert complexity_of_source("# only a comment\n") == 0.0


def test_measure_complexity_matches_globs(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("if x:\n    y = 1\n")
    total = measure_complexity(tmp_path, ["src/**"])
    assert total is not None and total > 0
    assert measure_complexity(tmp_path, ["nothing/**"]) is None


def test_apply_measurements_overrides_agent_claims():
    result = _result(
        metrics={"bench_seconds_before": 100.0, "bench_seconds_after": 1.0}
    )
    apply_measurements(
        result,
        Measurements(bench_seconds=2.0),
        Measurements(bench_seconds=1.9),
    )
    assert result.metrics["bench_seconds_before"] == 2.0
    assert result.metrics["bench_seconds_after"] == 1.9
    assert result.metrics["harness_measured"] == 1.0


def test_apply_measurements_drops_half_measured_pairs():
    result = _result(metrics={"bench_seconds_before": 100.0})
    apply_measurements(result, Measurements(bench_seconds=2.0), Measurements())
    assert "bench_seconds_before" not in result.metrics
    assert "harness_measured" not in result.metrics


def test_local_sandbox_measures_when_constraints_declare(tmp_path):
    workdir = tmp_path / "repo"
    workdir.mkdir()
    (workdir / "hot.py").write_text("total = 0\nfor i in range(3):\n    total += i\n")
    _git_init(workdir)

    spec = load_spec_file(agents_dir() / "explore.yaml")
    objective = _objective(
        constraints={"benchCommand": "python -c pass", "targetPaths": ["*.py"]}
    )
    bundle = TaskBundle(
        run_id="run_01HZZZZZZZZZZZZZZZZZZZZZZM",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=60),
    )
    outcome = local_sandbox(
        bundle,
        offline_driver=lambda s, u, t: '{"status": "success", "summary": "ok"}',
        workspace_root=workdir,
    )
    metrics = outcome.result["metrics"]
    assert metrics["harness_measured"] == 1.0
    assert metrics["bench_seconds_before"] > 0
    assert metrics["complexity_before"] == metrics["complexity_after"] > 0


# --- sandbox + regression eval levels ---

def test_sandbox_eval_fails_on_budget_violation():
    ctx = EvalContext(
        result=_result(blocked_reasons=["sandbox_budget:changed_files 9 > 2"]),
        objective=_objective(),
    )
    res = sandbox_eval(ctx)
    assert not res.passed and res.score == 0.0

    clean = sandbox_eval(EvalContext(result=_result(), objective=_objective()))
    assert clean.passed


def _report(passes: dict[str, bool]) -> CorpusReport:
    return CorpusReport(results=[], case_passes=dict(passes))


def test_regression_result_flags_newly_failing_cases():
    baseline = _report({"a": True, "b": True, "c": False})
    candidate = _report({"a": True, "b": False, "c": True})
    res = regression_result(baseline, candidate, subject_id="x@2", cases_total=3)
    assert not res.passed
    assert res.details["regressed_cases"] == ["b"]
    assert res.score == 0.5  # one of two baseline-passing cases regressed


def test_regression_result_passes_when_nothing_regresses():
    baseline = _report({"a": True, "b": False})
    candidate = _report({"a": True, "b": False})
    res = regression_result(baseline, candidate, subject_id="x@2", cases_total=2)
    assert res.passed and res.score == 1.0


# --- FauxDriver end-to-end ---

def test_faux_driver_plays_runs_in_order_and_repeats_last():
    spec = load_spec_file(agents_dir() / "explore.yaml")
    driver = FauxDriver([FauxRun(summary="first"), FauxRun(summary="second")])
    bundle = TaskBundle(
        run_id="run_1", objective_id="obj_1", objective=_objective(), agent_spec=spec
    )
    assert driver(bundle).result["summary"] == "first"
    assert driver(bundle).result["summary"] == "second"
    assert driver(bundle).result["summary"] == "second"
    assert len(driver.calls) == 3


def test_faux_driver_through_full_pipeline():
    spec = load_spec_file(agents_dir() / "add-feature.yaml")
    driver = FauxDriver(
        [FauxRun(changed_files=["src/a.py"], tests=[("pytest -q", "passed")])]
    )
    pipeline = run_objective(_objective(type="add-feature"), spec, sandbox=driver)
    assert pipeline.phase is RunPhase.completed
    assert pipeline.scorecard is not None
    assert "sandbox" in pipeline.scorecard.passed_suites


def test_faux_driver_budget_violation_fails_run():
    spec = load_spec_file(agents_dir() / "add-feature.yaml")  # maxChangedFiles: 8
    driver = FauxDriver([FauxRun(changed_files=[f"f{i}.py" for i in range(9)])])
    pipeline = run_objective(_objective(type="add-feature"), spec, sandbox=driver)
    assert pipeline.phase is RunPhase.failed
    assert any(
        r.startswith("sandbox_budget:") for r in pipeline.outcome.result["blocked_reasons"]
    )


# --- the corpus fixture and harness ---

def test_fixture_exists_with_all_referenced_modules():
    from bakudo.evals.corpus import load_corpus

    _, cases = load_corpus(Path("evals/corpora/optimize.yaml"))
    missing = []
    for case in cases:
        for pattern in case.objective.constraints.target_paths or []:
            probe = pattern.replace("**", "*")
            if not list(FIXTURE.glob(probe)):
                missing.append((case.name, pattern))
    assert not missing, f"corpus targets without fixture files: {missing}"


def test_fixture_case_runner_executes_a_case(tmp_path):
    spec = load_spec_file(agents_dir() / "optimize-attempt.yaml")
    case = EvalCase(
        name="complexity-only",
        objective=_objective(
            type="optimize",
            constraints={"targetPaths": ["src/refunds/eligibility.py"]},
        ),
        expect=Expectations(status="success"),
    )
    run_fn = make_fixture_case_runner(
        spec,
        FIXTURE,
        offline_driver=lambda s, u, t: '{"status": "success", "summary": "reviewed"}',
    )
    report = run_corpus_report(
        "phase3-smoke", [case], run_fn, subject_id=spec.ref
    )
    assert report.case_passes == {"complexity-only": True}
    suites = {r.suite_name for r in report.results}
    assert {"schema", "safety", "sandbox", "role-specific"} <= suites


def test_fixture_case_runner_rejects_missing_fixture(tmp_path):
    spec = load_spec_file(agents_dir() / "optimize-attempt.yaml")
    with pytest.raises(FileNotFoundError):
        make_fixture_case_runner(spec, tmp_path / "nope")
