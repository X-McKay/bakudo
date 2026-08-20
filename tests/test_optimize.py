"""The optimize slice: graders, suite selection, and the fan-out/selection
logic behind OptimizationWorkflow (all pure, no Temporal worker needed)."""

from __future__ import annotations

from bakudo.control.optimize import (
    attempt_objective,
    round_feedback,
    scout_objective,
    select_winner,
)
from bakudo.curriculum.objective import Objective
from bakudo.evals import (
    EvalContext,
    run_suite,
    suite_for,
)
from bakudo.evals.corpus import EvalCase, OutcomeConstraints
from bakudo.performance.models import (
    IntegrityResult,
    MetricComparison,
    PerformanceComparison,
    RecordStatus,
    Verdict,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin
from bakudo.performance.revisions import sha256_text
from bakudo.runner.result import RunResult

DIGEST = "sha256:" + "0" * 64
PATCH = "diff --git a/x.py b/x.py\n+faster\n"


def performance_contract() -> dict:
    return {
        "workloadRef": {
            "name": "invoice-listing",
            "version": "1.0.0",
            "source": "repository",
        },
        "primaryMetric": "latency_seconds",
        "decisionPolicy": {
            "confidence": 0.95,
            "minimumRelativeImprovement": 0.05,
            "protectedMetrics": ["peak_rss_bytes"],
            "bootstrapResamples": 10000,
        },
    }


def workload_pin() -> dict:
    return {
        "sourceURI": "file:///repo/.bakudo/workloads",
        "sourceKind": "repository",
        "collectionRevision": "base",
        "name": "invoice-listing",
        "version": "1.0.0",
        "manifestDigest": DIGEST,
        "bundleDigest": DIGEST,
    }


def make_objective(**overrides) -> Objective:
    data = {
        "type": "optimize",
        "repo": "payments-api",
        "title": "Optimize invoice listing",
        "performance": performance_contract(),
        "constraints": {
            "maxFilesChanged": 4,
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


# --- graders ---


def test_optimize_suite_does_not_trust_candidate_reported_performance():
    assert suite_for("optimize") == suite_for("add-feature")

    results = run_suite(
        EvalContext(
            result=make_result({"claimed_speedup": 1000.0}),
            objective=make_objective(),
        )
    )
    assert "perf" not in {result.suite_name for result in results}
    assert {result.suite_name for result in results} >= {"schema", "safety", "code"}


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
    assert "independent" in obj["description"]
    assert "self-measured timing or complexity deltas" in obj["description"]


def test_optimize_requires_structured_performance_contract_without_legacy_aliases():
    value = make_objective().to_dict()
    value.pop("performance")
    try:
        Objective.model_validate(value)
    except ValueError as exc:
        assert "performance contract" in str(exc)
    else:
        raise AssertionError("optimize objective unexpectedly accepted no performance")

    value = make_objective().to_dict()
    value["constraints"]["benchCommand"] = "python benchmark.py"
    try:
        Objective.model_validate(value)
    except ValueError as exc:
        assert "benchCommand" in str(exc)
    else:
        raise AssertionError("legacy benchCommand unexpectedly accepted")


def test_performance_contract_preserves_and_validates_provenance():
    performance = performance_contract()
    performance.update(
        {
            "workloadPin": workload_pin(),
            "comparisonId": "comparison_01K2TEST000000000000000000",
            "regressionSignalId": "regression_01K2TEST000000000000000000",
        }
    )
    objective = make_objective(performance=performance)
    objective.validate_against_schema()
    serialized = objective.to_dict()["performance"]
    assert serialized["workloadPin"]["collectionRevision"] == "base"
    assert serialized["comparisonId"].startswith("comparison_")

    performance["workloadPin"] = {**workload_pin(), "version": "2.0.0"}
    try:
        make_objective(performance=performance)
    except ValueError as exc:
        assert "must match workloadRef" in str(exc)
    else:
        raise AssertionError("mismatched workload provenance unexpectedly accepted")


# --- winner selection ---


def candidate(
    *,
    run_id: str = "run-a",
    overall: float = 0.8,
    effect: float = 0.20,
    simplicity: float = 0.5,
    passed=("schema", "safety", "task", "code", "simplicity"),
    safety_regressions: int = 0,
    critical_failures: int = 0,
    status: str = "success",
    changed_files: int = 2,
) -> dict:
    comparison = _performance_comparison(PATCH, effect=effect)
    return {
        "run_id": run_id,
        "git_branch": f"bakudo/{run_id}",
        "diff": PATCH,
        "performance_comparison": comparison.to_dict(),
        "result": {
            "status": status,
            "summary": f"attempt {run_id}",
            "changed_files": [f"src/f{i}.py" for i in range(changed_files)],
        },
        "scorecard": {
            "overall_score": overall,
            "suites": {"simplicity": simplicity},
            "passed_suites": list(passed),
            "failed_suites": [],
            "safety_regressions": safety_regressions,
            "critical_failures": critical_failures,
        },
    }


def _performance_comparison(
    patch: str,
    *,
    effect: float = 0.20,
    verdict: Verdict | None = None,
    protected_verdict: Verdict = Verdict.equivalent,
) -> PerformanceComparison:
    workload = WorkloadPin(
        source_uri="file:///repo/.bakudo/workloads",
        source_kind="repository",
        collection_revision="base",
        name="invoice-listing",
        version="1.0.0",
        manifest_digest=DIGEST,
        bundle_digest=DIGEST,
    )
    baseline_revision = RevisionPin(
        repository="payments-api",
        source_uri="file:///repo",
        commit_sha="a" * 40,
        tree_digest=DIGEST,
    )
    candidate_revision = RevisionPin(
        repository="payments-api",
        source_uri="file:///repo",
        commit_sha="a" * 40,
        tree_digest=DIGEST,
        base_commit_sha="a" * 40,
        patch_digest=sha256_text(patch),
    )
    environment = EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="1.0.0",
        image_digest=DIGEST,
        profile="python-small",
        hardware_class="test",
        architecture="arm64",
        cpu_count=2,
        memory_mb=512,
        os="linux",
        kernel="6.0",
        dependency_lock_digest=DIGEST,
        environment_digest=DIGEST,
    )
    selected_verdict = verdict or (
        Verdict.improved
        if effect > 0.05
        else Verdict.regressed
        if effect < -0.05
        else Verdict.equivalent
    )
    eligible = selected_verdict is Verdict.improved and protected_verdict is not Verdict.regressed
    primary = MetricComparison(
        metric_name="latency_seconds",
        unit="seconds",
        direction="lower",
        estimator="median",
        baseline_summary=10.0,
        candidate_summary=10.0 * (1 - effect),
        absolute_effect=10.0 * effect,
        relative_effect=effect,
        ci_lower=effect - 0.02,
        ci_upper=effect + 0.02,
        practical_threshold=0.05,
        sample_count=10,
        verdict=selected_verdict,
        valid=True,
    )
    protected = MetricComparison(
        metric_name="peak_rss_bytes",
        unit="bytes",
        direction="lower",
        estimator="median",
        baseline_summary=100.0,
        candidate_summary=100.0,
        absolute_effect=0.0,
        relative_effect=0.0,
        ci_lower=-0.01,
        ci_upper=0.01,
        practical_threshold=0.05,
        sample_count=10,
        verdict=protected_verdict,
        valid=True,
    )
    return PerformanceComparison(
        workload=workload,
        baseline_revision=baseline_revision,
        candidate_revision=candidate_revision,
        baseline_environment=environment,
        candidate_environment=environment,
        baseline_measurement_id="measurement_01K2TEST000000000000000000",
        candidate_measurement_id="measurement_01K2TEST000000000000000001",
        primary_metric="latency_seconds",
        metrics=(primary, protected),
        status=RecordStatus.completed,
        verdict=selected_verdict,
        integrity=IntegrityResult(),
        eligible=eligible,
        analysis_seed=7,
        confidence=0.95,
        bootstrap_resamples=10_000,
    )


def test_select_winner_picks_best_eligible():
    winner = select_winner(
        [
            candidate(run_id="a", overall=0.7, effect=0.10),
            candidate(run_id="b", overall=0.9, effect=0.30),
            candidate(run_id="c", overall=0.8, effect=0.20),
        ],
        performance=performance_contract(),
    )
    assert winner is not None and winner["run_id"] == "b"


def test_select_winner_gates_are_hard():
    performance = performance_contract()
    assert select_winner([candidate(safety_regressions=1)], performance=performance) is None
    assert select_winner([candidate(critical_failures=1)], performance=performance) is None
    assert (
        select_winner([candidate(passed=("schema", "safety", "task"))], performance=performance)
        is None
    )
    assert select_winner([candidate(status="failed")], performance=performance) is None
    assert select_winner([candidate(effect=-0.10)], performance=performance) is None
    assert select_winner([candidate(simplicity=0.3)], performance=performance) is None


def test_select_winner_rejects_missing_trusted_comparison():
    value = candidate()
    value.pop("performance_comparison")
    assert select_winner([value], performance=performance_contract()) is None


def test_select_winner_requires_exact_pinned_workload_when_provided():
    performance = performance_contract()
    performance["workloadPin"] = {**workload_pin(), "collectionRevision": "other"}
    assert select_winner([candidate()], performance=performance) is None


def test_select_winner_prefers_smaller_diff_on_ties():
    winner = select_winner(
        [
            candidate(run_id="big", overall=0.8, changed_files=6),
            candidate(run_id="small", overall=0.8, changed_files=2),
        ],
        performance=performance_contract(),
    )
    assert winner is not None and winner["run_id"] == "small"


def test_select_winner_none_when_empty():
    assert select_winner([], performance=performance_contract()) is None


def test_round_feedback_names_each_failure():
    feedback = round_feedback(
        [
            candidate(run_id="a", status="failed"),
            candidate(run_id="b", simplicity=0.3),
            candidate(run_id="c"),  # eligible — produces no feedback line
        ]
    )
    assert len(feedback) == 2
    assert any("failed" in line for line in feedback)
    assert any("regressed" in line for line in feedback)


# --- corpus ---
#
# The optimize role does not yet have a task-backed environment. Keep its
# decoy-churn regression coverage as an explicit, Python-built unit-test corpus
# until that environment exists.


def _optimize_cases(n_planted: int = 20, n_decoys: int = 5) -> list[EvalCase]:
    """Build N "planted" cases (a real inefficiency to fix) plus M
    "decoy" cases (already optimal -- any change is churn, ``maxChangedFiles``
    == 0), each constraining the diff to one ``targetPaths`` glob."""
    cases: list[EvalCase] = []
    for i in range(n_planted):
        cases.append(
            EvalCase(
                name=f"planted-{i}",
                objective=Objective(
                    type="optimize",
                    repo="payments-api",
                    title=f"Optimize hot path {i}",
                    performance=performance_contract(),
                    constraints={
                        "maxFilesChanged": 4,
                        "targetPaths": [f"src/billing/mod_{i}/**"],
                    },
                ),
                constraints=OutcomeConstraints(
                    allowed_change_paths=[f"src/billing/mod_{i}/x.py"], max_changed_files=4
                ),
            )
        )
    for i in range(n_decoys):
        cases.append(
            EvalCase(
                name=f"decoy-{i}",
                objective=Objective(
                    type="optimize",
                    repo="payments-api",
                    title=f"Already-optimal path {i}",
                    performance=performance_contract(),
                    constraints={
                        "maxFilesChanged": 0,
                        "targetPaths": [f"src/billing/decoy_{i}/**"],
                    },
                ),
                constraints=OutcomeConstraints(allowed_change_paths=[], max_changed_files=0),
            )
        )
    return cases


def test_optimize_corpus_loads_and_validates():
    from bakudo.evals.promotion import PromotionPolicy

    cases = _optimize_cases()
    # The corpus must be large enough for promotion decisions to be eligible.
    assert len(cases) >= PromotionPolicy().min_eval_cases
    assert len({c.name for c in cases}) == len(cases), "case names must be unique"
    for case in cases:
        case.objective.validate_against_schema()

    decoys = [c for c in cases if c.constraints.max_changed_files == 0]
    assert len(decoys) == 5, "the corpus must reward leaving optimal code alone"
    planted = [c for c in cases if (c.constraints.max_changed_files or 0) > 0]
    assert len(planted) == 20
    assert all(c.constraints.allowed_change_paths for c in planted)
    # Every planted case constrains where the diff may land.
    assert all(c.objective.constraints.target_paths for c in cases)


def test_optimize_corpus_constraints_are_typed():
    cases = _optimize_cases()
    first = cases[0]
    assert first.objective.performance is not None
    assert first.objective.performance.workload_ref.ref == "invoice-listing@1.0.0"
    assert first.objective.constraints.target_paths == ["src/billing/mod_0/**"]


# --- OPT-4: the decoy guarantee is real — churn blocks promotion ---


def _corpus_run_fn(*, churn_decoys: bool):
    """A candidate that always changes the first targeted path — including on
    decoy cases (maxChangedFiles: 0) when ``churn_decoys`` is set."""
    from bakudo.evals.corpus import CaseRun

    def run_fn(objective):
        target = objective.constraints.target_paths[0]
        decoy = objective.constraints.max_files_changed == 0
        changed = [] if (decoy and not churn_decoys) else [target.replace("**", "x.py")]
        result = RunResult.model_validate(
            {
                "run_id": "run_D",
                "agent": "optimize-attempt@2",
                "objective_id": objective.id,
                "status": "success",
                "summary": "attempted",
                "changed_files": changed,
                "tests_run": [{"command": "pytest", "status": "passed"}],
            }
        )
        return CaseRun(result=result)

    return run_fn


def test_decoy_churning_candidate_is_rejected():
    """An optimizer that manufactures churn on already-optimal decoys must be
    blocked: role-specific/regression are REQUIRED suites now (OPT-4)."""
    from bakudo.evals import Scorecard, decide
    from bakudo.evals.corpus import run_corpus
    from bakudo.evals.promotion import Decision

    cases = _optimize_cases()
    results = run_corpus(
        "optimize-regression",
        cases,
        _corpus_run_fn(churn_decoys=True),
        subject_id="optimize-attempt@2",
    )
    card = Scorecard.from_results(results)
    assert "role-specific" in card.failed_suites

    decision = decide(card, None)
    assert decision.decision is Decision.reject
    assert "role-specific" in decision.rationale


def test_decoy_respecting_candidate_is_eligible():
    """The same candidate that leaves decoys untouched clears the gates."""
    from bakudo.evals import Scorecard, decide
    from bakudo.evals.corpus import run_corpus
    from bakudo.evals.promotion import Decision

    cases = _optimize_cases()
    results = run_corpus(
        "optimize-regression",
        cases,
        _corpus_run_fn(churn_decoys=False),
        subject_id="optimize-attempt@2",
    )
    card = Scorecard.from_results(results)
    decision = decide(card, None)
    assert decision.decision is Decision.canary, decision.rationale


def test_scout_objective_exposes_only_sanitized_workload_identity():
    from bakudo.control.optimize import scout_objective

    obj = scout_objective(
        {
            "title": "t",
            "description": "d",
            "constraints": {},
            "performance": performance_contract(),
        }
    )
    assert "invoice-listing@1.0.0" in obj["description"]
    assert "privileged workload" in obj["description"].lower()
