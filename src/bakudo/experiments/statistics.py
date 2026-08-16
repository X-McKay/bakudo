"""Paired-comparison statistics for experiment analysis (experiment substrate
design doc section 8): per-scenario deltas, a percentile bootstrap confidence
interval, and a tie-zone + cost-tiebreak verdict.

Pure stdlib — no numpy/scipy, and no bakudo imports. This is the one module
in the codebase where an explicit-seed ``random.Random(seed)`` is allowed,
since the bootstrap needs a reproducible resampling draw rather than
:func:`bakudo.experiments.design.trial_seed`'s hash-derived determinism.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import fmean


@dataclass(frozen=True)
class PairedAnalysis:
    n_scenarios: int
    mean_delta: float
    ci_low: float
    ci_high: float
    wins: int
    losses: int
    ties: int
    verdict: str  # "candidate" | "baseline" | "tie"


def scenario_deltas(
    baseline: Mapping[str, list[float]], candidate: Mapping[str, list[float]]
) -> dict[str, float]:
    """Per-scenario paired differences (candidate mean - baseline mean), reps
    averaged within scenario first. Keys are scenario names; only scenarios
    present in both mappings are used."""
    common = sorted(set(baseline) & set(candidate))
    return {name: fmean(candidate[name]) - fmean(baseline[name]) for name in common}


def paired_bootstrap_ci(
    deltas: Sequence[float],
    confidence: float = 0.95,
    resamples: int = 10_000,
    seed: int = 0,
) -> tuple[float, float]:
    """Percentile bootstrap CI over scenario deltas with ``random.Random(seed)``.

    Resamples scenario deltas with replacement ``resamples`` times, computes
    each resample's mean, sorts the resample means, and reads the CI off via
    nearest-rank percentile indexing.
    """
    n = len(deltas)
    if n == 0:
        return (0.0, 0.0)
    if n == 1:
        return (deltas[0], deltas[0])

    rng = random.Random(seed)
    means = []
    for _ in range(resamples):
        sample = [deltas[rng.randrange(n)] for _ in range(n)]
        means.append(fmean(sample))
    means.sort()

    alpha = (1 - confidence) / 2
    lo_idx = min(int(alpha * resamples), resamples - 1)
    hi_idx = min(int((1 - alpha) * resamples), resamples - 1)
    return (means[lo_idx], means[hi_idx])


def analyze(
    baseline: Mapping[str, list[float]],
    candidate: Mapping[str, list[float]],
    *,
    tie_zone: float,
    confidence: float = 0.95,
    seed: int = 0,
    cost_delta: float | None = None,
    cost_tiebreak: bool = True,
    win_eps: float = 1e-9,
) -> PairedAnalysis:
    """Full paired analysis: deltas, bootstrap CI, win/loss/tie counts, and a
    verdict.

    Verdict is "tie" if ``|mean_delta| < tie_zone`` or the CI spans 0
    (``ci_low <= 0 <= ci_high``); otherwise "candidate" if ``mean_delta > 0``
    else "baseline". A "tie" verdict flips to "candidate" only when
    ``cost_tiebreak`` is set, ``cost_delta`` is not None, and
    ``cost_delta < 0`` (a cheaper candidate wins ties); a tie with
    ``cost_delta >= 0`` stays "tie".
    """
    deltas_by_scenario = scenario_deltas(baseline, candidate)
    n_scenarios = len(deltas_by_scenario)

    if n_scenarios == 0:
        return PairedAnalysis(0, 0.0, 0.0, 0.0, 0, 0, 0, "tie")

    deltas = list(deltas_by_scenario.values())
    mean_delta = fmean(deltas)

    if n_scenarios == 1:
        ci_low, ci_high = deltas[0], deltas[0]
    else:
        ci_low, ci_high = paired_bootstrap_ci(
            deltas, confidence=confidence, seed=seed
        )

    wins = sum(1 for d in deltas if d > win_eps)
    losses = sum(1 for d in deltas if d < -win_eps)
    ties = n_scenarios - wins - losses

    is_tie = abs(mean_delta) < tie_zone or (ci_low <= 0 <= ci_high)
    if is_tie:
        if cost_tiebreak and cost_delta is not None and cost_delta < 0:
            verdict = "candidate"
        else:
            verdict = "tie"
    else:
        verdict = "candidate" if mean_delta > 0 else "baseline"

    return PairedAnalysis(
        n_scenarios=n_scenarios,
        mean_delta=mean_delta,
        ci_low=ci_low,
        ci_high=ci_high,
        wins=wins,
        losses=losses,
        ties=ties,
        verdict=verdict,
    )
