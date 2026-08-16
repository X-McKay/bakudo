"""Statistics module tests (Task 9): scenario-level paired deltas, percentile
bootstrap CI, and the tie-zone/cost-tiebreak verdict logic in ``analyze``.

Pure stdlib module under test — no numpy/scipy, and no bakudo imports.
"""

from __future__ import annotations

import random

import pytest

from bakudo.experiments.statistics import (
    PairedAnalysis,
    analyze,
    paired_bootstrap_ci,
    scenario_deltas,
)


def test_deltas_average_reps_first():
    d = scenario_deltas({"a": [0.0, 1.0]}, {"a": [1.0, 1.0]})
    assert d == {"a": 0.5}


def test_bootstrap_deterministic_and_sane():
    deltas = [0.1] * 30
    lo, hi = paired_bootstrap_ci(deltas, seed=1)
    assert lo == pytest.approx(0.1) and hi == pytest.approx(0.1)
    assert paired_bootstrap_ci(deltas, seed=1) == paired_bootstrap_ci(deltas, seed=1)


def test_bootstrap_coverage_known_effect():
    # deltas drawn once (fixed literal list) from N(0.2, 0.1), n=40.
    rng = random.Random(42)
    deltas = [rng.gauss(0.2, 0.1) for _ in range(40)]
    lo, hi = paired_bootstrap_ci(deltas, seed=2)
    assert lo > 0 or hi < 0  # CI excludes 0


def test_zero_effect_is_tie():
    baseline = {f"s{i}": [0.5] for i in range(10)}
    candidate = {
        f"s{i}": [0.55 if i % 2 == 0 else 0.45] for i in range(10)
    }
    result = analyze(baseline, candidate, tie_zone=0.10)
    assert result.verdict == "tie"


def test_tie_resolves_to_cheaper_candidate():
    base = {f"s{i}": [0.5, 0.5] for i in range(10)}
    cand_same = {f"s{i}": [0.5, 0.5] for i in range(10)}
    a = analyze(base, cand_same, tie_zone=0.10, cost_delta=-0.2)
    assert a.verdict == "candidate"


def test_tie_stays_tie_when_cost_not_cheaper():
    base = {f"s{i}": [0.5, 0.5] for i in range(10)}
    cand_same = {f"s{i}": [0.5, 0.5] for i in range(10)}
    a = analyze(base, cand_same, tie_zone=0.10, cost_delta=0.2)
    assert a.verdict == "tie"


def test_big_effect_wins_regardless_of_cost():
    baseline = {f"s{i}": [0.0] for i in range(30)}
    candidate = {f"s{i}": [0.3] for i in range(30)}
    a = analyze(baseline, candidate, tie_zone=0.05, cost_delta=0.5)
    assert a.mean_delta == pytest.approx(0.3)
    assert not (a.ci_low <= 0 <= a.ci_high)
    assert a.verdict == "candidate"


def test_mismatched_scenarios_ignored():
    baseline = {"a": [0.0], "b": [0.0]}
    candidate = {"a": [1.0]}
    d = scenario_deltas(baseline, candidate)
    assert d == {"a": 1.0}
    a = analyze(baseline, candidate, tie_zone=0.01)
    assert a.n_scenarios == 1


def test_zero_scenarios_returns_degenerate_tie():
    a = analyze({}, {}, tie_zone=0.1)
    assert a == PairedAnalysis(0, 0.0, 0.0, 0.0, 0, 0, 0, "tie")


def test_single_scenario_ci_is_delta_delta():
    baseline = {"a": [0.0]}
    candidate = {"a": [1.0]}
    a = analyze(baseline, candidate, tie_zone=0.01)
    assert a.ci_low == pytest.approx(1.0)
    assert a.ci_high == pytest.approx(1.0)


def test_wins_losses_ties_counted_per_scenario():
    baseline = {"a": [0.0], "b": [0.0], "c": [0.0]}
    candidate = {"a": [1.0], "b": [-1.0], "c": [0.0]}
    d = scenario_deltas(baseline, candidate)
    assert d == {"a": 1.0, "b": -1.0, "c": 0.0}
    a = analyze(baseline, candidate, tie_zone=0.0)
    assert a.wins == 1
    assert a.losses == 1
    assert a.ties == 1
