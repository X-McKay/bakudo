from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from bakudo.curriculum import RepoSignals, generate_objectives
from bakudo.curriculum.objective import ObjectiveType
from bakudo.performance.models import (
    EnvironmentPin,
    IntegrityResult,
    MetricComparison,
    MetricDirection,
    MetricEstimator,
    MetricUnit,
    PerformanceComparison,
    RecordStatus,
    Verdict,
)
from bakudo.performance.pins import RevisionPin, WorkloadPin
from bakudo.performance.regressions import (
    ApprovedWorkload,
    RegressionDecisionReason,
    RegressionPhase,
    RegressionPolicy,
    evaluate_regression,
    objective_input_from_signal,
    regression_deduplication_key,
)

_DIGEST = "sha256:" + "a" * 64
_START = datetime(2026, 8, 17, 12, tzinfo=UTC)


def _workload(name: str = "latency") -> WorkloadPin:
    return WorkloadPin(
        source_uri="repo://workloads",
        source_kind="repository",
        collection_revision="main",
        name=name,
        version="1.0.0",
        manifest_digest=_DIGEST,
        bundle_digest=_DIGEST if name == "latency" else "sha256:" + "b" * 64,
    )


def _revision(commit: str) -> RevisionPin:
    return RevisionPin(
        repository="demo",
        source_uri="repo://demo",
        commit_sha=commit * 40,
        tree_digest="sha256:" + commit * 64,
    )


def _environment(*, profiled: bool = False) -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.2",
        image_digest=_DIGEST,
        profile="python-small",
        hardware_class="test",
        architecture="arm64",
        cpu_count=1,
        memory_mb=512,
        os="linux",
        kernel="test",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
        profiler_adapter="synthetic" if profiled else None,
        profiler_version="1" if profiled else None,
    )


def _comparison(
    ordinal: int,
    *,
    verdict: Verdict = Verdict.regressed,
    relative_effect: float = -0.2,
    confidence: float = 0.95,
    samples: int = 10,
    workload: WorkloadPin | None = None,
    status: RecordStatus = RecordStatus.completed,
    valid: bool = True,
    profiled: bool = False,
    direction: MetricDirection = MetricDirection.lower_is_better,
) -> PerformanceComparison:
    metric = MetricComparison(
        metric_name="latency_seconds",
        unit=MetricUnit.seconds,
        direction=direction,
        estimator=MetricEstimator.median,
        baseline_summary=10,
        candidate_summary=12,
        absolute_effect=2,
        relative_effect=relative_effect,
        ci_lower=relative_effect - 0.02,
        ci_upper=relative_effect + 0.02,
        practical_threshold=0.05,
        sample_count=samples,
        verdict=verdict,
        valid=valid,
        reasons=() if valid else ("invalid samples",),
    )
    return PerformanceComparison(
        id="comparison_" + str(ordinal % 10) * 26,
        created_at=_START + timedelta(minutes=ordinal),
        workload=workload or _workload(),
        baseline_revision=_revision("1"),
        candidate_revision=_revision("2"),
        baseline_environment=_environment(profiled=profiled),
        candidate_environment=_environment(profiled=profiled),
        baseline_measurement_id="measurement_" + "1" * 26,
        candidate_measurement_id="measurement_" + "2" * 26,
        primary_metric="latency_seconds",
        metrics=(metric,),
        status=status,
        verdict=verdict,
        integrity=IntegrityResult(),
        eligible=False,
        analysis_seed=1,
        confidence=confidence,
        bootstrap_resamples=1_000,
    )


def _approval() -> ApprovedWorkload:
    return ApprovedWorkload(
        pin=_workload(),
        baseline_policy="pinned-release:v1",
        baseline_commit_shas=("1" * 40,),
        criticality=0.9,
    )


def _policy(**changes: object) -> RegressionPolicy:
    values = {
        "minimum_relative_regression": 0.05,
        "recovery_relative_threshold": 0.02,
        "minimum_confidence": 0.95,
        "minimum_samples": 5,
        "consecutive_observations": 2,
        "cooldown": timedelta(hours=1),
    }
    values.update(changes)
    return RegressionPolicy(**values)  # type: ignore[arg-type]


