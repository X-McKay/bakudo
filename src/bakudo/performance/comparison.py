"""Trusted comparison of paired, uninstrumented measurement records."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence

from .compatibility import CompatibilityPolicy, compare_measurement_pins
from .models import (
    IntegrityResult,
    MeasurementPlan,
    MeasurementRecord,
    MetricComparison,
    MetricDefinition,
    MetricSampleSet,
    PerformanceComparison,
    RecordStatus,
    Verdict,
    canonical_digest,
)
from .statistics import (
    DEFAULT_BOOTSTRAP_RESAMPLES,
    StatisticalInputError,
    classify_effect,
    dispersion,
    estimate,
    paired_effect_ci,
)


def _metric_seed(analysis_seed: int, metric_name: str) -> int:
    digest = hashlib.sha256(f"{analysis_seed}:{metric_name}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


def _invalid_metric_comparison(
    definition: MetricDefinition,
    *,
    baseline: MetricSampleSet | None,
    candidate: MetricSampleSet | None,
    reasons: Sequence[str],
) -> MetricComparison:
    return MetricComparison(
        metric_name=definition.name,
        unit=definition.unit,
        direction=definition.direction,
        estimator=definition.estimator,
        baseline_summary=None,
        candidate_summary=None,
        absolute_effect=None,
        relative_effect=None,
        ci_lower=None,
        ci_upper=None,
        practical_threshold=definition.practical_threshold,
        sample_count=min(
            len(baseline.samples) if baseline is not None else 0,
            len(candidate.samples) if candidate is not None else 0,
        ),
        baseline_dispersion=None,
        candidate_dispersion=None,
        verdict=Verdict.inconclusive,
        valid=False,
        reasons=tuple(dict.fromkeys(reasons)),
    )


def _metadata_reasons(
    side: str,
    sample_set: MetricSampleSet,
    definition: MetricDefinition,
) -> list[str]:
    reasons: list[str] = []
    expected = {
        "unit": definition.unit,
        "direction": definition.direction,
        "estimator": definition.estimator,
    }
    for field, expected_value in expected.items():
        actual = getattr(sample_set, field)
        if actual != expected_value:
            reasons.append(
                f"{side} {field} {getattr(actual, 'value', actual)!r} does not match "
                f"plan {getattr(expected_value, 'value', expected_value)!r}"
            )
    if not sample_set.valid:
        reasons.append(f"{side} sample set is invalid")
        reasons.extend(f"{side}: {reason}" for reason in sample_set.invalid_reasons)
    if sample_set.invalid_sample_count:
        reasons.append(f"{side} has {sample_set.invalid_sample_count} invalid or missing samples")
    if sample_set.invalid_reasons and sample_set.valid:
        reasons.append(f"{side} valid sample set contains invalid reasons")
    return reasons


def compare_metric_samples(
    definition: MetricDefinition,
    baseline: MetricSampleSet | None,
    candidate: MetricSampleSet | None,
    *,
    expected_count: int,
    confidence: float,
    bootstrap_resamples: int,
    analysis_seed: int,
) -> MetricComparison:
    """Compare one declared metric, recomputing every statistic from raw samples."""

    reasons: list[str] = []
    if baseline is None:
        reasons.append("baseline metric is missing")
    if candidate is None:
        reasons.append("candidate metric is missing")
    if baseline is None or candidate is None:
        return _invalid_metric_comparison(
            definition, baseline=baseline, candidate=candidate, reasons=reasons
        )

    reasons.extend(_metadata_reasons("baseline", baseline, definition))
    reasons.extend(_metadata_reasons("candidate", candidate, definition))
    if len(baseline.samples) != expected_count:
        reasons.append(
            f"baseline expected {expected_count} samples, received {len(baseline.samples)}"
        )
    if len(candidate.samples) != expected_count:
        reasons.append(
            f"candidate expected {expected_count} samples, received {len(candidate.samples)}"
        )
    if len(baseline.samples) != len(candidate.samples):
        reasons.append("paired metrics have different sample counts")
    if reasons:
        return _invalid_metric_comparison(
            definition, baseline=baseline, candidate=candidate, reasons=reasons
        )

    try:
        baseline_summary = estimate(baseline.samples, definition.estimator)
        candidate_summary = estimate(candidate.samples, definition.estimator)
        baseline_dispersion = dispersion(baseline.samples, definition.estimator)
        candidate_dispersion = dispersion(candidate.samples, definition.estimator)
        # Persisted summaries are a convenience, not a trusted analysis input.
        # Refuse the record if they disagree with recomputation.
        if baseline.summary is None or not math.isclose(
            baseline.summary, baseline_summary, rel_tol=1e-12, abs_tol=1e-12
        ):
            reasons.append("baseline persisted summary does not match raw samples")
        if candidate.summary is None or not math.isclose(
            candidate.summary, candidate_summary, rel_tol=1e-12, abs_tol=1e-12
        ):
            reasons.append("candidate persisted summary does not match raw samples")
        if baseline.dispersion is None or not math.isclose(
            baseline.dispersion, baseline_dispersion, rel_tol=1e-12, abs_tol=1e-12
        ):
            reasons.append("baseline persisted dispersion does not match raw samples")
        if candidate.dispersion is None or not math.isclose(
            candidate.dispersion, candidate_dispersion, rel_tol=1e-12, abs_tol=1e-12
        ):
            reasons.append("candidate persisted dispersion does not match raw samples")
        if reasons:
            return _invalid_metric_comparison(
                definition, baseline=baseline, candidate=candidate, reasons=reasons
            )

        effect = paired_effect_ci(
            baseline.samples,
            candidate.samples,
            direction=definition.direction,
            estimator=definition.estimator,
            confidence=confidence,
            resamples=bootstrap_resamples,
            seed=_metric_seed(analysis_seed, definition.name),
        )
        verdict = Verdict(
            classify_effect(
                effect.relative_effect,
                effect.ci_lower,
                effect.ci_upper,
                practical_threshold=definition.practical_threshold,
            )
        )
    except StatisticalInputError as exc:
        return _invalid_metric_comparison(
            definition,
            baseline=baseline,
            candidate=candidate,
            reasons=(str(exc),),
        )

    return MetricComparison(
        metric_name=definition.name,
        unit=definition.unit,
        direction=definition.direction,
        estimator=definition.estimator,
        baseline_summary=effect.baseline_summary,
        candidate_summary=effect.candidate_summary,
        absolute_effect=effect.absolute_effect,
        relative_effect=effect.relative_effect,
        ci_lower=effect.ci_lower,
        ci_upper=effect.ci_upper,
        practical_threshold=definition.practical_threshold,
        sample_count=len(baseline.samples),
        baseline_dispersion=baseline_dispersion,
        candidate_dispersion=candidate_dispersion,
        verdict=verdict,
        valid=True,
    )


def _combined_integrity(
    baseline: MeasurementRecord,
    candidate: MeasurementRecord,
    required: IntegrityResult | None,
) -> IntegrityResult:
    violations: list[str] = []
    details: dict[str, str] = {}
    for prefix, integrity in (
        ("baseline", baseline.integrity),
        ("candidate", candidate.integrity),
        ("required", required),
    ):
        if integrity is None:
            continue
        violations.extend(f"{prefix}: {violation}" for violation in integrity.violations)
        details.update({f"{prefix}.{key}": value for key, value in integrity.details.items()})
    return IntegrityResult(valid=not violations, violations=tuple(violations), details=details)


def _comparison_incompatibilities(
    baseline: MeasurementRecord,
    candidate: MeasurementRecord,
    plan: MeasurementPlan,
    compatibility_policy: CompatibilityPolicy | None,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    report = compare_measurement_pins(baseline, candidate, compatibility_policy)
    reasons = list(report.mismatches)
    expected_plan_digest = canonical_digest(plan)
    if baseline.plan_digest != expected_plan_digest:
        reasons.append(
            f"baseline.plan_digest: {baseline.plan_digest!r} != "
            f"provided plan {expected_plan_digest!r}"
        )
    if candidate.plan_digest != expected_plan_digest:
        reasons.append(
            f"candidate.plan_digest: {candidate.plan_digest!r} != "
            f"provided plan {expected_plan_digest!r}"
        )
    if baseline.revision.repository != candidate.revision.repository:
        reasons.append(
            f"revision.repository: {baseline.revision.repository!r} != "
            f"{candidate.revision.repository!r}"
        )
    if baseline.revision.source_uri != candidate.revision.source_uri:
        reasons.append(
            f"revision.source_uri: {baseline.revision.source_uri!r} != "
            f"{candidate.revision.source_uri!r}"
        )
    if baseline.revision.dirty:
        reasons.append("baseline revision is dirty")
    if candidate.revision.dirty and candidate.revision.patch_digest is None:
        reasons.append("dirty candidate revision has no pinned patch digest")
    if baseline.environment.profiler_adapter is not None:
        reasons.append("baseline measurement environment contains a profiler")
    if candidate.environment.profiler_adapter is not None:
        reasons.append("candidate measurement environment contains a profiler")
    return tuple(dict.fromkeys(reasons)), report.allowed_differences


def compare_measurements(
    baseline: MeasurementRecord,
    candidate: MeasurementRecord,
    plan: MeasurementPlan,
    *,
    primary_metric: str,
    protected_metrics: Sequence[str] = (),
    confidence: float = 0.95,
    bootstrap_resamples: int = DEFAULT_BOOTSTRAP_RESAMPLES,
    analysis_seed: int = 0,
    compatibility_policy: CompatibilityPolicy | None = None,
    required_integrity: IntegrityResult | None = None,
    comparison_id: str | None = None,
) -> PerformanceComparison:
    """Produce a fail-closed comparison from paired measurement records."""

    if not 0 < confidence < 1:
        raise ValueError("confidence must be between 0 and 1")
    if not 1 <= bootstrap_resamples <= 1_000_000:
        raise ValueError("bootstrap_resamples must be between 1 and 1000000")

    definitions = {definition.name: definition for definition in plan.metrics}
    if primary_metric not in definitions:
        raise ValueError(f"primary metric {primary_metric!r} is not declared by the plan")
    if len(protected_metrics) != len(set(protected_metrics)):
        raise ValueError("protected_metrics must not contain duplicates")
    unknown_protected = sorted(set(protected_metrics) - set(definitions))
    if unknown_protected:
        raise ValueError(f"protected metrics are not declared: {', '.join(unknown_protected)}")

    baseline_metrics = {sample.metric_name: sample for sample in baseline.metrics}
    candidate_metrics = {sample.metric_name: sample for sample in candidate.metrics}
    comparisons = tuple(
        compare_metric_samples(
            definition,
            baseline_metrics.get(definition.name),
            candidate_metrics.get(definition.name),
            expected_count=plan.repetitions,
            confidence=confidence,
            bootstrap_resamples=bootstrap_resamples,
            analysis_seed=analysis_seed,
        )
        for definition in plan.metrics
    )
    comparisons_by_name = {metric.metric_name: metric for metric in comparisons}

    incompatibilities, allowed_differences = _comparison_incompatibilities(
        baseline, candidate, plan, compatibility_policy
    )
    required_names = {definition.name for definition in plan.metrics if definition.required} | {
        primary_metric,
        *protected_metrics,
    }
    required_evidence_invalid = any(not comparisons_by_name[name].valid for name in required_names)
    records_incomplete = (
        baseline.status is not RecordStatus.completed
        or candidate.status is not RecordStatus.completed
    )

    if incompatibilities:
        status = RecordStatus.incompatible_environment
    elif required_evidence_invalid or records_incomplete:
        status = RecordStatus.inconclusive
    else:
        status = RecordStatus.completed

    primary = comparisons_by_name[primary_metric]
    verdict = primary.verdict if status is RecordStatus.completed else Verdict.inconclusive
    integrity = _combined_integrity(baseline, candidate, required_integrity)
    protected_ok = all(
        comparisons_by_name[name].valid
        and comparisons_by_name[name].verdict is not Verdict.regressed
        for name in protected_metrics
    )
    eligible = (
        status is RecordStatus.completed
        and verdict is Verdict.improved
        and protected_ok
        and integrity.valid
        and not incompatibilities
    )
    comparison_values = dict(
        workload=baseline.workload,
        baseline_revision=baseline.revision,
        candidate_revision=candidate.revision,
        baseline_environment=baseline.environment,
        candidate_environment=candidate.environment,
        baseline_measurement_id=baseline.id,
        candidate_measurement_id=candidate.id,
        primary_metric=primary_metric,
        metrics=comparisons,
        status=status,
        verdict=verdict,
        integrity=integrity,
        eligible=eligible,
        incompatibilities=incompatibilities,
        allowed_differences=allowed_differences,
        analysis_seed=analysis_seed,
        confidence=confidence,
        bootstrap_resamples=bootstrap_resamples,
    )
    if comparison_id is not None:
        comparison_values["id"] = comparison_id
    return PerformanceComparison.model_validate(comparison_values)
