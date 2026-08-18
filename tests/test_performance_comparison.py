from __future__ import annotations

from collections.abc import Sequence

import pytest

from bakudo.performance.comparison import compare_measurements
from bakudo.performance.compatibility import CompatibilityPolicy
from bakudo.performance.measurement import build_metric_sample_set
from bakudo.performance.models import (
    MeasurementPlan,
    MeasurementRecord,
    MetricDefinition,
    MetricDirection,
    MetricEstimator,
    MetricSampleSet,
    MetricSource,
    MetricUnit,
    RecordStatus,
    Verdict,
    canonical_digest,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin

_DIGEST = "sha256:" + "1" * 64


def _definition(
    name: str = "latency_seconds",
    *,
    direction: MetricDirection = MetricDirection.lower_is_better,
    unit: MetricUnit = MetricUnit.seconds,
    threshold: float = 0.05,
    required: bool = True,
) -> MetricDefinition:
    return MetricDefinition(
        name=name,
        unit=unit,
        direction=direction,
        source=MetricSource.wall_clock,
        estimator=MetricEstimator.mean,
        practical_threshold=threshold,
        required=required,
    )


def _plan(*definitions: MetricDefinition, repetitions: int) -> MeasurementPlan:
    return MeasurementPlan(
        warmups=1,
        repetitions=repetitions,
        timeout_seconds=30,
        schedule="randomized-pairs",
        metrics=definitions,
    )


def _workload_pin(*, suffix: str = "1") -> WorkloadPin:
    digest = "sha256:" + suffix * 64
    return WorkloadPin(
        source_uri="repo://example",
        source_kind="repository",
        collection_revision="a" * 40,
        name="latency",
        version="1.0.0",
        manifest_digest=digest,
        bundle_digest=digest,
    )


def _revision_pin(commit: str) -> RevisionPin:
    return RevisionPin(
        repository="example",
        source_uri="repo://example",
        commit_sha=commit * 40,
        tree_digest="sha256:" + commit * 64,
    )


def _environment_pin(
    *,
    profile: str = "python-small",
    profiler: bool = False,
    bakudo_version: str = "3.0.0",
) -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version=bakudo_version,
        abox_version="0.7.1",
        image_digest=_DIGEST,
        profile=profile,
        hardware_class="test",
        architecture="arm64",
        cpu_count=1,
        memory_mb=512,
        os="linux",
        kernel="test",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
        profiler_adapter="synthetic" if profiler else None,
        profiler_version="1.0.0" if profiler else None,
    )


def _sample_set(definition: MetricDefinition, samples: Sequence[float]) -> MetricSampleSet:
    return build_metric_sample_set(definition, samples, expected_count=len(samples))


def _record(
    record_id: str,
    revision_char: str,
    plan: MeasurementPlan,
    sample_series: Sequence[Sequence[float]],
    *,
    workload: WorkloadPin | None = None,
    environment: EnvironmentPin | None = None,
    plan_digest: str | None = None,
    status: RecordStatus = RecordStatus.completed,
) -> MeasurementRecord:
    return MeasurementRecord(
        id="measurement_" + record_id * 26,
        workload=workload or _workload_pin(),
        revision=_revision_pin(revision_char),
        environment=environment or _environment_pin(),
        plan_digest=plan_digest or canonical_digest(plan),
        metrics=tuple(
            _sample_set(definition, samples)
            for definition, samples in zip(plan.metrics, sample_series, strict=True)
        ),
        status=status,
    )


