"""Generic deterministic percentile-bootstrap primitives.

Domain modules define the statistic/effect they need; this module owns the
single resampling recipe so agent and software-artifact experiments do not
quietly diverge.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence


def _validate_bootstrap(confidence: float, resamples: int) -> None:
    if not 0 < confidence < 1:
        raise ValueError("confidence must be between 0 and 1")
    if resamples < 1:
        raise ValueError("resamples must be at least 1")


def _percentile_bounds(
    values: list[float],
    *,
    confidence: float,
    resamples: int,
) -> tuple[float, float]:
    values.sort()
    alpha = (1 - confidence) / 2
    lower_index = min(int(alpha * resamples), resamples - 1)
    upper_index = min(int((1 - alpha) * resamples), resamples - 1)
    return values[lower_index], values[upper_index]


def percentile_bootstrap_ci(
    values: Sequence[float],
    *,
    statistic: Callable[[Sequence[float]], float],
    confidence: float = 0.95,
    resamples: int = 10_000,
    seed: int = 0,
) -> tuple[float, float]:
    """Bootstrap a statistic over one non-empty sample sequence."""

    _validate_bootstrap(confidence, resamples)
    if not values:
        raise ValueError("values must not be empty")
    if len(values) == 1:
        point = statistic(values)
        return point, point

    rng = random.Random(seed)
    estimates = [
        statistic([values[rng.randrange(len(values))] for _ in values]) for _ in range(resamples)
    ]
    return _percentile_bounds(estimates, confidence=confidence, resamples=resamples)


def paired_percentile_bootstrap_ci(
    baseline: Sequence[float],
    candidate: Sequence[float],
    *,
    effect: Callable[[Sequence[float], Sequence[float]], float],
    confidence: float = 0.95,
    resamples: int = 10_000,
    seed: int = 0,
) -> tuple[float, float]:
    """Bootstrap an effect while resampling paired observations together."""

    _validate_bootstrap(confidence, resamples)
    if not baseline or not candidate:
        raise ValueError("paired samples must not be empty")
    if len(baseline) != len(candidate):
        raise ValueError("paired samples must have equal lengths")
    if len(baseline) == 1:
        point = effect(baseline, candidate)
        return point, point

    rng = random.Random(seed)
    estimates: list[float] = []
    for _ in range(resamples):
        indexes = [rng.randrange(len(baseline)) for _ in baseline]
        baseline_sample = [baseline[index] for index in indexes]
        candidate_sample = [candidate[index] for index in indexes]
        estimates.append(effect(baseline_sample, candidate_sample))
    return _percentile_bounds(estimates, confidence=confidence, resamples=resamples)
