from __future__ import annotations

from datetime import UTC, datetime, timedelta

from bakudo.curriculum.collectors import (
    CompositeCollector,
    PerformanceRegressionCollector,
)
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
    RegressionPolicy,
)

_DIGEST = "sha256:" + "c" * 64
_NOW = datetime(2026, 8, 17, 12, tzinfo=UTC)


def _workload(name: str = "latency") -> WorkloadPin:
    digest = _DIGEST if name == "latency" else "sha256:" + "d" * 64
    return WorkloadPin(
        source_uri="repo://workloads",
        source_kind="repository",
        collection_revision="main",
        name=name,
        version="1.0.0",
        manifest_digest=digest,
        bundle_digest=digest,
    )


def _revision(commit: str) -> RevisionPin:
    return RevisionPin(
        repository="demo",
        source_uri="repo://demo",
        commit_sha=commit * 40,
        tree_digest="sha256:" + commit * 64,
    )


def _environment() -> EnvironmentPin:
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
    )


def _comparison(ordinal: int, workload: WorkloadPin | None = None) -> PerformanceComparison:
    selected = workload or _workload()
    metric = MetricComparison(
        metric_name="latency_seconds",
        unit=MetricUnit.seconds,
        direction=MetricDirection.lower_is_better,
        estimator=MetricEstimator.median,
        baseline_summary=10,
        candidate_summary=12,
        absolute_effect=2,
        relative_effect=-0.2,
        ci_lower=-0.22,
        ci_upper=-0.18,
        practical_threshold=0.05,
        sample_count=10,
        verdict=Verdict.regressed,
        valid=True,
    )
    return PerformanceComparison(
        id="comparison_" + str(ordinal) * 26,
        created_at=_NOW + timedelta(minutes=ordinal),
        workload=selected,
        baseline_revision=_revision("1"),
        candidate_revision=_revision("2"),
        baseline_environment=_environment(),
        candidate_environment=_environment(),
        baseline_measurement_id="measurement_" + "1" * 26,
        candidate_measurement_id="measurement_" + "2" * 26,
        primary_metric="latency_seconds",
        metrics=(metric,),
        status=RecordStatus.completed,
        verdict=Verdict.regressed,
        integrity=IntegrityResult(),
        eligible=False,
        analysis_seed=1,
        confidence=0.95,
        bootstrap_resamples=1_000,
    )


class _Source:
    def __init__(self, comparisons: list[PerformanceComparison]) -> None:
        self.comparisons = comparisons

    def list_performance_comparisons(
        self,
        repository: str | None = None,
        workload_ref: str | None = None,
    ) -> list[PerformanceComparison]:
        return [
            comparison
            for comparison in self.comparisons
            if (repository is None or comparison.baseline_revision.repository == repository)
            and (workload_ref is None or comparison.workload.ref == workload_ref)
        ]


def _approval(workload: WorkloadPin | None = None) -> ApprovedWorkload:
    return ApprovedWorkload(
        pin=workload or _workload(),
        baseline_policy="pinned-release:v1",
        baseline_commit_shas=("1" * 40,),
    )


def _policy(*, max_active: int = 1) -> RegressionPolicy:
    return RegressionPolicy(
        minimum_relative_regression=0.05,
        recovery_relative_threshold=0.02,
        minimum_samples=5,
        consecutive_observations=2,
        cooldown=timedelta(hours=1),
        max_active_signals_per_repository=max_active,
    )


def test_collector_orders_comparisons_and_emits_once_across_cycles() -> None:
    source = _Source([_comparison(2), _comparison(1)])
    collector = PerformanceRegressionCollector(
        source,
        [_approval()],
        policy=_policy(),
        clock=lambda: _NOW + timedelta(hours=1),
        hotspot_lookup=lambda comparison: f"hotspot:{comparison.id}",
    )

    first = collector.collect("demo")
    second = collector.collect("demo")

    assert len(first.performance_regressions) == 1
    assert first.performance_regressions[0].comparison_id == _comparison(2).id
    assert first.performance_regressions[0].top_hotspot_key == f"hotspot:{_comparison(2).id}"
    assert second.performance_regressions == []
    assert {
        decision.reason for decision in collector.last_decisions
    } == {RegressionDecisionReason.duplicate_observation}


def test_one_off_regression_is_pending_and_composite_preserves_signal_type() -> None:
    source = _Source([_comparison(1)])
    collector = PerformanceRegressionCollector(
        source,
        [_approval()],
        policy=_policy(),
        clock=lambda: _NOW,
    )
    first = collector.collect("demo")
    assert first.performance_regressions == []
    assert collector.last_decisions[0].reason is RegressionDecisionReason.pending

    source.comparisons.append(_comparison(2))
    merged = CompositeCollector([collector]).collect("demo")
    assert len(merged.performance_regressions) == 1
    assert merged.performance_regressions[0].kind == "PerformanceRegressionSignal"


def test_repository_active_signal_cap_suppresses_second_workload() -> None:
    other = _workload("throughput")
    source = _Source(
        [_comparison(1), _comparison(2), _comparison(3, other), _comparison(4, other)]
    )
    collector = PerformanceRegressionCollector(
        source,
        [_approval(), _approval(other)],
        policy=_policy(max_active=1),
        clock=lambda: _NOW,
    )

    signals = collector.collect("demo").performance_regressions

    assert len(signals) == 1
    assert any(
        decision.reason is RegressionDecisionReason.concurrency_limited
        for decision in collector.last_decisions
    )