@pytest.mark.parametrize(
    ("direction", "baseline_values", "candidate_values"),
    [
        (MetricDirection.lower_is_better, [10.0] * 12, [8.0] * 12),
        (MetricDirection.higher_is_better, [100.0] * 12, [120.0] * 12),
    ],
)
def test_clear_improvement_handles_both_metric_directions(
    direction: MetricDirection,
    baseline_values: list[float],
    candidate_values: list[float],
) -> None:
    definition = _definition(direction=direction)
    plan = _plan(definition, repetitions=12)
    baseline = _record("0", "a", plan, (baseline_values,))
    candidate = _record("1", "b", plan, (candidate_values,))

    result = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=500,
        analysis_seed=17,
    )

    assert result.status is RecordStatus.completed
    assert result.verdict is Verdict.improved
    assert result.eligible
    assert result.metrics[0].relative_effect == pytest.approx(0.2)
    assert result.metrics[0].ci_lower > 0


def test_clear_regression_and_practical_equivalence() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=10)
    baseline = _record("0", "a", plan, ([10.0] * 10,))
    regression = _record("1", "b", plan, ([12.0] * 10,))
    equivalent = _record("2", "c", plan, ([10.2] * 10,))

    regressed = compare_measurements(
        baseline,
        regression,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=200,
    )
    tied = compare_measurements(
        baseline,
        equivalent,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=200,
    )

    assert regressed.verdict is Verdict.regressed
    assert not regressed.eligible
    assert tied.verdict is Verdict.equivalent
    assert not tied.eligible


def test_wide_noisy_interval_is_inconclusive_not_equivalent() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=20)
    baseline = _record("0", "a", plan, ([10.0] * 20,))
    candidate = _record("1", "b", plan, ([8.0, 12.0] * 10,))

    result = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=2_000,
        analysis_seed=5,
    )

    assert result.status is RecordStatus.completed
    assert result.verdict is Verdict.inconclusive
    assert result.metrics[0].ci_lower < -definition.practical_threshold
    assert result.metrics[0].ci_upper > definition.practical_threshold


def test_bootstrap_is_deterministic_for_fixed_analysis_seed() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=8)
    baseline = _record("0", "a", plan, ([8, 9, 10, 11, 12, 13, 14, 15],))
    candidate = _record("1", "b", plan, ([7, 9, 8, 10, 11, 12, 12, 13],))

    first = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=500,
        analysis_seed=81,
    )
    second = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=500,
        analysis_seed=81,
    )

    assert first.metrics[0].ci_lower == second.metrics[0].ci_lower
    assert first.metrics[0].ci_upper == second.metrics[0].ci_upper
    assert first.confidence == 0.95
    assert first.bootstrap_resamples == 500


def test_caller_can_pin_a_retry_stable_comparison_id() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=3)
    baseline = _record("0", "a", plan, ([10.0] * 3,))
    candidate = _record("1", "b", plan, ([8.0] * 3,))
    comparison_id = "comparison_" + "2" * 26

    result = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=100,
        comparison_id=comparison_id,
    )

    assert result.id == comparison_id


def test_invalid_samples_are_contagious() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=3)
    baseline = _record("0", "a", plan, ([10.0] * 3,))
    invalid = build_metric_sample_set(definition, [0.1, None, 0.1], expected_count=3)
    candidate = MeasurementRecord(
        id="measurement_" + "1" * 26,
        workload=_workload_pin(),
        revision=_revision_pin("b"),
        environment=_environment_pin(),
        plan_digest=canonical_digest(plan),
        metrics=(invalid,),
        status=RecordStatus.inconclusive,
    )

    result = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=100,
    )

    assert result.status is RecordStatus.inconclusive
    assert result.verdict is Verdict.inconclusive
    assert not result.metrics[0].valid
    assert result.metrics[0].relative_effect is None
    assert not result.eligible


