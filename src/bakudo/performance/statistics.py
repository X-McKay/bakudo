"""Pure statistical primitives for uninstrumented performance evidence.

Positive relative effects always mean that the candidate is better, regardless
of a metric's declared direction.  Bootstrap resampling keeps baseline and
candidate observations paired so placement drift cannot be erased by analysis.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from statistics import fmean, median, pstdev
from typing import Any

from ..statistics import paired_percentile_bootstrap_ci

DEFAULT_BOOTSTRAP_RESAMPLES = 10_000
MIN_P95_SAMPLES = 20
MIN_P99_SAMPLES = 100


class StatisticalInputError(ValueError):
    """Raised when samples cannot support the requested analysis."""


@dataclass(frozen=True)
class EffectEstimate:
    """Point estimate and confidence interval for a paired candidate effect.

    ``absolute_effect`` retains the raw ``candidate - baseline`` sign and unit.
    ``relative_effect`` and its interval are direction-normalized fractions, so
    positive values consistently represent improvement.
    """

    baseline_summary: float
    candidate_summary: float
    absolute_effect: float
    relative_effect: float
    ci_lower: float
    ci_upper: float


def _enum_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw)


def validate_numeric_samples(
    samples: Sequence[float], *, expected_count: int | None = None
) -> None:
    """Reject empty, incomplete, boolean, and non-finite sample sequences."""

    if not samples:
        raise StatisticalInputError("at least one sample is required")
    if expected_count is not None and len(samples) != expected_count:
        raise StatisticalInputError(
            f"expected exactly {expected_count} samples, received {len(samples)}"
        )
    for index, sample in enumerate(samples):
        if isinstance(sample, bool) or not isinstance(sample, (int, float)):
            raise StatisticalInputError(f"sample {index} is not numeric")
        if not math.isfinite(float(sample)):
            raise StatisticalInputError(f"sample {index} is not finite")


def required_samples(estimator: Any) -> int:
    """Return the minimum defensible count for an estimator.

    Tail percentiles require at least one expected observation in their tail.
    This is a minimal validity floor, not a claim that every workload has
    reached a stable tail estimate.
    """

    name = _enum_value(estimator)
    if name == "p95":
        return MIN_P95_SAMPLES
    if name == "p99":
        return MIN_P99_SAMPLES
    if name in {"median", "mean"}:
        return 1
    raise StatisticalInputError(f"unsupported estimator: {name}")


def estimate(samples: Sequence[float], estimator: Any) -> float:
    """Calculate a declared estimator after enforcing sample sufficiency."""

    validate_numeric_samples(samples)
    name = _enum_value(estimator)
    minimum = required_samples(name)
    if len(samples) < minimum:
        raise StatisticalInputError(
            f"{name} requires at least {minimum} samples, received {len(samples)}"
        )

    values = [float(sample) for sample in samples]
    if name == "mean":
        return fmean(values)
    if name == "median":
        return float(median(values))
    percentile = 0.95 if name == "p95" else 0.99
    ordered = sorted(values)
    # Nearest-rank percentile.  The sufficiency floor above ensures the tail
    # is represented by at least one observed value.
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def dispersion(samples: Sequence[float], estimator: Any) -> float:
    """Return population SD for means and median absolute deviation otherwise."""

    validate_numeric_samples(samples)
    values = [float(sample) for sample in samples]
    if len(values) == 1:
        return 0.0
    if _enum_value(estimator) == "mean":
        return float(pstdev(values))
    center = float(median(values))
    return float(median(abs(value - center) for value in values))


def _relative_effect(
    baseline_summary: float,
    candidate_summary: float,
    direction: Any,
) -> float:
    if baseline_summary == 0:
        raise StatisticalInputError("relative effect is undefined for a zero baseline summary")
    raw_fraction = (candidate_summary - baseline_summary) / abs(baseline_summary)
    name = _enum_value(direction)
    if name == "higher":
        return raw_fraction
    if name == "lower":
        return -raw_fraction
    raise StatisticalInputError(f"unsupported metric direction: {name}")


def paired_effect_ci(
    baseline: Sequence[float],
    candidate: Sequence[float],
    *,
    direction: Any,
    estimator: Any,
    confidence: float = 0.95,
    resamples: int = DEFAULT_BOOTSTRAP_RESAMPLES,
    seed: int = 0,
) -> EffectEstimate:
    """Calculate a paired, direction-normalized percentile-bootstrap effect."""

    validate_numeric_samples(baseline)
    validate_numeric_samples(candidate)
    if len(baseline) != len(candidate):
        raise StatisticalInputError(
            "paired analysis requires equal baseline and candidate sample counts"
        )
    if not 0 < confidence < 1:
        raise StatisticalInputError("confidence must be between 0 and 1")
    if resamples < 1:
        raise StatisticalInputError("resamples must be at least 1")

    baseline_values = [float(sample) for sample in baseline]
    candidate_values = [float(sample) for sample in candidate]
    baseline_summary = estimate(baseline_values, estimator)
    candidate_summary = estimate(candidate_values, estimator)
    relative_effect = _relative_effect(baseline_summary, candidate_summary, direction)

    try:
        ci_lower, ci_upper = paired_percentile_bootstrap_ci(
            baseline_values,
            candidate_values,
            effect=lambda baseline_sample, candidate_sample: _relative_effect(
                estimate(baseline_sample, estimator),
                estimate(candidate_sample, estimator),
                direction,
            ),
            confidence=confidence,
            resamples=resamples,
            seed=seed,
        )
    except ValueError as exc:
        raise StatisticalInputError(str(exc)) from exc

    return EffectEstimate(
        baseline_summary=baseline_summary,
        candidate_summary=candidate_summary,
        absolute_effect=candidate_summary - baseline_summary,
        relative_effect=relative_effect,
        ci_lower=ci_lower,
        ci_upper=ci_upper,
    )


def classify_effect(
    relative_effect: float,
    ci_lower: float,
    ci_upper: float,
    *,
    practical_threshold: float,
) -> str:
    """Classify an effect using both confidence and a practical tie band."""

    values = (relative_effect, ci_lower, ci_upper, practical_threshold)
    if any(not math.isfinite(value) for value in values):
        raise StatisticalInputError("effect inputs must be finite")
    if practical_threshold < 0:
        raise StatisticalInputError("practical_threshold must not be negative")
    if ci_lower > ci_upper:
        raise StatisticalInputError("ci_lower must not exceed ci_upper")

    if relative_effect >= practical_threshold and ci_lower > 0:
        return "improved"
    if relative_effect <= -practical_threshold and ci_upper < 0:
        return "regressed"
    if ci_lower >= -practical_threshold and ci_upper <= practical_threshold:
        return "equivalent"
    return "inconclusive"
