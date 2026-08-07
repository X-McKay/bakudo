"""Benchmark: sanctions screening (list membership in the hot loop)."""

from src.compliance.screening import screen_names


def test_bench_screening():
    names = [f"party-{i}" for i in range(3000)] + ["blocked-party-0042"]
    hits = screen_names(names)
    assert hits == ["blocked-party-0042"]
