"""Paired-comparison statistics for experiment analysis (experiment substrate
design doc section 8): per-task deltas, a percentile bootstrap confidence
interval, and a tie-zone + cost-tiebreak verdict.

Pure stdlib — no numpy/scipy. Resampling delegates to the shared deterministic
bootstrap primitive so artifact and agent experiments use one recipe.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import fmean

from ..statistics import percentile_bootstrap_ci


@dataclass(frozen=True)
class PairedAnalysis:
    n_tasks: int
    mean_delta: float
    ci_low: float
    ci_high: float
    wins: int
    losses: int
    ties: int
    verdict: str  # "candidate" | "baseline" | "tie"


def task_deltas(
    baseline: Mapping[str, list[float]], candidate: Mapping[str, list[float]]
) -> dict[str, float]:
    """Per-task paired differences (candidate mean - baseline mean), reps
    averaged within task first. Keys are task names; only tasks
    present in both mappings are used."""
    common = sorted(set(baseline) & set(candidate))
    return {name: fmean(candidate[name]) - fmean(baseline[name]) for name in common}


def paired_bootstrap_ci(
    deltas: Sequence[float],
    confidence: float = 0.95,
    resamples: int = 10_000,
    seed: int = 0,
) -> tuple[float, float]:
    """Percentile bootstrap CI over task deltas with ``random.Random(seed)``.

    Resamples task deltas with replacement ``resamples`` times, computes
    each resample's mean, sorts the resample means, and reads the CI off via
    nearest-rank percentile indexing.
    """
    n = len(deltas)
    if n == 0:
        return (0.0, 0.0)
    if n == 1:
        return (deltas[0], deltas[0])

    return percentile_bootstrap_ci(
        deltas,
        statistic=fmean,
        confidence=confidence,
        resamples=resamples,
        seed=seed,
    )


def analyze(
    baseline: Mapping[str, list[float]],
    candidate: Mapping[str, list[float]],
    *,
    tie_zone: float,
    confidence: float = 0.95,
    resamples: int = 10_000,
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
    deltas_by_task = task_deltas(baseline, candidate)
    n_tasks = len(deltas_by_task)

    if n_tasks == 0:
        return PairedAnalysis(0, 0.0, 0.0, 0.0, 0, 0, 0, "tie")

    deltas = list(deltas_by_task.values())
    mean_delta = fmean(deltas)

    if n_tasks == 1:
        ci_low, ci_high = deltas[0], deltas[0]
    else:
        ci_low, ci_high = paired_bootstrap_ci(
            deltas, confidence=confidence, resamples=resamples, seed=seed
        )

    wins = sum(1 for d in deltas if d > win_eps)
    losses = sum(1 for d in deltas if d < -win_eps)
    ties = n_tasks - wins - losses

    is_tie = abs(mean_delta) < tie_zone or (ci_low <= 0 <= ci_high)
    if is_tie:
        if cost_tiebreak and cost_delta is not None and cost_delta < 0:
            verdict = "candidate"
        else:
            verdict = "tie"
    else:
        verdict = "candidate" if mean_delta > 0 else "baseline"

    return PairedAnalysis(
        n_tasks=n_tasks,
        mean_delta=mean_delta,
        ci_low=ci_low,
        ci_high=ci_high,
        wins=wins,
        losses=losses,
        ties=ties,
        verdict=verdict,
    )
