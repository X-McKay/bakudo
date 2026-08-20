from __future__ import annotations

from datetime import UTC, datetime

import pytest

from bakudo.performance.measurement import (
    MeasurementRequest,
    SyntheticMeasurementRunner,
    SyntheticMeasurementScript,
    build_metric_sample_set,
    metric_sample_sets_from_invocations,
    validate_warmups,
)
from bakudo.performance.models import (
    FailureReason,
    InvocationOutcome,
    InvocationPhase,
    MeasurementPlan,
    MetricDefinition,
    MetricDirection,
    MetricEstimator,
    MetricSource,
    MetricUnit,
    MetricValue,
    RecordStatus,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin

_DIGEST = "sha256:" + "1" * 64


def _metric(
    name: str = "latency_seconds",
    *,
    unit: MetricUnit = MetricUnit.seconds,
    estimator: MetricEstimator = MetricEstimator.median,
    minimum_samples: int = 1,
) -> MetricDefinition:
    return MetricDefinition(
        name=name,
        unit=unit,
        direction=MetricDirection("lower"),
        source=MetricSource.wall_clock,
        estimator=estimator,
        practical_threshold=0.05,
        minimum_samples=minimum_samples,
    )


def _plan(*, warmups: int = 1, repetitions: int = 3) -> MeasurementPlan:
    return MeasurementPlan(
        warmups=warmups,
        repetitions=repetitions,
        timeout_seconds=10,
        schedule="randomized-pairs",
        metrics=(_metric(),),
    )


def _workload_pin() -> WorkloadPin:
    return WorkloadPin(
        source_uri="repo://example",
        source_kind="repository",
        collection_revision="a" * 40,
        name="latency",
        version="1.0.0",
        manifest_digest=_DIGEST,
        bundle_digest=_DIGEST,
    )


def _revision_pin() -> RevisionPin:
    return RevisionPin(
        repository="example",
        source_uri="repo://example",
        commit_sha="a" * 40,
        tree_digest=_DIGEST,
    )


def _environment_pin() -> EnvironmentPin:
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


def test_valid_samples_compute_declared_summary_and_dispersion() -> None:
    sample_set = build_metric_sample_set(_metric(), [1.0, 3.0, 2.0], expected_count=3)

    assert sample_set.valid
    assert sample_set.samples == (1.0, 3.0, 2.0)
    assert sample_set.summary == 2.0
    assert sample_set.dispersion == 1.0
    assert sample_set.invalid_sample_count == 0


@pytest.mark.parametrize("invalid", [None, "1.0", True, float("nan"), float("inf")])
def test_invalid_sample_makes_entire_set_ineligible(invalid: object) -> None:
    sample_set = build_metric_sample_set(_metric(), [1.0, invalid, 0.5], expected_count=3)

    assert not sample_set.valid
    assert sample_set.summary is None
    assert sample_set.dispersion is None
    assert sample_set.invalid_sample_count == 1
    assert sample_set.invalid_reasons


def test_missing_samples_are_not_silently_dropped() -> None:
    sample_set = build_metric_sample_set(_metric(), [0.9, 0.8], expected_count=3)

    assert not sample_set.valid
    assert sample_set.invalid_sample_count == 1
    assert sample_set.invalid_reasons == ("expected 3 samples, received 2",)


@pytest.mark.parametrize(
    ("estimator", "count"),
    [(MetricEstimator.p95, 19), (MetricEstimator.p99, 99)],
)
def test_tail_percentiles_require_at_least_one_tail_observation(
    estimator: MetricEstimator, count: int
) -> None:
    sample_set = build_metric_sample_set(
        _metric(estimator=estimator), [1.0] * count, expected_count=count
    )

    assert not sample_set.valid
    assert sample_set.summary is None
    assert estimator.value in sample_set.invalid_reasons[0]


def test_invocation_collection_rejects_unit_mismatch_and_undeclared_metrics() -> None:
    plan = _plan(warmups=0, repetitions=1)
    wrong_unit = InvocationOutcome(
        ordinal=0,
        phase=InvocationPhase.measured,
        status=RecordStatus.completed,
        metrics=(MetricValue(name="latency_seconds", unit=MetricUnit.bytes, value=2.0),),
    )
    sample_set = metric_sample_sets_from_invocations(plan, (wrong_unit,))[0]
    assert not sample_set.valid
    assert "expected seconds" in sample_set.invalid_reasons[0]

    undeclared = wrong_unit.model_copy(
        update={"metrics": (MetricValue(name="query_count", unit=MetricUnit("count"), value=1.0),)}
    )
    with pytest.raises(ValueError, match="undeclared metrics: query_count"):
        metric_sample_sets_from_invocations(plan, (undeclared,))


def test_invocation_collection_requires_canonical_ordinal_order() -> None:
    plan = _plan(warmups=0, repetitions=2)
    outcomes = tuple(
        InvocationOutcome(
            ordinal=ordinal,
            phase=InvocationPhase.measured,
            status=RecordStatus.completed,
            metrics=(
                MetricValue(
                    name="latency_seconds",
                    unit=MetricUnit.seconds,
                    value=float(ordinal + 1),
                ),
            ),
        )
        for ordinal in (1, 0)
    )

    sample_set = metric_sample_sets_from_invocations(plan, outcomes)[0]

    assert not sample_set.valid
    assert "position 0 has ordinal 1" in " ".join(sample_set.invalid_reasons)


def test_warmup_validation_is_separate_from_measured_samples() -> None:
    plan = _plan(warmups=1, repetitions=1)
    warmup = InvocationOutcome(
        ordinal=0,
        phase=InvocationPhase.warmup,
        status=RecordStatus.failed,
        failure_reason=FailureReason.workload,
    )

    assert validate_warmups(plan, (warmup,)) == ("warmup 0 ended with failed",)


def test_synthetic_runner_is_fixed_and_idempotent() -> None:
    plan = _plan()
    request = MeasurementRequest(
        idempotency_key="baseline",
        workload=_workload_pin(),
        revision=_revision_pin(),
        environment=_environment_pin(),
        plan=plan,
        plan_digest=_DIGEST,
    )
    runner = SyntheticMeasurementRunner(
        {
            "baseline": SyntheticMeasurementScript(
                metric_samples={"latency_seconds": [3.0, 2.0, 1.0]}
            )
        },
        clock=lambda: datetime(2026, 8, 17, tzinfo=UTC),
        id_factory=lambda: "measurement_" + "0" * 26,
    )

    first = runner.measure(request)
    second = runner.measure(request)

    assert first is second
    assert first.status is RecordStatus.completed
    assert first.metrics[0].summary == 2.0
    assert len(first.warmups) == 1
    assert len(first.invocations) == 3
    assert all(outcome.phase is InvocationPhase.measured for outcome in first.invocations)

    changed = MeasurementRequest(
        idempotency_key="baseline",
        workload=request.workload,
        revision=request.revision,
        environment=request.environment,
        plan=request.plan,
        plan_digest="sha256:" + "2" * 64,
    )
    with pytest.raises(ValueError, match="reused with a different"):
        runner.measure(changed)


def test_synthetic_failure_script_produces_inconclusive_invalid_evidence() -> None:
    plan = _plan(warmups=0, repetitions=3)
    request = MeasurementRequest(
        idempotency_key="timeout",
        workload=_workload_pin(),
        revision=_revision_pin(),
        environment=_environment_pin(),
        plan=plan,
        plan_digest=_DIGEST,
    )
    runner = SyntheticMeasurementRunner(
        {
            "timeout": SyntheticMeasurementScript(
                metric_samples={"latency_seconds": [1.0, 0.1, 0.1]},
                invocation_failures={0: FailureReason.timeout},
            )
        }
    )

    record = runner.measure(request)

    assert record.status is RecordStatus.inconclusive
    assert record.invocations[0].status is RecordStatus.timed_out
    assert not record.metrics[0].valid
    assert record.metrics[0].summary is None