def test_mismatched_pins_and_profiled_measurements_fail_closed() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=3)
    baseline = _record("0", "a", plan, ([10.0] * 3,))
    wrong_workload = _record(
        "1", "b", plan, ([8.0] * 3,), workload=_workload_pin(suffix="2")
    )
    profiled_candidate = _record(
        "2",
        "b",
        plan,
        ([8.0] * 3,),
        environment=_environment_pin(profiler=True),
    )

    mismatch = compare_measurements(
        baseline,
        wrong_workload,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=100,
    )
    profiled = compare_measurements(
        _record(
            "3",
            "a",
            plan,
            ([10.0] * 3,),
            environment=_environment_pin(profiler=True),
        ),
        profiled_candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=100,
    )

    assert mismatch.status is RecordStatus.incompatible_environment
    assert mismatch.incompatibilities
    assert not mismatch.eligible
    assert profiled.status is RecordStatus.incompatible_environment
    assert "contains a profiler" in " ".join(profiled.incompatibilities)


def test_explicit_compatibility_relaxation_is_persisted() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=3)
    baseline = _record("0", "a", plan, ([10.0] * 3,))
    candidate = _record(
        "1",
        "b",
        plan,
        ([8.0] * 3,),
        environment=_environment_pin(bakudo_version="3.0.1"),
    )

    result = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=100,
        compatibility_policy=CompatibilityPolicy(allow_bakudo_patch_difference=True),
    )

    assert result.eligible
    assert not result.incompatibilities
    assert "allowed patch difference" in result.allowed_differences[0]


def test_plan_digest_mismatch_is_incompatible() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=3)
    baseline = _record("0", "a", plan, ([10.0] * 3,))
    candidate = _record(
        "1",
        "b",
        plan,
        ([8.0] * 3,),
        plan_digest="sha256:" + "2" * 64,
    )

    result = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=100,
    )

    assert result.status is RecordStatus.incompatible_environment
    assert "plan_digest" in result.incompatibilities[0]
    assert not result.eligible


def test_caller_cannot_lower_threshold_with_an_unpinned_plan() -> None:
    definition = _definition(threshold=0.05)
    plan = _plan(definition, repetitions=3)
    baseline = _record("0", "a", plan, ([10.0] * 3,))
    candidate = _record("1", "b", plan, ([9.8] * 3,))
    lowered_threshold = _plan(
        definition.model_copy(update={"practical_threshold": 0.0}), repetitions=3
    )

    result = compare_measurements(
        baseline,
        candidate,
        lowered_threshold,
        primary_metric=definition.name,
        bootstrap_resamples=100,
    )

    assert result.status is RecordStatus.incompatible_environment
    assert result.verdict is Verdict.inconclusive
    assert not result.eligible


def test_protected_secondary_regression_blocks_eligibility() -> None:
    latency = _definition()
    rss = _definition(name="peak_rss_bytes", unit=MetricUnit.bytes, threshold=0.10)
    plan = _plan(latency, rss, repetitions=10)
    baseline = _record("0", "a", plan, ([10.0] * 10, [100.0] * 10))
    candidate = _record("1", "b", plan, ([8.0] * 10, [130.0] * 10))

    result = compare_measurements(
        baseline,
        candidate,
        plan,
        primary_metric=latency.name,
        protected_metrics=(rss.name,),
        bootstrap_resamples=200,
    )

    assert result.verdict is Verdict.improved
    assert result.metrics[1].verdict is Verdict.regressed
    assert not result.eligible


def test_persisted_summary_or_direction_cannot_be_changed_to_create_a_win() -> None:
    definition = _definition()
    plan = _plan(definition, repetitions=3)
    baseline = _record("0", "a", plan, ([10.0] * 3,))
    candidate = _record("1", "b", plan, ([12.0] * 3,))
    forged_set = candidate.metrics[0].model_copy(
        update={
            "summary": 1.0,
            "direction": MetricDirection.higher_is_better,
        }
    )
    forged = candidate.model_copy(update={"metrics": (forged_set,)})

    result = compare_measurements(
        baseline,
        forged,
        plan,
        primary_metric=definition.name,
        bootstrap_resamples=100,
    )

    assert result.status is RecordStatus.inconclusive
    assert result.verdict is Verdict.inconclusive
    assert "direction" in " ".join(result.metrics[0].reasons)
    assert not result.eligible
