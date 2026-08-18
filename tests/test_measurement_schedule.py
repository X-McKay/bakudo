from __future__ import annotations

from dataclasses import dataclass

import pytest

from bakudo.performance.measurement import (
    ComparisonSide,
    MeasurementPhase,
    build_comparison_schedule,
)


@dataclass(frozen=True)
class _Plan:
    warmups: int
    repetitions: int
    schedule: str


def _placements(plan: _Plan, seed: int = 0) -> list[tuple[str, str, int]]:
    return [
        (item.phase.value, item.side.value, item.pair_index)
        for item in build_comparison_schedule(plan, seed=seed)  # type: ignore[arg-type]
    ]


def test_fixed_schedule_keeps_warmups_separate_and_ordered() -> None:
    assert _placements(_Plan(warmups=1, repetitions=2, schedule="fixed")) == [
        ("warmup", "baseline", 0),
        ("warmup", "candidate", 0),
        ("measured", "baseline", 0),
        ("measured", "candidate", 0),
        ("measured", "baseline", 1),
        ("measured", "candidate", 1),
    ]


def test_abba_schedule_balances_two_pair_blocks() -> None:
    schedule = build_comparison_schedule(
        _Plan(warmups=0, repetitions=5, schedule="abba"),  # type: ignore[arg-type]
        seed=99,
    )

    assert [(item.side, item.pair_index) for item in schedule] == [
        (ComparisonSide.baseline, 0),
        (ComparisonSide.candidate, 0),
        (ComparisonSide.candidate, 1),
        (ComparisonSide.baseline, 1),
        (ComparisonSide.baseline, 2),
        (ComparisonSide.candidate, 2),
        (ComparisonSide.candidate, 3),
        (ComparisonSide.baseline, 3),
        (ComparisonSide.baseline, 4),
        (ComparisonSide.candidate, 4),
    ]


def test_randomized_pairs_are_deterministic_and_balanced() -> None:
    plan = _Plan(warmups=2, repetitions=20, schedule="randomized-pairs")

    first = build_comparison_schedule(plan, seed=617)  # type: ignore[arg-type]
    second = build_comparison_schedule(plan, seed=617)  # type: ignore[arg-type]
    different = build_comparison_schedule(plan, seed=618)  # type: ignore[arg-type]

    assert first == second
    assert first != different
    assert [item.ordinal for item in first] == list(range(44))
    measured = [item for item in first if item.phase is MeasurementPhase.measured]
    assert sum(item.side is ComparisonSide.baseline for item in measured) == 20
    assert sum(item.side is ComparisonSide.candidate for item in measured) == 20
    for pair_index in range(20):
        assert {item.side for item in measured if item.pair_index == pair_index} == {
            ComparisonSide.baseline,
            ComparisonSide.candidate,
        }


def test_unknown_schedule_fails_closed() -> None:
    with pytest.raises(ValueError, match="unsupported measurement schedule"):
        build_comparison_schedule(  # type: ignore[arg-type]
            _Plan(warmups=0, repetitions=1, schedule="surprise"), seed=0
        )