def test_two_consecutive_regressions_emit_one_deterministic_signal() -> None:
    first = evaluate_regression(_comparison(1), _approval(), _policy(), observed_at=_START)
    second = evaluate_regression(
        _comparison(2),
        _approval(),
        _policy(),
        state=first.state,
        observed_at=_START,
    )
    replay = evaluate_regression(
        _comparison(2),
        _approval(),
        _policy(),
        state=first.state,
        observed_at=_START,
    )

    assert first.reason is RegressionDecisionReason.pending
    assert second.reason is RegressionDecisionReason.emitted
    assert second.state.phase is RegressionPhase.active
    assert second.signal is not None
    assert second.signal == replay.signal
    assert second.signal.approved
    assert second.signal.relative_regression == pytest.approx(0.2)
    assert second.signal.consecutive_observations == 2

    duplicate = evaluate_regression(
        _comparison(2),
        _approval(),
        _policy(),
        state=second.state,
        observed_at=_START,
    )
    assert duplicate.reason is RegressionDecisionReason.duplicate_observation
    assert duplicate.signal is None


def test_recovery_cooldown_and_inconclusive_hysteresis() -> None:
    pending = evaluate_regression(_comparison(1), _approval(), _policy(), observed_at=_START)
    active = evaluate_regression(
        _comparison(2), _approval(), _policy(), state=pending.state, observed_at=_START
    )
    recovery = evaluate_regression(
        _comparison(
            3,
            verdict=Verdict.equivalent,
            relative_effect=-0.01,
        ),
        _approval(),
        _policy(),
        state=active.state,
        observed_at=_START + timedelta(minutes=10),
    )
    suppressed = evaluate_regression(
        _comparison(4),
        _approval(),
        _policy(),
        state=recovery.state,
        observed_at=_START + timedelta(minutes=20),
    )
    inconclusive = evaluate_regression(
        _comparison(5, verdict=Verdict.inconclusive, relative_effect=-0.03),
        _approval(),
        _policy(),
        state=suppressed.state,
        observed_at=_START + timedelta(minutes=30),
    )

    assert recovery.reason is RegressionDecisionReason.recovered
    assert recovery.state.phase is RegressionPhase.cooldown
    assert suppressed.reason is RegressionDecisionReason.cooling_down
    assert inconclusive.reason is RegressionDecisionReason.inconclusive
    assert inconclusive.state.cooldown_until == _START + timedelta(hours=1, minutes=30)

    after_cooldown = evaluate_regression(
        _comparison(6),
        _approval(),
        _policy(),
        state=inconclusive.state,
        observed_at=_START + timedelta(hours=2),
    )
    emitted_again = evaluate_regression(
        _comparison(7),
        _approval(),
        _policy(),
        state=after_cooldown.state,
        observed_at=_START + timedelta(hours=2),
    )
    assert after_cooldown.reason is RegressionDecisionReason.pending
    assert emitted_again.signal is not None
    assert emitted_again.signal.id != active.signal.id  # type: ignore[union-attr]


@pytest.mark.parametrize(
    ("comparison", "reason"),
    [
        (_comparison(1, workload=_workload("other")), "unapproved-workload"),
        (_comparison(1, confidence=0.90), "insufficient-confidence"),
        (_comparison(1, samples=2), "insufficient-samples"),
        (_comparison(1, valid=False), "invalid-comparison"),
        (_comparison(1, profiled=True), "invalid-comparison"),
        (
            _comparison(1, verdict=Verdict.regressed, relative_effect=-0.04),
            "below-threshold",
        ),
    ],
)
def test_invalid_or_unapproved_evidence_never_emits(
    comparison: PerformanceComparison, reason: str
) -> None:
    decision = evaluate_regression(comparison, _approval(), _policy(), observed_at=_START)

    assert decision.reason.value == reason
    assert decision.signal is None
    assert decision.state.phase is RegressionPhase.clear


@pytest.mark.parametrize(
    "direction", [MetricDirection.lower_is_better, MetricDirection.higher_is_better]
)
def test_direction_normalized_regressions_are_handled_identically(
    direction: MetricDirection,
) -> None:
    decision = evaluate_regression(
        _comparison(1, direction=direction),
        _approval(),
        _policy(consecutive_observations=1),
        observed_at=_START,
    )
    assert decision.signal is not None
    assert decision.signal.relative_regression == pytest.approx(0.2)


def test_hotspot_changes_do_not_change_default_deduplication_key() -> None:
    approval = _approval()
    stable_a = regression_deduplication_key(
        "demo", approval, "latency_seconds", top_hotspot_key="function:a"
    )
    stable_b = regression_deduplication_key(
        "demo", approval, "latency_seconds", top_hotspot_key="function:b"
    )
    split_a = regression_deduplication_key(
        "demo",
        approval,
        "latency_seconds",
        top_hotspot_key="function:a",
        split_by_hotspot=True,
    )
    split_b = regression_deduplication_key(
        "demo",
        approval,
        "latency_seconds",
        top_hotspot_key="function:b",
        split_by_hotspot=True,
    )

    assert stable_a == stable_b
    assert split_a != split_b
    assert "function" not in split_a


def test_signal_maps_to_structured_pinned_objective_input() -> None:
    decision = evaluate_regression(
        _comparison(1),
        _approval(),
        _policy(consecutive_observations=1),
        observed_at=_START,
    )
    assert decision.signal is not None

    objective = objective_input_from_signal(
        decision.signal,
        _approval(),
        _policy(consecutive_observations=1),
        target_paths=("src/hot.py", "src/hot.py"),
        protected_metrics=("peak_rss_bytes",),
    )
    document = objective.to_dict()

    assert document["type"] == "optimize"
    performance = document["performance"]
    assert isinstance(performance, dict)
    workload_pin = performance["workloadPin"]
    evidence = performance["evidence"]
    assert isinstance(workload_pin, dict)
    assert isinstance(evidence, dict)
    assert workload_pin["bundleDigest"] == _DIGEST
    assert evidence["comparisonId"] == decision.signal.comparison_id
    assert document["targetPaths"] == ["src/hot.py"]
    assert set(performance) == {
        "workloadRef",
        "workloadPin",
        "primaryMetric",
        "decisionPolicy",
        "evidence",
    }


def test_approved_input_maps_to_schema_valid_curriculum_objective() -> None:
    approval = _approval()
    policy = _policy(consecutive_observations=1)
    decision = evaluate_regression(
        _comparison(1),
        approval,
        policy,
        observed_at=_START,
    )
    assert decision.signal is not None
    draft = objective_input_from_signal(
        decision.signal,
        approval,
        policy,
        target_paths=("src/hot.py",),
        protected_metrics=("peak_rss_bytes",),
    )

    (objective,) = generate_objectives(
        RepoSignals(repo="demo", performance_regressions=[decision.signal]),
        performance_inputs=(draft,),
    )

    assert objective.type is ObjectiveType.optimize
    assert objective.performance is not None
    assert objective.performance.workload_pin == decision.signal.workload
    assert objective.performance.comparison_id == decision.signal.comparison_id
    assert objective.performance.regression_signal_id == decision.signal.id
    assert objective.constraints.target_paths == ["src/hot.py"]
    assert objective.performance.decision_policy.protected_metrics == ("peak_rss_bytes",)
    objective.validate_against_schema()


def test_curriculum_rejects_orphaned_or_mismatched_performance_input() -> None:
    approval = _approval()
    policy = _policy(consecutive_observations=1)
    decision = evaluate_regression(
        _comparison(1),
        approval,
        policy,
        observed_at=_START,
    )
    assert decision.signal is not None
    draft = objective_input_from_signal(decision.signal, approval, policy)

    with pytest.raises(ValueError, match="no matching observed"):
        generate_objectives(
            RepoSignals(repo="demo"),
            performance_inputs=(draft,),
        )

    with pytest.raises(ValueError, match="does not match"):
        generate_objectives(
            RepoSignals(repo="other", performance_regressions=[decision.signal]),
            performance_inputs=(draft,),
        )
